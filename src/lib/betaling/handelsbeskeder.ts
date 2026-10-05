import "server-only";

// Beskeder ved handlens afslutning (ROADMAP fase 5 "Mails ved alle trin" og
// "Kvittering til køber og sælger"). Alle går gennem send() og har en
// idempotent nøgle pr. handel, så dobbeltklik, webhook-gentagelser og cron
// aldrig giver to beskeder. Kaster aldrig - handelsflowet mærker intet.
//
//   kvittering_koeber:<handel>   køberen har betalt (forsendelse)
//   afregning_saelger:<handel>   pengene er frigivet til sælgeren
//   afsluttet_koeber:<handel>    køberen: handlen er afsluttet
//   admin_refunderet_*:<handel>  BidHamr har refunderet og annulleret
//   refusion_forsinket:<refund>  en refusion fejlede hos Stripe og prøves igen
import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { bygKvittering } from "@/lib/betaling/kvittering";
import { koeberKvitteringMail, kronerFraOere, saelgerAfregningMail } from "@/lib/mails/handel";
import type { KoeberKvittering, SaelgerKvittering } from "@/lib/kvittering";

type Admin = ReturnType<typeof createAdminClient>;

// Billigt forhåndstjek, så cron (overfoerVentende kalder overfoerTilSaelger
// igen og igen for betalinger, der venter på en udbetalingskonto) ikke bygger
// kvitteringen hver gang. send() claimer stadig nøglen atomisk.
async function alleredeSendt(admin: Admin, noegle: string): Promise<boolean> {
  const { data, error } = await admin
    .from("notifikation_afsendelser")
    .select("noegle")
    .eq("noegle", noegle)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
}

async function titelFor(admin: Admin, tradeId: string): Promise<string> {
  const { data: t } = await admin
    .from("trades")
    .select("auction_id")
    .eq("id", tradeId)
    .maybeSingle<{ auction_id: string }>();
  if (!t) return "din vare";
  const { data: a } = await admin
    .from("auctions")
    .select("titel")
    .eq("id", t.auction_id)
    .maybeSingle<{ titel: string | null }>();
  return a?.titel ?? "din vare";
}

// --- Køberen har betalt -------------------------------------------------------

// Henter køberens kvittering til afhentningsmailen (eller null).
export async function koeberKvittering(tradeId: string): Promise<KoeberKvittering | null> {
  try {
    const k = await bygKvittering(tradeId, "koeber");
    return k?.rolle === "koeber" ? k : null;
  } catch (err) {
    console.error("Kvittering kunne ikke bygges:", tradeId, err);
    return null;
  }
}

// Kvittering til køberen, når betalingen er modtaget (forsendelse).
export async function sendKoeberKvittering(tradeId: string, koeberId: string): Promise<void> {
  try {
    const k = await koeberKvittering(tradeId);
    if (!k) return;
    await send(koeberId, "betaling_modtaget", {
      titel: "Kvittering for dit køb",
      tekst: `Tak for din betaling for "${k.titel}". Du har betalt ${kronerFraOere(k.totalOere)} kr. Sælgeren får besked om at sende varen. Din kvittering ligger på handelssiden.`,
      link: `/mine-handler/${tradeId}`,
      data: { trade_id: tradeId },
      mail: koeberKvitteringMail(k),
      noegle: `kvittering_koeber:${tradeId}`,
    });
  } catch (err) {
    console.error("Kvittering til køber fejlede:", tradeId, err);
  }
}

// --- Pengene er frigivet til sælgeren -----------------------------------------

export type FrigivGrund =
  | "godkendt" // køberen godkendte varen
  | "afhentet" // sælgeren tastede køberens afhentningskode
  | "automatisk_48" // 48 timer efter "modtaget" uden sag
  | "automatisk_14" // 14 dage efter afsendelse uden "modtaget" eller sag
  | "bidhamr" // admin frigav handlen
  | "sag" // sagen blev afgjort til sælgerens fordel
  | "standard"; // ukendt (fallback fra overførslen)

function afregningTekst(grund: FrigivGrund, titel: string): { titel: string; tekst: string } {
  switch (grund) {
    case "godkendt":
      return {
        titel: "Køberen har godkendt varen",
        tekst: `Køberen har godkendt "${titel}", og handlen er afsluttet.`,
      };
    case "afhentet":
      return {
        titel: "Handlen er afsluttet",
        tekst: `Du har bekræftet køberens afhentningskode, og handlen om "${titel}" er afsluttet.`,
      };
    case "automatisk_48":
      return {
        titel: "Handlen er afsluttet automatisk",
        tekst: `Der er gået 48 timer, siden køberen modtog "${titel}", uden at der er oprettet en sag. Handlen er afsluttet.`,
      };
    case "automatisk_14":
      return {
        titel: "Handlen er afsluttet automatisk",
        tekst: `Der er gået 14 dage, siden du sendte "${titel}", uden at køberen har markeret pakken som modtaget eller oprettet en sag. Handlen er afsluttet.`,
      };
    case "bidhamr":
      return {
        titel: "Pengene er frigivet",
        tekst: `BidHamr har afsluttet handlen om "${titel}".`,
      };
    case "sag":
      return {
        titel: "Handlen er afsluttet",
        tekst: `Sagen om "${titel}" er afgjort til din fordel, og handlen er afsluttet.`,
      };
    default:
      return {
        titel: "Handlen er afsluttet",
        tekst: `Handlen om "${titel}" er afsluttet.`,
      };
  }
}

// Afregning til sælgeren. Sendes kun, når pengene faktisk er frigivet
// (bygKvittering kræver frigivet_kl, status 'betalt' og ingen refusion) - og
// ikke ved en åben indsigelse, annulleret handel eller åben sag (samme værn
// som overfoerTilSaelger). Én gang pr. handel, uanset hvilken vej der frigav.
// Kalderne sender den FØR overførslen, så grunden kommer med; overførslen
// sender den generiske udgave som fallback.
export async function sendSaelgerAfregning(tradeId: string, grund: FrigivGrund): Promise<void> {
  const noegle = `afregning_saelger:${tradeId}`;
  try {
    const admin = createAdminClient();
    if (await alleredeSendt(admin, noegle)) return;

    const [{ data: b }, { data: t }] = await Promise.all([
      admin
        .from("betalinger")
        .select("seller_id, indsigelse_kl, indsigelse_status")
        .eq("trade_id", tradeId)
        .maybeSingle<{ seller_id: string; indsigelse_kl: string | null; indsigelse_status: string | null }>(),
      admin
        .from("trades")
        .select("status, sag_aaben")
        .eq("id", tradeId)
        .maybeSingle<{ status: string; sag_aaben: boolean | null }>(),
    ]);
    if (!b || !t || t.status === "annulleret" || t.sag_aaben) return;
    // Samme regel som indsigelseBlokerer (stripeBetaling.ts).
    if (b.indsigelse_kl && !["won", "warning_closed", "prevented"].includes(b.indsigelse_status ?? "")) {
      return;
    }

    const k = await bygKvittering(tradeId, "saelger");
    if (!k || k.rolle !== "saelger") return;
    const tekst = afregningTekst(grund, k.titel);
    await send(b.seller_id, "udbetaling", {
      titel: tekst.titel,
      // Intet løfte om, at pengene er i banken: afregningen sendes, før
      // overførslen er låst (en refusion, indsigelse, genåbnet sag eller
      // lukket udbetalingskonto kan stadig komme imellem).
      tekst: `${tekst.tekst} Pengene er frigivet. Udbetalingen på ${kronerFraOere(k.udbetalingOere)} kr (salgsprisen minus 5 % i sælgergebyr) sendes til din udbetalingskonto hos vores betalingspartner Stripe. Din afregning ligger på handelssiden.`,
      link: `/mine-handler/${tradeId}`,
      data: { trade_id: tradeId },
      mail: saelgerAfregningMail(k as SaelgerKvittering, tekst.titel, tekst.tekst),
      noegle,
    });
  } catch (err) {
    console.error("Afregning til sælger fejlede:", tradeId, err);
  }
}

// --- Køberen: handlen er afsluttet --------------------------------------------

export async function sendKoeberAfsluttet(
  tradeId: string,
  grund: "godkendt" | "afhentet" | "bidhamr",
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: t } = await admin
      .from("trades")
      .select("buyer_id")
      .eq("id", tradeId)
      .maybeSingle<{ buyer_id: string }>();
    if (!t) return;
    const titel = await titelFor(admin, tradeId);
    const tekst =
      grund === "godkendt"
        ? `Du har godkendt "${titel}", og handlen er afsluttet. Pengene er frigivet til sælgeren. Din kvittering ligger på handelssiden.`
        : grund === "afhentet"
          ? `Sælgeren har bekræftet din afhentningskode, og handlen om "${titel}" er afsluttet. Pengene er frigivet til sælgeren. Din kvittering ligger på handelssiden.`
          : `BidHamr har afsluttet handlen om "${titel}", og pengene er frigivet til sælgeren. Din kvittering ligger på handelssiden.`;
    await send(t.buyer_id, grund === "bidhamr" ? "sag" : "pakke_leveret", {
      titel: grund === "bidhamr" ? "Handlen er afsluttet af BidHamr" : "Tak for handlen",
      tekst,
      link: `/mine-handler/${tradeId}`,
      data: { trade_id: tradeId },
      noegle: `afsluttet_koeber:${tradeId}`,
    });
  } catch (err) {
    console.error("Besked om afsluttet handel til køber fejlede:", tradeId, err);
  }
}

// --- BidHamr har refunderet og annulleret handlen (uden sag) ------------------

export async function sendAdminRefunderet(tradeId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: b } = await admin
      .from("betalinger")
      .select("buyer_id, seller_id, total_oere, refusion_oere")
      .eq("trade_id", tradeId)
      .maybeSingle<{ buyer_id: string; seller_id: string; total_oere: number; refusion_oere: number | null }>();
    if (!b) return;
    const titel = await titelFor(admin, tradeId);
    const link = `/mine-handler/${tradeId}`;
    const beloeb = kronerFraOere(Number(b.refusion_oere ?? b.total_oere));
    await send(b.buyer_id, "sag", {
      titel: "Du får pengene tilbage",
      tekst: `BidHamr har annulleret handlen om "${titel}". Du får ${beloeb} kr tilbage på den betalingsmetode, du betalte med. Der kan gå nogle dage, før pengene står på din konto. Betalingen håndteres af vores betalingspartner Stripe.`,
      link,
      data: { trade_id: tradeId },
      noegle: `admin_refunderet_koeber:${tradeId}`,
    });
    await send(b.seller_id, "sag", {
      titel: "Handlen er annulleret af BidHamr",
      tekst: `BidHamr har annulleret handlen om "${titel}", og køberen får pengene tilbage. Har du ikke sendt varen endnu, skal du ikke sende den. Har du spørgsmål, så skriv til support@bidhamr.dk.`,
      link,
      data: { trade_id: tradeId },
      noegle: `admin_refunderet_saelger:${tradeId}`,
    });
  } catch (err) {
    console.error("Besked om refusion fejlede:", tradeId, err);
  }
}

// --- Refusionen fejlede hos Stripe og prøves igen -----------------------------

export async function sendRefusionForsinket(betalingId: string, refundId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: b } = await admin
      .from("betalinger")
      .select("trade_id, buyer_id")
      .eq("id", betalingId)
      .maybeSingle<{ trade_id: string; buyer_id: string }>();
    if (!b) return;
    const titel = await titelFor(admin, b.trade_id);
    await send(b.buyer_id, "sag", {
      titel: "Dine penge er lidt forsinket",
      tekst: `Tilbagebetalingen for "${titel}" gik ikke igennem i første forsøg hos vores betalingspartner Stripe. Vi prøver igen – du behøver ikke gøre noget.`,
      link: `/mine-handler/${b.trade_id}`,
      data: { trade_id: b.trade_id },
      noegle: `refusion_forsinket:${refundId}`,
    });
  } catch (err) {
    console.error("Besked om forsinket refusion fejlede:", betalingId, err);
  }
}
