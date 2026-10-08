import "server-only";

// Server-only: afsendelsesfristen (ROADMAP-BESLUTNINGER, "Midlertidige
// beslutninger"): sælgeren skal markere pakken sendt inden 5 dage efter
// betalingen (betalinger.betalt_kl). Ellers annulleres handlen, og køberen
// refunderes FULDT via Stripe (total_oere: bud + købergebyr + fragt + BidHamr
// Beskyttelse). Kun handler med forsendelse - ikke afhentning.
//
//   paamindSaelgerOmAfsendelse  påmindelse efter dag 3 og dag 4
//   annullerIkkeSendte          annullering + refusion + beskeder, og nye
//                               forsøg på refusioner/beskeder, der fejlede
//
// Databasen afgør og claimer atomisk (afsendelsesfrist_annuller - låser
// betaling, så handel, og springer handler med sag, indsigelse, påbegyndt
// refusion, frigivelse/overførsel eller ændret status over). Refusionen laves
// bagefter af refunderBetaling (idempotency key pr. betaling, og en
// eksisterende refusion hos Stripe genbruges). Alle beskeder har idempotente
// nøgler. Ingen automatisk advarsel: betalingen markeres til staff på
// "Betalinger", hvor en medarbejder kan give sælgeren en advarsel.
// Kaster aldrig.
import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { refunderBetaling } from "@/lib/betaling/stripeBetaling";
import {
  koeberAfsendelsesfristAnnulleretMail,
  kronerFraOere,
  saelgerAfsendelsesfristAnnulleretMail,
  saelgerAfsendelsesPaamindelseMail,
} from "@/lib/mails/handel";
import {
  AFSENDELSESFRIST_DAGE,
  AFSENDELSE_PAAMIND_DAGE,
  sendSenest,
  sendSenestTekst,
} from "@/lib/afsendelsesfrist";

type Admin = ReturnType<typeof createAdminClient>;

const DAG = 24 * 60 * 60 * 1000;

async function titler(admin: Admin, auktionIds: string[]): Promise<Map<string, string>> {
  if (auktionIds.length === 0) return new Map();
  const { data } = await admin
    .from("auctions")
    .select("id, titel")
    .in("id", [...new Set(auktionIds)]);
  return new Map((data ?? []).map((a) => [a.id as string, a.titel as string]));
}

// --- Påmindelser ---------------------------------------------------------------

type BetaltRaekke = {
  trade_id: string;
  seller_id: string;
  auction_id: string;
  betalt_kl: string;
};

// Påmindelse til sælgeren efter dag 3 og dag 4, når pakken ikke er markeret
// sendt. Nøglen `afsendelse_paamind_<dag>:<handel>` sendes kun én gang. Den
// seneste påmindelse vælges, så en kørsel efter nedetid ikke sender begge.
// Kun handler, der stadig kan annulleres (samme betingelser som
// afsendelsesfrist_annuller, bortset fra fristen) - ellers ville teksten være
// forkert. Kaster aldrig.
export async function paamindSaelgerOmAfsendelse(): Promise<number> {
  try {
    const admin = createAdminClient();
    const nu = Date.now();
    const tidligst = Math.min(...AFSENDELSE_PAAMIND_DAGE);
    const { data: betalinger, error } = await admin
      .from("betalinger")
      .select("trade_id, seller_id, auction_id, betalt_kl, indsigelse_kl, indsigelse_status")
      .eq("status", "betalt")
      .is("frigivet_kl", null)
      .is("refusion_anmodet_kl", null)
      .is("overfoersel_paabegyndt_kl", null)
      .is("stripe_transfer_id", null)
      .is("afsendelsesfrist_annulleret_kl", null)
      .not("betalt_kl", "is", null)
      .lte("betalt_kl", new Date(nu - tidligst * DAG).toISOString())
      .gt("betalt_kl", new Date(nu - AFSENDELSESFRIST_DAGE * DAG).toISOString())
      .limit(500);
    if (error) {
      console.error("Hentning af betalinger til afsendelsespåmindelse fejlede:", error.message);
      return 0;
    }
    // Åben eller tabt indsigelse: så annulleres intet automatisk.
    const kandidater = ((betalinger ?? []) as (BetaltRaekke & {
      indsigelse_kl: string | null;
      indsigelse_status: string | null;
    })[]).filter(
      (b) =>
        !b.indsigelse_kl ||
        ["won", "warning_closed", "prevented"].includes(b.indsigelse_status ?? ""),
    );
    if (kandidater.length === 0) return 0;

    const { data: handler, error: hFejl } = await admin
      .from("trades")
      .select("id")
      .in("id", kandidater.map((b) => b.trade_id))
      .eq("status", "betaling_modtaget")
      .eq("afhentning", false)
      .or("sag_aaben.is.null,sag_aaben.eq.false");
    if (hFejl) {
      console.error("Hentning af handler til afsendelsespåmindelse fejlede:", hFejl.message);
      return 0;
    }
    const aabne = new Set((handler ?? []).map((t) => t.id as string));
    const liste = kandidater.filter((b) => aabne.has(b.trade_id));
    if (liste.length === 0) return 0;
    const t = await titler(admin, liste.map((b) => b.auction_id));

    let antal = 0;
    for (const b of liste) {
      const betalt = Date.parse(b.betalt_kl);
      const frist = sendSenest(b.betalt_kl);
      if (Number.isNaN(betalt) || !frist) continue;
      const dagNr = [...AFSENDELSE_PAAMIND_DAGE]
        .reverse()
        .find((d) => nu >= betalt + d * DAG);
      if (dagNr === undefined) continue;
      const titel = t.get(b.auction_id) ?? "din vare";
      const fristTekst = sendSenestTekst(frist);
      const r = await send(
        b.seller_id,
        "betaling_modtaget",
        {
          titel: "Husk at sende pakken",
          tekst: `Send "${titel}" senest ${fristTekst}, ellers annulleres handlen, og køberen får hele beløbet tilbage.`,
          link: `/mine-handler/${b.trade_id}`,
          data: { trade_id: b.trade_id },
          mail: saelgerAfsendelsesPaamindelseMail(titel, b.trade_id, fristTekst),
          noegle: `afsendelse_paamind_${dagNr}:${b.trade_id}`,
        },
        { springOverVedClaimFejl: true },
      );
      if (!r.dublet && (r.klokke || r.mail || r.push)) antal++;
    }
    return antal;
  } catch (err) {
    console.error("Påmindelse om afsendelse fejlede:", err);
    return 0;
  }
}

// --- Annullering ---------------------------------------------------------------

type Annulleret = {
  betaling_id: string;
  trade_id: string;
  buyer_id: string;
  seller_id: string;
  auction_id: string;
  total_oere: number;
};

const NOEGLE_KOEBER = (tradeId: string) => `afsendelsesfrist_koeber:${tradeId}`;
const NOEGLE_SAELGER = (tradeId: string) => `afsendelsesfrist_saelger:${tradeId}`;

async function sendAnnulleringsbeskeder(
  a: Pick<Annulleret, "trade_id" | "buyer_id" | "seller_id" | "total_oere">,
  titel: string,
  mangler: { koeber: boolean; saelger: boolean } = { koeber: true, saelger: true },
): Promise<void> {
  const link = `/mine-handler/${a.trade_id}`;
  if (mangler.koeber) {
    await send(a.buyer_id, "pakke_sendt", {
      titel: "Handlen er annulleret",
      tekst: `Sælgeren sendte ikke varen i tide. Du får hele beløbet tilbage (${kronerFraOere(Number(a.total_oere))} kr) for "${titel}" på den betalingsmetode, du betalte med. Der kan gå nogle dage, før pengene står på din konto. Betalingen håndteres af vores betalingspartner Stripe.`,
      link,
      data: { trade_id: a.trade_id },
      mail: koeberAfsendelsesfristAnnulleretMail(titel, Number(a.total_oere), a.trade_id),
      noegle: NOEGLE_KOEBER(a.trade_id),
    });
  }
  if (mangler.saelger) {
    await send(a.seller_id, "betaling_modtaget", {
      titel: "Handlen er annulleret",
      tekst: `Pakken med "${titel}" blev ikke markeret som sendt inden ${AFSENDELSESFRIST_DAGE} dage efter betalingen, så handlen er annulleret, og køberen får hele beløbet tilbage. Du skal ikke sende varen. Har du allerede sendt den, så skriv straks til support@bidhamr.dk.`,
      link,
      data: { trade_id: a.trade_id },
      mail: saelgerAfsendelsesfristAnnulleretMail(titel, a.trade_id),
      noegle: NOEGLE_SAELGER(a.trade_id),
    });
  }
}

// Cron-trin. Returnerer antal annullerede handler og antal refusioner, der
// gik igennem hos Stripe i denne kørsel (nye og gentagne forsøg).
export async function annullerIkkeSendte(): Promise<{ annulleret: number; refunderet: number }> {
  let annulleret = 0;
  let refunderet = 0;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("afsendelsesfrist_annuller");
    if (error) console.error("afsendelsesfrist_annuller fejlede:", error.message);
    const liste = (Array.isArray(data) ? data : []) as Annulleret[];
    annulleret = liste.length;

    if (liste.length > 0) {
      const t = await titler(admin, liste.map((a) => a.auction_id));
      for (const a of liste) {
        // Beskeder først: handlen er annulleret og refusionen claimet, også
        // hvis Stripe-kaldet nedenfor fejler og prøves igen. Kaster aldrig.
        await sendAnnulleringsbeskeder(a, t.get(a.auction_id) ?? "din vare");
        try {
          if ((await refunderBetaling(a.betaling_id)) === "refunderet") refunderet++;
        } catch (err) {
          console.error("Refusion efter afsendelsesfrist fejlede (cron prøver igen):", a.trade_id, err);
        }
      }
    }

    refunderet += await proevIgen(admin);
  } catch (err) {
    console.error("Annullering efter afsendelsesfrist fejlede:", err);
  }
  return { annulleret, refunderet };
}

// Nye forsøg:
//   - Refusioner, der er claimet for mindst 10 minutter siden (så cron ikke
//     kører samtidig med første forsøg ovenfor), men ikke gennemført hos
//     Stripe. refunderBetaling er idempotent.
//   - Beskeder, der ikke blev sendt (fx hvis serveren døde efter
//     annulleringen). Forsøges i 2 dage efter annulleringen.
async function proevIgen(admin: Admin): Promise<number> {
  let antal = 0;
  const { data: ventende, error } = await admin
    .from("betalinger")
    .select("id, trade_id")
    .eq("status", "betalt")
    .eq("refusion_aarsag", "afsendelsesfrist")
    .not("afsendelsesfrist_annulleret_kl", "is", null)
    .not("refusion_anmodet_kl", "is", null)
    .lt("refusion_anmodet_kl", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .is("stripe_transfer_id", null)
    .is("overfoersel_paabegyndt_kl", null)
    // refusion_forsoeg < refusion_graense (standard 5).
    .eq("refusion_opbrugt", false)
    // Backoff efter en fejlet refusion (20261010070000).
    .or(`refusion_naeste_forsoeg_kl.is.null,refusion_naeste_forsoeg_kl.lte.${new Date().toISOString()}`)
    .limit(50);
  if (error) {
    console.error("Hentning af ventende afsendelsesrefusioner fejlede:", error.message);
  }
  for (const b of (ventende ?? []) as { id: string; trade_id: string }[]) {
    try {
      if ((await refunderBetaling(b.id)) === "refunderet") antal++;
    } catch (err) {
      console.error("Afsendelsesrefusion fejlede (prøves igen):", b.trade_id, err);
    }
  }

  const { data: nye, error: nFejl } = await admin
    .from("betalinger")
    .select("trade_id, buyer_id, seller_id, auction_id, total_oere")
    .not("afsendelsesfrist_annulleret_kl", "is", null)
    .gte("afsendelsesfrist_annulleret_kl", new Date(Date.now() - 2 * DAG).toISOString())
    .limit(200);
  if (nFejl) {
    console.error("Hentning af afsendelsesannulleringer fejlede:", nFejl.message);
    return antal;
  }
  const raekker = (nye ?? []) as Omit<Annulleret, "betaling_id">[];
  if (raekker.length === 0) return antal;
  const noegler = raekker.flatMap((r) => [NOEGLE_KOEBER(r.trade_id), NOEGLE_SAELGER(r.trade_id)]);
  const { data: sendte, error: sFejl } = await admin
    .from("notifikation_afsendelser")
    .select("noegle")
    .in("noegle", noegler);
  if (sFejl) {
    console.error("Opslag af sendte afsendelsesbeskeder fejlede:", sFejl.message);
    return antal;
  }
  const sendt = new Set((sendte ?? []).map((s) => s.noegle as string));
  const mangler = raekker.filter(
    (r) => !sendt.has(NOEGLE_KOEBER(r.trade_id)) || !sendt.has(NOEGLE_SAELGER(r.trade_id)),
  );
  if (mangler.length === 0) return antal;
  const t = await titler(admin, mangler.map((r) => r.auction_id));
  for (const r of mangler) {
    await sendAnnulleringsbeskeder(r, t.get(r.auction_id) ?? "din vare", {
      koeber: !sendt.has(NOEGLE_KOEBER(r.trade_id)),
      saelger: !sendt.has(NOEGLE_SAELGER(r.trade_id)),
    });
  }
  return antal;
}

// --- Visning på handelssiden ---------------------------------------------------

export type AfsendelsesfristAnnullering = {
  annulleretKl: string;
  // Stripe har gennemført refusionen (spejlet i databasen).
  refunderet: boolean;
};

// Blev handlen annulleret, fordi pakken ikke blev sendt i tide? Kun til
// køber og sælger på handlen (brugerId er den indloggede bruger, verificeret
// af kalderen). Kolonnen kan ikke læses med brugerens JWT, så service-role
// bruges med eksplicit partsfilter.
export async function hentAfsendelsesfristAnnullering(
  tradeId: string,
  brugerId: string,
): Promise<AfsendelsesfristAnnullering | null> {
  try {
    const { data } = await createAdminClient()
      .from("betalinger")
      .select("afsendelsesfrist_annulleret_kl, status")
      .eq("trade_id", tradeId)
      .or(`buyer_id.eq.${brugerId},seller_id.eq.${brugerId}`)
      .not("afsendelsesfrist_annulleret_kl", "is", null)
      .maybeSingle<{ afsendelsesfrist_annulleret_kl: string; status: string }>();
    if (!data) return null;
    return {
      annulleretKl: data.afsendelsesfrist_annulleret_kl,
      refunderet: data.status === "refunderet",
    };
  } catch (err) {
    console.error("hentAfsendelsesfristAnnullering fejlede:", err);
    return null;
  }
}
