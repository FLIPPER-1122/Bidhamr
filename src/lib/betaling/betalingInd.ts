// Server-only: betalingsmodel trin 2 "betaling ind" - betalinger, der venter
// på sælgerens Stripe-konto (docs/BETALINGSMODEL-PLAN.md afsnit 6.2,
// ROADMAP-BESLUTNINGER.md "Ny betalingsmodel – Filips svar").
//
// Med destination (databasens stripe_tilstand.betalingsmodel) oprettes en
// betaling som "venter", hvis sælgerens Connect-konto ikke kan tage imod
// betaling, når auktionen slutter (trigger i 20261011020000). Så:
//   - køberen får "du vandt - betalingen åbner, når sælgerens konto er
//     godkendt"; sælgeren "gør kontoen færdig" (cron trin 2, cron.ts)
//   - sælgeren påmindes efter 3 dage (paamindVentendeSaelgere)
//   - kontoen tjekkes frisk hos Stripe (opdaterVentendeSaelgerkonti), og
//     account.updated åbner betalingen (aabnVentende): 48-timersfristen
//     starter nu, autobetaling forsøges, og køberen får "nu kan du betale"
//     (notificerAabnede)
//   - er kontoen ikke godkendt 7 dage efter auktionens slutning, annulleres
//     handlen og auktionen (køberen trækkes ikke), og sælgeren fryses, til
//     Stripe har godkendt kontoen (annullerIkkeGodkendte)
// Med separat findes der ingen ventende betalinger (alt herinde er no-ops).
// Kaster aldrig fra cron-funktionerne (fejl logges i drift_fejl).

import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { logDriftFejl } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import {
  koeberAnnulleretSaelgerkontoMail,
  koeberAutobetaltMail,
  koeberBetalingAabnetMail,
  saelgerAnnulleretSaelgerkontoMail,
  saelgerKontoIkkeKlarMail,
} from "@/lib/mails/handel";
import {
  type BetalingRaekke,
  forsoegAutobetaling,
  spejlConnectKonto,
  markerKontoUdenAdgang,
  spejlPaymentIntent,
} from "@/lib/betaling/stripeBetaling";

const DAG = 24 * 60 * 60 * 1000;

// Migrationen 20261011020000 er ikke kørt endnu (fx produktion): intet at gøre.
function mangler(err: { code?: string; message?: string } | null): boolean {
  return !!err && ["42703", "PGRST204", "PGRST202", "42883"].includes(err.code ?? "");
}

async function fejl(hvor: string, err: unknown) {
  console.error(`${hvor} fejlede:`, err);
  await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor, fejl: err });
}

async function titler(auktionIds: string[]): Promise<Map<string, string>> {
  if (!auktionIds.length) return new Map();
  const { data } = await createAdminClient()
    .from("auctions")
    .select("id, titel")
    .in("id", [...new Set(auktionIds)]);
  return new Map((data ?? []).map((a) => [a.id as string, a.titel as string]));
}

// Åbner ventende betalinger for en sælger (eller alle), hvis kontoen nu kan
// tage imod betaling (spejlet i databasen), og ophæver en frysning. Sender
// derefter "nu kan du betale". Returnerer antal åbnede.
export async function aabnVentende(saelgerId?: string): Promise<number> {
  const { data, error } = await createAdminClient().rpc("betaling_aabn_ventende", {
    p_saelger: saelgerId ?? null,
  });
  if (mangler(error)) return 0;
  if (error) throw new Error(`betaling_aabn_ventende: ${error.message}`);
  const antal = Array.isArray(data) ? data.length : 0;
  if (antal > 0) await notificerAabnede();
  return antal;
}

// Åbnede betalinger, hvor køberen ikke har fået besked: autobetaling (hvis
// slået til) og derefter "nu kan du betale" / "du har betalt".
export async function notificerAabnede(): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("betalinger")
    .select("*")
    .not("betaling_aabnet_kl", "is", null)
    .is("aabnet_besked_sendt_kl", null)
    .is("venter_paa_saelgerkonto_kl", null)
    .in("status", ["afventer", "behandles", "betalt"])
    .limit(100)
    .overrideTypes<BetalingRaekke[], { merge: false }>();
  if (mangler(error)) return 0;
  if (error) {
    await fejl("Åbnede betalinger", error);
    return 0;
  }
  const t = await titler((data ?? []).map((b) => b.auction_id));
  let antal = 0;
  for (const b of data ?? []) {
    try {
      if (b.status === "afventer" && !b.autobetaling_forsoegt_kl) await forsoegAutobetaling(b.id);
      const { data: claimet } = await admin
        .from("betalinger")
        .update({ aabnet_besked_sendt_kl: new Date().toISOString() })
        .eq("id", b.id)
        .is("aabnet_besked_sendt_kl", null)
        // Satte autobetalingens friske kontotjek betalingen til at vente
        // igen, sendes "nu kan du betale" ikke (den sendes ved næste åbning).
        .is("venter_paa_saelgerkonto_kl", null)
        .select("*")
        .overrideTypes<BetalingRaekke[], { merge: false }>();
      const nu = claimet?.[0];
      if (!nu) continue;
      const titel = t.get(b.auction_id) ?? "din vare";
      const link = `/mine-handler/${b.trade_id}`;
      if (nu.status === "betalt") {
        // Sælgeren har fået "køberen har betalt" (efterBetalt).
        await send(b.buyer_id, "vundet", {
          titel: "Du har betalt",
          tekst: `Sælgerens konto er godkendt, og beløbet for "${titel}" er trukket automatisk på dit gemte kort.`,
          link,
          data: { trade_id: b.trade_id },
          mail: koeberAutobetaltMail(titel, Number(b.total_oere), b.trade_id),
          noegle: `aabnet:${b.id}:${b.betaling_aabnet_kl}`,
        });
      } else {
        await send(b.buyer_id, "betalingsfrist", {
          titel: "Nu kan du betale",
          tekst: `Sælgerens konto er godkendt. Betal for "${titel}" inden for 48 timer, ellers bliver handlen annulleret.`,
          link,
          data: { trade_id: b.trade_id },
          mail: koeberBetalingAabnetMail(titel, Number(b.total_oere), b.trade_id, nu.betal_senest),
          noegle: `aabnet:${b.id}:${b.betaling_aabnet_kl}`,
        });
      }
      antal++;
    } catch (err) {
      await fejl("Besked om åbnet betaling", err);
    }
  }
  return antal;
}

// Henter sælgerkonti frisk hos Stripe og spejler dem (hvis account.updated er
// gået tabt). Ingen adgang til kontoen: markeres til staff og kan ikke tage
// imod betaling (ikke permanent - kun account.application.deauthorized
// frakobler).
async function hentOgSpejlKonti(saelgere: string[]): Promise<number> {
  if (!saelgere.length) return 0;
  const { data: profiler } = await createAdminClient()
    .from("betalingsprofiler")
    .select("user_id, stripe_account_id")
    .in("user_id", saelgere)
    .not("stripe_account_id", "is", null);
  let antal = 0;
  for (const p of profiler ?? []) {
    const kontoId = p.stripe_account_id as string;
    try {
      const konto = await getStripe().accounts.retrieve(kontoId);
      await spejlConnectKonto(konto);
      antal++;
    } catch (err) {
      if (err instanceof Stripe.errors.StripePermissionError) {
        try {
          await markerKontoUdenAdgang(kontoId);
        } catch (err2) {
          await fejl("Markering af konto uden adgang", err2);
        }
        continue;
      }
      await fejl("Frisk tjek af sælgerkonto", err);
    }
  }
  return antal;
}

// Sælgere med ventende betalinger (ældste først, højst 20) og frosne sælgere
// (højst 10, ældste frysning først - så frysningen ophæves, selv om et event
// er gået tabt).
export async function opdaterVentendeSaelgerkonti(): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("betalinger")
    .select("seller_id")
    .not("venter_paa_saelgerkonto_kl", "is", null)
    .eq("status", "afventer")
    .order("venter_paa_saelgerkonto_kl", { ascending: true })
    .limit(200);
  if (mangler(error)) return 0;
  if (error) {
    await fejl("Ventende sælgerkonti", error);
    return 0;
  }
  const { data: frosne, error: fFejl } = await admin
    .from("betalingsprofiler")
    .select("user_id")
    .not("saelger_frosset_kl", "is", null)
    .order("saelger_frosset_kl", { ascending: true })
    .limit(10);
  if (fFejl && !mangler(fFejl)) await fejl("Frosne sælgere", fFejl);
  const saelgere = [
    ...new Set([
      ...[...new Set((data ?? []).map((r) => r.seller_id as string))].slice(0, 20),
      ...(frosne ?? []).map((r) => r.user_id as string),
    ]),
  ];
  return hentOgSpejlKonti(saelgere);
}

// Påmindelse til sælgeren 3 dage efter, at betalingen begyndte at vente.
export async function paamindVentendeSaelgere(): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("betalinger")
    .select("*")
    .not("venter_paa_saelgerkonto_kl", "is", null)
    .is("venter_paamindet_kl", null)
    .eq("status", "afventer")
    .lte("venter_paa_saelgerkonto_kl", new Date(Date.now() - 3 * DAG).toISOString())
    .limit(100)
    .overrideTypes<BetalingRaekke[], { merge: false }>();
  if (mangler(error)) return 0;
  if (error) {
    await fejl("Påmindelse om sælgerkonto", error);
    return 0;
  }
  const t = await titler((data ?? []).map((b) => b.auction_id));
  let antal = 0;
  for (const b of data ?? []) {
    const { data: claimet } = await admin
      .from("betalinger")
      .update({ venter_paamindet_kl: new Date().toISOString() })
      .eq("id", b.id)
      .is("venter_paamindet_kl", null)
      .select("id");
    if (!claimet?.length) continue;
    const titel = t.get(b.auction_id) ?? "din vare";
    const r = await send(b.seller_id, "udbetaling", {
      titel: "Din konto er ikke godkendt endnu",
      tekst: `Køberen kan ikke betale for "${titel}", før din konto hos vores betalingspartner Stripe er godkendt. Gør opsætningen færdig under Min konto.`,
      link: "/konto",
      data: { trade_id: b.trade_id },
      mail: saelgerKontoIkkeKlarMail(titel, true),
      noegle: `venter_paamind:${b.id}:${b.venter_paa_saelgerkonto_kl}`,
    });
    if (r.mail) antal++;
  }
  return antal;
}

type Annulleret = {
  trade_id: string;
  auction_id: string;
  buyer_id: string;
  seller_id: string;
  betaling_id: string;
  payment_intent: string | null;
};

// Kontoen blev ikke godkendt 7 dage efter auktionens slutning: handel og
// auktion annulleres (køberen trækkes ikke), og sælgeren fryses (Filip
// 8. okt. 2026). En evt. PaymentIntent annulleres hos Stripe; er den
// alligevel betalt, giver spejlingen automatisk refusion (sen_betaling).
export async function annullerIkkeGodkendte(): Promise<number> {
  // Sælgerkontoen hentes frisk hos Stripe lige før: er den blevet godkendt,
  // åbnes betalingen i stedet (et tabt account.updated må ikke annullere en
  // handel). Databasen annullerer dog altid, når betalingen stadig venter 1
  // døgn efter fristen.
  const { data: forfaldne, error: fFejl } = await createAdminClient()
    .from("betalinger")
    .select("seller_id")
    .not("venter_paa_saelgerkonto_kl", "is", null)
    .eq("status", "afventer")
    .lte("betal_senest", new Date().toISOString())
    .limit(100);
  if (mangler(fFejl)) return 0;
  if (fFejl) await fejl("Forfaldne ventende betalinger", fFejl);
  const saelgere = [...new Set((forfaldne ?? []).map((r) => r.seller_id as string))];
  if (saelgere.length) {
    await hentOgSpejlKonti(saelgere);
    await aabnVentende();
  }
  const { data, error } = await createAdminClient().rpc("betaling_annuller_ikke_godkendt_saelgerkonto");
  if (mangler(error)) return 0;
  if (error) {
    await fejl("Annullering (sælgerkonto ikke godkendt)", error);
    return 0;
  }
  const liste = (Array.isArray(data) ? data : []) as Annulleret[];
  const t = await titler(liste.map((a) => a.auction_id));
  for (const a of liste) {
    if (a.payment_intent) {
      const stripe = getStripe();
      try {
        await stripe.paymentIntents.cancel(
          a.payment_intent,
          { cancellation_reason: "abandoned" },
          { idempotencyKey: `bidhamr-annuller-${a.payment_intent}` },
        );
      } catch (err) {
        try {
          const pi = await stripe.paymentIntents.retrieve(a.payment_intent);
          if (pi.status === "succeeded") await spejlPaymentIntent(pi);
          else if (pi.status !== "canceled") await fejl("Annullering af PaymentIntent (sælgerkonto)", err);
        } catch (err2) {
          await fejl("Annullering af PaymentIntent (sælgerkonto)", err2);
        }
      }
    }
    const titel = t.get(a.auction_id) ?? "din vare";
    const link = `/mine-handler/${a.trade_id}`;
    try {
      await send(a.buyer_id, "betalingsfrist", {
        titel: "Handlen er annulleret",
        tekst: `Handlen om "${titel}" er annulleret, fordi sælgerens konto ikke blev godkendt i tide. Du er ikke blevet trukket noget.`,
        link,
        data: { trade_id: a.trade_id },
        mail: koeberAnnulleretSaelgerkontoMail(titel, a.trade_id),
        noegle: `annulleret_saelgerkonto:${a.betaling_id}:koeber`,
      });
      await send(a.seller_id, "udbetaling", {
        titel: "Din auktion er annulleret",
        tekst: `"${titel}" er annulleret, fordi din konto hos Stripe ikke blev godkendt inden for 7 dage. Din konto er sat på pause, til Stripe har godkendt den.`,
        link: "/konto",
        data: { trade_id: a.trade_id },
        mail: saelgerAnnulleretSaelgerkontoMail(titel),
        noegle: `annulleret_saelgerkonto:${a.betaling_id}:saelger`,
      });
    } catch (err) {
      await fejl("Beskeder (sælgerkonto ikke godkendt)", err);
    }
  }
  return liste.length;
}

// Cron: alt om ventende betalinger. Kaster aldrig.
export async function behandlVentendeBetalinger() {
  const r = { kontiTjekket: 0, aabnet: 0, aabnetBeskeder: 0, paamindelser: 0, annulleret: 0 };
  try {
    r.kontiTjekket = await opdaterVentendeSaelgerkonti();
    r.aabnet = await aabnVentende();
    r.aabnetBeskeder = await notificerAabnede();
    r.paamindelser = await paamindVentendeSaelgere();
    r.annulleret = await annullerIkkeGodkendte();
  } catch (err) {
    await fejl("Ventende betalinger", err);
  }
  return r;
}
