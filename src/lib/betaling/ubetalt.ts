import "server-only";

// Vinderen betaler ikke (ROADMAP-BESLUTNINGER.md, 2. oktober 2026).
// Deles af cron og server actions. Hver mail claimes atomisk (tidsstempel sat
// fra NULL) FØR afsendelse, så den aldrig sendes to gange.

import { createAdminClient } from "@/lib/supabase/admin";
import { annullerBetaling, spejlPaymentIntent } from "@/lib/betaling/stripeBetaling";
import { getStripe } from "@/lib/stripe";
import { send } from "@/lib/notifikationer/send";
import {
  andenchanceTilbudMail,
  koeberAdminAnnulleretMail,
  koeberUbetaltAnnulleretMail,
  saelgerAdminAnnulleretMail,
  saelgerAndenchanceAccepteretMail,
  saelgerAndenchanceAfslaaetMail,
  saelgerUbetaltAnnulleretMail,
} from "@/lib/mails/handel";

type Admin = ReturnType<typeof createAdminClient>;

async function claimFelt(
  admin: Admin,
  tabel: "ubetalte_vindere" | "andenchance_tilbud",
  id: string,
  felt: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from(tabel)
    .update({ [felt]: new Date().toISOString() })
    .eq("id", id)
    .is(felt, null)
    .select("id");
  if (error) {
    console.error(`claim ${tabel}.${felt} fejlede:`, error);
    return false;
  }
  return (data ?? []).length > 0;
}

async function titelOgEmails(admin: Admin, auktionId: string, brugerIds: string[]) {
  const [{ data: auktion }, { data: brugere }] = await Promise.all([
    admin.from("auctions").select("titel").eq("id", auktionId).maybeSingle(),
    admin.from("users").select("id, email").in("id", brugerIds),
  ]);
  return {
    titel: (auktion?.titel as string | undefined) ?? "din auktion",
    email: new Map((brugere ?? []).map((u) => [u.id as string, u.email as string])),
  };
}

// --- Annullering af ubetalte handler ------------------------------------------

type SagRaekke = {
  id: string;
  trade_id: string;
  auction_id: string;
  buyer_id: string;
  seller_id: string;
  stripe_annulleret_kl: string | null;
  koeber_mail_sendt_kl: string | null;
  saelger_mail_sendt_kl: string | null;
  oprettet: string;
  aarsag: "ubetalt" | "admin_annulleret";
  stripe_annullering_markeret_kl: string | null;
};

const SYV_DAGE_MS = 7 * 24 * 60 * 60 * 1000;

// Cron-trin: annullerer betalinger med overskreden frist, opretter sagen,
// annullerer PaymentIntent hos Stripe og sender mails. Alt er idempotent og
// genoptages i næste kørsel, hvis noget fejler undervejs.
export async function annullerUbetalte(): Promise<{ annulleret: number; mails: number }> {
  const admin = createAdminClient();
  let annulleret = 0;
  let mails = 0;

  // Kun betalinger, der ikke er sat i gang. En betaling i gang ('behandles',
  // fx MobilePay) håndteres nedenfor efter et tjek hos Stripe.
  const { data: forfaldne, error } = await admin
    .from("betalinger")
    .select("trade_id, stripe_payment_intent_id, betal_senest")
    .eq("status", "afventer")
    .lt("betal_senest", new Date().toISOString())
    .order("betal_senest", { ascending: true })
    .limit(200)
    .overrideTypes<BetalingRaekke[], { merge: false }>();
  if (error) console.error("Kunne ikke hente forfaldne betalinger:", error);

  annulleret += await afklarBehandlede(admin);

  for (const b of forfaldne ?? []) {
    const trade_id = b.trade_id;
    // En køber, der har betalt, må aldrig annulleres: spørg Stripe først.
    if (b.stripe_payment_intent_id) {
      const udfald = await stripeUdfald(b.stripe_payment_intent_id, trade_id);
      if (udfald !== "fejlet") {
        if (udfald === "vent") await markerUafklaret(admin, b);
        continue;
      }
      // Køberen har startet en betaling (fx midt i 3D Secure): samme ekstra
      // time som for 'behandles', før handlen annulleres.
      if (Date.now() < new Date(b.betal_senest).getTime() + EKSTRA_FRIST_MS) continue;
    }
    const { data, error: rpcFejl } = await admin.rpc("ubetalt_vinder_annuller", {
      p_trade: trade_id,
    });
    if (rpcFejl) {
      console.error("ubetalt_vinder_annuller fejlede:", trade_id, rpcFejl);
      continue;
    }
    if ((data as { annulleret?: boolean } | null)?.annulleret) annulleret++;
  }

  // Sager, hvor Stripe-annullering eller mails mangler (også fra tidligere
  // kørsler, der blev afbrudt). Mails forsøges i 7 dage. Stripe-annulleringen
  // forsøges, til den lykkes - efter 7 dage markeres betalingen til admin.
  const graense = new Date(Date.now() - SYV_DAGE_MS).toISOString();
  const { data: sager } = await admin
    .from("ubetalte_vindere")
    .select(
      "id, trade_id, auction_id, buyer_id, seller_id, stripe_annulleret_kl, koeber_mail_sendt_kl, saelger_mail_sendt_kl, oprettet, aarsag, stripe_annullering_markeret_kl",
    )
    .or(
      `stripe_annulleret_kl.is.null,and(oprettet.gte.${graense},or(koeber_mail_sendt_kl.is.null,saelger_mail_sendt_kl.is.null))`,
    )
    .order("oprettet", { ascending: true })
    .limit(200)
    .overrideTypes<SagRaekke[], { merge: false }>();

  for (const s of sager ?? []) {
    if (!s.stripe_annulleret_kl) {
      // Efter 7 dage uden held: til admin (én gang), men fortsæt forsøgene.
      if (
        !s.stripe_annullering_markeret_kl &&
        Date.now() - new Date(s.oprettet).getTime() >= SYV_DAGE_MS &&
        (await claimFelt(admin, "ubetalte_vindere", s.id, "stripe_annullering_markeret_kl"))
      ) {
        const { error: mFejl } = await admin
          .from("betalinger")
          .update({
            kraever_opmaerksomhed: true,
            sidste_fejl: "Stripe-annullering af betalingen er ikke lykkedes efter 7 dage",
            opdateret: new Date().toISOString(),
          })
          .eq("trade_id", s.trade_id);
        if (mFejl) console.error("Markering (Stripe-annullering) fejlede:", s.trade_id, mFejl);
      }
      try {
        // Idempotent: betaling_annuller returnerer PaymentIntent-id'et igen for
        // en allerede annulleret betaling, og Stripe-kaldet har idempotensnøgle.
        // stripe_annulleret_kl sættes kun, når annulleringen lykkedes -
        // ellers prøves der igen ved næste kørsel.
        if ((await annullerBetaling(s.trade_id)) === "stripe_fejlede") {
          throw new Error("Stripe-annullering lykkedes ikke");
        }
        await admin
          .from("ubetalte_vindere")
          .update({ stripe_annulleret_kl: new Date().toISOString() })
          .eq("id", s.id)
          .is("stripe_annulleret_kl", null);
      } catch (err) {
        console.error("Stripe-annullering fejlede:", s.trade_id, err);
      }
    }

    if (s.koeber_mail_sendt_kl && s.saelger_mail_sendt_kl) continue;
    if (Date.now() - new Date(s.oprettet).getTime() >= SYV_DAGE_MS) continue;
    const adminAnnulleret = s.aarsag === "admin_annulleret";
    const o = await titelOgEmails(admin, s.auction_id, [s.buyer_id, s.seller_id]);
    if (!s.koeber_mail_sendt_kl && (await claimFelt(admin, "ubetalte_vindere", s.id, "koeber_mail_sendt_kl"))) {
      const mail = (adminAnnulleret ? koeberAdminAnnulleretMail : koeberUbetaltAnnulleretMail)(o.titel, s.trade_id);
      const r = await send(s.buyer_id, adminAnnulleret ? "sag" : "betalingsfrist", {
        titel: "Handlen er annulleret",
        tekst: adminAnnulleret
          ? `BidHamr har annulleret handlen om "${o.titel}". Du er ikke blevet opkrævet noget.`
          : `Du betalte ikke for "${o.titel}" inden fristen, så handlen er annulleret.`,
        link: `/mine-handler/${s.trade_id}`,
        data: { trade_id: s.trade_id },
        mail,
        noegle: `ubetalt_koeber:${s.id}`,
      });
      if (r.mail) mails++;
    }
    if (!s.saelger_mail_sendt_kl && (await claimFelt(admin, "ubetalte_vindere", s.id, "saelger_mail_sendt_kl"))) {
      const mail = (adminAnnulleret ? saelgerAdminAnnulleretMail : saelgerUbetaltAnnulleretMail)(o.titel, s.trade_id);
      const r = await send(s.seller_id, adminAnnulleret ? "sag" : "andenchance", {
        titel: adminAnnulleret ? "Handlen er annulleret" : "Køberen betalte ikke",
        tekst: adminAnnulleret
          ? `BidHamr har annulleret handlen om "${o.titel}". Du skal ikke sende varen.`
          : `Køberen af "${o.titel}" betalte ikke, og du skal ikke sende varen. Du kan tilbyde varen til næste byder eller sætte den op igen gratis.`,
        link: `/mine-handler/${s.trade_id}`,
        data: { trade_id: s.trade_id },
        mail,
        noegle: `ubetalt_saelger:${s.id}`,
      });
      if (r.mail) mails++;
    }
  }

  return { annulleret, mails };
}

type BetalingRaekke = {
  trade_id: string;
  stripe_payment_intent_id: string | null;
  betal_senest: string;
};

// Stripe er sandheden. Udfald for et PaymentIntent:
//   "betalt" -> succeeded, spejlet i databasen (køberen betalte)
//   "fejlet" -> requires_payment_method/requires_action/requires_confirmation/canceled
//   "vent"   -> processing, anden status, eller Stripe-kaldet fejlede
async function stripeUdfald(piId: string, tradeId: string): Promise<"betalt" | "fejlet" | "vent"> {
  try {
    const pi = await getStripe().paymentIntents.retrieve(piId);
    if (pi.status === "succeeded") {
      await spejlPaymentIntent(pi);
      return "betalt";
    }
    if (
      pi.status === "requires_payment_method" ||
      pi.status === "requires_action" ||
      pi.status === "requires_confirmation" ||
      pi.status === "canceled"
    ) {
      return "fejlet";
    }
    return "vent";
  } catch (err) {
    console.error("Stripe-tjek af betaling fejlede (springes over):", tradeId, err);
    return "vent";
  }
}

// En betaling, der ikke har kunnet afklares 7 dage efter fristen, markeres til
// admin. Idempotent: rammer kun rækker, der ikke allerede er markeret.
const UAFKLARET_MS = 7 * 24 * 60 * 60 * 1000;

async function markerUafklaret(admin: Admin, b: BetalingRaekke): Promise<void> {
  if (Date.now() < new Date(b.betal_senest).getTime() + UAFKLARET_MS) return;
  const { error } = await admin
    .from("betalinger")
    .update({
      kraever_opmaerksomhed: true,
      sidste_fejl: "Betaling kunne ikke afklares hos Stripe",
      opdateret: new Date().toISOString(),
    })
    .eq("trade_id", b.trade_id)
    .in("status", ["afventer", "behandles"])
    .eq("kraever_opmaerksomhed", false);
  if (error) console.error("Kunne ikke markere uafklaret betaling:", b.trade_id, error);
}

// Betalinger i gang ('behandles') efter fristen:
//   succeeded                    -> spejles (køberen betalte til tiden)
//   requires_*/canceled          -> efter betal_senest + 1 time behandles
//                                   handlen som ubetalt
//   processing / Stripe-fejl     -> vent til næste kørsel; efter 7 dage
//                                   markeres betalingen til admin
const EKSTRA_FRIST_MS = 60 * 60 * 1000;

async function afklarBehandlede(admin: Admin): Promise<number> {
  let annulleret = 0;
  const { data: behandles, error } = await admin
    .from("betalinger")
    .select("trade_id, stripe_payment_intent_id, betal_senest")
    .eq("status", "behandles")
    .lt("betal_senest", new Date().toISOString())
    .order("betal_senest", { ascending: true })
    .limit(200)
    .overrideTypes<BetalingRaekke[], { merge: false }>();
  if (error) console.error("Kunne ikke hente betalinger i gang:", error);

  for (const b of behandles ?? []) {
    if (b.stripe_payment_intent_id) {
      const udfald = await stripeUdfald(b.stripe_payment_intent_id, b.trade_id);
      if (udfald === "betalt") continue;
      if (udfald === "vent") {
        await markerUafklaret(admin, b);
        continue;
      }
    }
    if (Date.now() < new Date(b.betal_senest).getTime() + EKSTRA_FRIST_MS) continue;

    const { data, error: rpcFejl } = await admin.rpc("ubetalt_vinder_annuller", {
      p_trade: b.trade_id,
      p_stripe_fejlet: true,
    });
    if (rpcFejl) {
      console.error("ubetalt_vinder_annuller (behandles) fejlede:", b.trade_id, rpcFejl);
      continue;
    }
    if ((data as { annulleret?: boolean } | null)?.annulleret) annulleret++;
  }
  return annulleret;
}

// --- Andenchance-tilbud --------------------------------------------------------

type TilbudRaekke = {
  id: string;
  auction_id: string;
  oprindelig_trade_id: string;
  seller_id: string;
  byder_id: string;
  bud_oere: number;
  status: string;
  udloeber: string;
  ny_trade_id: string | null;
  byder_mail_sendt_kl: string | null;
  saelger_mail_sendt_kl: string | null;
};

const TILBUD_KOLONNER =
  "id, auction_id, oprindelig_trade_id, seller_id, byder_id, bud_oere, status, udloeber, ny_trade_id, byder_mail_sendt_kl, saelger_mail_sendt_kl";

// Mail til byderen om et nyt tilbud. Sendes kun én gang.
export async function sendTilbudMail(tilbudId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data: t } = await admin
    .from("andenchance_tilbud")
    .select(TILBUD_KOLONNER)
    .eq("id", tilbudId)
    .maybeSingle<TilbudRaekke>();
  if (!t || t.status !== "afventer" || t.byder_mail_sendt_kl) return false;
  if (!(await claimFelt(admin, "andenchance_tilbud", t.id, "byder_mail_sendt_kl"))) return false;
  const o = await titelOgEmails(admin, t.auction_id, [t.byder_id]);
  const r = await send(t.byder_id, "andenchance", {
    titel: "Du får tilbudt en vare",
    tekst: `Du kan købe "${o.titel}" til dit eget højeste bud. Svar inden for 24 timer.`,
    link: `/andenchance/${t.id}`,
    data: { tilbud_id: t.id, auction_id: t.auction_id },
    mail: andenchanceTilbudMail(o.titel, Number(t.bud_oere), t.id, t.udloeber),
    noegle: `andenchance_tilbud:${t.id}`,
  });
  return r.mail;
}

// Mail til sælgeren, når et tilbud er accepteret, afvist eller udløbet.
// Annullerede tilbud (sælger satte varen op igen) giver ingen mail.
// Med byderKanIkkeKoebe = true sendes også for et annulleret tilbud
// (byderen er suspenderet). Årsagen nævnes ikke for sælgeren (privatliv).
export async function sendSaelgerSvarMail(
  tilbudId: string,
  byderKanIkkeKoebe = false,
): Promise<boolean> {
  const admin = createAdminClient();
  const { data: t } = await admin
    .from("andenchance_tilbud")
    .select(TILBUD_KOLONNER)
    .eq("id", tilbudId)
    .maybeSingle<TilbudRaekke>();
  if (!t || t.saelger_mail_sendt_kl) return false;
  const annulleretSendes = byderKanIkkeKoebe && t.status === "annulleret";
  if (!annulleretSendes && !["accepteret", "afvist", "udloebet"].includes(t.status)) return false;
  if (!(await claimFelt(admin, "andenchance_tilbud", t.id, "saelger_mail_sendt_kl"))) return false;
  const o = await titelOgEmails(admin, t.auction_id, [t.seller_id]);
  const mail =
    t.status === "accepteret" && t.ny_trade_id
      ? saelgerAndenchanceAccepteretMail(o.titel, t.ny_trade_id)
      : saelgerAndenchanceAfslaaetMail(
          o.titel,
          t.oprindelig_trade_id,
          annulleretSendes ? "kan_ikke_koebe" : t.status === "afvist" ? "afvist" : "udloebet",
        );
  const accepteret = t.status === "accepteret" && !!t.ny_trade_id;
  const r = await send(t.seller_id, "andenchance", {
    titel: accepteret ? "Byderen sagde ja" : "Byderen købte ikke",
    tekst: accepteret
      ? `Byderen vil købe "${o.titel}". Vent med at sende varen, til køberen har betalt.`
      : `Byderen købte ikke "${o.titel}". Du kan sende tilbuddet videre eller sætte varen op igen gratis.`,
    link: `/mine-handler/${accepteret ? t.ny_trade_id : t.oprindelig_trade_id}`,
    data: { tilbud_id: t.id },
    mail,
    noegle: `andenchance_svar:${t.id}`,
  });
  return r.mail;
}

// Cron-trin: udløb tilbud og send de mails, der mangler (også efter fejl).
export async function behandlAndenchance(): Promise<{ udloebne: number; mails: number }> {
  const admin = createAdminClient();
  const { data: antal, error } = await admin.rpc("andenchance_udloeb");
  if (error) console.error("andenchance_udloeb fejlede:", error);

  let mails = 0;
  const siden = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: svar } = await admin
    .from("andenchance_tilbud")
    .select("id")
    .in("status", ["accepteret", "afvist", "udloebet"])
    .is("saelger_mail_sendt_kl", null)
    .gte("oprettet", siden)
    .limit(200);
  for (const { id } of svar ?? []) {
    if (await sendSaelgerSvarMail(id as string)) mails++;
  }

  const { data: nye } = await admin
    .from("andenchance_tilbud")
    .select("id")
    .eq("status", "afventer")
    .is("byder_mail_sendt_kl", null)
    .limit(200);
  for (const { id } of nye ?? []) {
    if (await sendTilbudMail(id as string)) mails++;
  }

  return { udloebne: Number(antal ?? 0), mails };
}
