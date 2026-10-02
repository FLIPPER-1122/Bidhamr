import "server-only";

// Server-only hjælpere til sager: notifikationer og afvikling af afgørelser
// efter ankefristen. Bruges af server actions (src/app/actions/sager.ts,
// adminSager.ts) og cron.
import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { overfoerTilSaelger, refunderBetaling } from "@/lib/betaling/stripeBetaling";
import {
  SAG_TYPE_NAVN,
  type SagPengeHandling,
  type SagType,
  erSagType,
  sagSti,
} from "@/lib/sager";

type Admin = ReturnType<typeof createAdminClient>;

async function handelOgTitel(admin: Admin, tradeId: string) {
  const { data: t } = await admin
    .from("trades")
    .select("buyer_id, seller_id, auction_id")
    .eq("id", tradeId)
    .maybeSingle<{ buyer_id: string; seller_id: string; auction_id: string }>();
  if (!t) return null;
  const [{ data: a }, { data: b }] = await Promise.all([
    admin.from("auctions").select("titel").eq("id", t.auction_id).maybeSingle(),
    admin.from("betalinger").select("beskyttelse").eq("trade_id", tradeId).maybeSingle(),
  ]);
  return {
    ...t,
    titel: (a?.titel as string | undefined) ?? "din vare",
    beskyttelse: !!(b?.beskyttelse as boolean | undefined),
  };
}

// Tidspunkt til beskeder, fx "tirsdag den 7. oktober kl. 14.05". Fast
// tidszone, så tidspunktet er dansk uanset serverens zone.
export function sagFristTekst(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString("da-DK", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

// "Sag oprettet" til køber og sælger. Claimes atomisk (sager.notificeret_kl),
// så den sendes præcis én gang - også for sager oprettet direkte fra appen
// (cron samler op). Kaster aldrig.
export async function notificerSagOprettet(sagId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data: sag } = await admin
      .from("sager")
      .update({ notificeret_kl: new Date().toISOString() })
      .eq("id", sagId)
      .is("notificeret_kl", null)
      .select("id, trade_id, type")
      .maybeSingle<{ id: string; trade_id: string; type: string }>();
    if (!sag || !erSagType(sag.type)) return false;
    const h = await handelOgTitel(admin, sag.trade_id);
    if (!h) return false;
    const hvad = SAG_TYPE_NAVN[sag.type].toLowerCase();
    const link = sagSti(sag.trade_id);
    const data = { trade_id: sag.trade_id, sag_id: sag.id };
    await send(h.buyer_id, "sag", {
      titel: "Din sag er oprettet",
      tekst: `Vi har modtaget din sag om "${h.titel}" (${hvad}). Pengene holdes tilbage, mens BidHamr kigger på sagen.`,
      link,
      data,
      noegle: `sag_oprettet_koeber:${sag.id}`,
    });
    await send(h.seller_id, "sag", {
      titel: "Køberen har oprettet en sag",
      tekst: `Køberen har oprettet en sag om "${h.titel}" (${hvad}). Udbetalingen venter, til BidHamr har afgjort sagen.`,
      link,
      data,
      noegle: `sag_oprettet_saelger:${sag.id}`,
    });
    return true;
  } catch (err) {
    console.error("Notifikation om ny sag fejlede:", sagId, err);
    return false;
  }
}

// Cron: sager fra de seneste 7 dage, der ikke er notificeret endnu.
export async function notificerNyeSager(): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("sager")
    .select("id")
    .is("notificeret_kl", null)
    .gte("oprettet_kl", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .limit(100);
  if (error) {
    console.error("Hentning af nye sager fejlede:", error.message);
    return 0;
  }
  let antal = 0;
  for (const { id } of (data ?? []) as { id: string }[]) {
    if (await notificerSagOprettet(id)) antal++;
  }
  return antal;
}

export type SagUdfaldBesked =
  // Ved afgørelsen (pengene flyttes efter ankefristen på 4 dage).
  | "planlagt_refusion"
  | "afvent_retur"
  | "planlagt_frigivelse"
  | "lukket"
  // Staff har registreret returpakken (refusion efter fristen).
  | "retur_afleveret"
  // Når pengene faktisk er flyttet (efter ankefristen).
  | "refunderet"
  | "frigivet"
  | "genaabnet";

// Besked til køber og sælger om en sag. Begrundelsen fra staff medsendes
// (den er skrevet til parterne). Beløb nævnes aldrig. Kaster aldrig.
export async function notificerSagAfgoerelse(
  sagId: string,
  tradeId: string,
  type: SagType,
  udfald: SagUdfaldBesked,
  begrundelse: string | null,
  // sager.genaabnet_antal efter handlingen. Samme udfald kan kun ske igen
  // efter en genåbning, så nøglen er unik pr. afgørelse.
  version: number,
  // sager.penge_flyttes_efter_kl - hvornår pengene tidligst flyttes.
  fristKl: string | null = null,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const h = await handelOgTitel(admin, tradeId);
    if (!h) return;
    const link = sagSti(tradeId);
    const data = { trade_id: tradeId, sag_id: sagId };
    const grund = begrundelse ? ` Begrundelse: ${begrundelse}` : "";
    const t = h.titel;
    const dato = fristKl ? sagFristTekst(fristKl) : "";
    const tidligst = dato ? ` tidligst ${dato}` : " efter ankefristen på 4 dage";
    const holdes = dato ? ` til ${dato}` : " i 4 dage";
    const forbehold = ", medmindre sagen genoptages";
    // Kun køberen får sin BidHamr Beskyttelse nævnt - sælgeren får det aldrig at vide.
    const undtagen = h.beskyttelse ? ", undtagen BidHamr Beskyttelse" : "";

    const tekster: Record<SagUdfaldBesked, { koeber: [string, string]; saelger: [string, string] }> = {
      planlagt_refusion: {
        koeber: ["Du har fået medhold i din sag", `BidHamr har afgjort sagen om "${t}" til din fordel. Du får pengene retur${undtagen}. Pengene refunderes${tidligst}${forbehold}.${grund}`],
        saelger: ["Sagen er afgjort", `BidHamr har afgjort sagen om "${t}" til køberens fordel. Køberen får pengene retur${tidligst}${forbehold}, og handlen annulleres.${grund}`],
      },
      afvent_retur: {
        koeber: ["Send varen retur", `BidHamr har afgjort sagen om "${t}" til din fordel. Send varen retur til sælgeren - BidHamr betaler returfragten. Du får pengene retur${undtagen}, når returpakken er afleveret -${tidligst}${forbehold}.${grund}`],
        saelger: ["Varen sendes retur", `BidHamr har afgjort sagen om "${t}" til køberens fordel. Køberen sender varen retur til dig - BidHamr betaler returfragten. Køberen får pengene retur, når returpakken er afleveret -${tidligst}${forbehold}.${grund}`],
      },
      planlagt_frigivelse: {
        koeber: ["Sagen er afgjort", `BidHamr har afgjort sagen om "${t}" til sælgerens fordel. Pengene udbetales til sælgeren${tidligst}${forbehold}.${grund}`],
        saelger: ["Du har fået medhold i sagen", `BidHamr har afgjort sagen om "${t}" til din fordel. Pengene udbetales til dig${tidligst}${forbehold}.${grund}`],
      },
      lukket: {
        koeber: ["Sagen er lukket", `BidHamr har lukket sagen om "${t}". Pengene holdes tilbage${holdes}${forbehold}. Derefter fortsætter handlen som normalt.${grund}`],
        saelger: ["Sagen er lukket", `BidHamr har lukket sagen om "${t}". Pengene holdes tilbage${holdes}${forbehold}. Derefter fortsætter handlen som normalt.${grund}`],
      },
      retur_afleveret: {
        koeber: ["Returpakken er afleveret", `Returpakken med "${t}" er afleveret. Du får pengene retur${undtagen}${tidligst}${forbehold}.`],
        saelger: ["Returpakken er afleveret", `Returpakken med "${t}" er afleveret. Køberen får pengene retur${tidligst}${forbehold}, og handlen annulleres.`],
      },
      refunderet: {
        koeber: ["Pengene er på vej retur", `Pengene for "${t}" er sendt retur til dig${undtagen}. Det kan tage nogle dage, før de står på din konto. Betalingen håndteres af vores betalingspartner Stripe.`],
        saelger: ["Handlen er annulleret", `Køberen har fået pengene for "${t}" retur efter sagens afgørelse, og handlen er annulleret.`],
      },
      frigivet: {
        koeber: ["Sagen er afsluttet", `Pengene for "${t}" er frigivet til sælgeren efter sagens afgørelse.`],
        saelger: ["Pengene er frigivet", `Pengene for "${t}" er frigivet efter sagens afgørelse og bliver udbetalt til din udbetalingskonto hos vores betalingspartner Stripe.`],
      },
      genaabnet: {
        koeber: ["Sagen er genåbnet", `BidHamr har genåbnet sagen om "${t}". Den tidligere afgørelse er sat på pause, og pengene holdes tilbage, til sagen er afgjort igen.`],
        saelger: ["Sagen er genåbnet", `BidHamr har genåbnet sagen om "${t}". Den tidligere afgørelse er sat på pause, og udbetalingen venter, til sagen er afgjort igen.`],
      },
    };

    const tekst = tekster[udfald];
    await send(h.buyer_id, "sag", {
      titel: tekst.koeber[0],
      tekst: tekst.koeber[1],
      link,
      data,
      noegle: `sag_${udfald}_koeber:${sagId}:${version}`,
    });
    await send(h.seller_id, "sag", {
      titel: tekst.saelger[0],
      tekst: tekst.saelger[1],
      link,
      data,
      noegle: `sag_${udfald}_saelger:${sagId}:${version}`,
    });
  } catch (err) {
    console.error("Notifikation om afgørelse fejlede:", sagId, err);
  }
}

// ------------------------------------------------------------------ Ankefrist

// Svar fra sag_afvikl / sag_afvikl_forfaldne (kode 'ok').
export type SagAfvikling = {
  sag_id: string;
  betaling_id: string | null;
  trade_id: string;
  type: string;
  version: number;
  handling: SagPengeHandling;
};

// Kører Stripe-delen, efter sag_afvikl har flyttet pengene i databasen, og
// giver parterne besked. Kaster aldrig: refusionen/frigivelsen er claimet i
// databasen, og cron prøver Stripe igen (refunderSagerVentende /
// overfoerVentende). Returnerer resultatet fra Stripe-kaldet (uden beløb).
export async function udfoerSagAfvikling(a: SagAfvikling): Promise<string> {
  let status = "intet";
  if (a.handling === "refunder" && a.betaling_id) {
    try {
      status = await refunderBetaling(a.betaling_id);
    } catch (err) {
      console.error("Sagsrefusion efter ankefristen fejlede (cron prøver igen):", a.betaling_id, err);
      status = "refusion_fejlede";
    }
  } else if (a.handling === "frigiv" && a.betaling_id) {
    try {
      status = await overfoerTilSaelger(a.betaling_id);
    } catch (err) {
      console.error("Overførsel efter ankefristen fejlede (cron prøver igen):", a.betaling_id, err);
      status = "overfoersel_fejlede";
    }
  }
  if (erSagType(a.type) && (a.handling === "refunder" || a.handling === "frigiv")) {
    await notificerSagAfgoerelse(
      a.sag_id,
      a.trade_id,
      a.type,
      a.handling === "refunder" ? "refunderet" : "frigivet",
      null,
      Number(a.version ?? 0),
    );
  }
  return status;
}

// Cron: afgjorte sager, hvor ankefristen (4 dage) er udløbet. Databasen
// flytter pengene atomisk (sag_afvikl_forfaldne), derefter kaldes Stripe.
export async function afviklForfaldneSager(): Promise<number> {
  const { data, error } = await createAdminClient().rpc("sag_afvikl_forfaldne");
  if (error) {
    console.error("sag_afvikl_forfaldne fejlede:", error.message);
    return 0;
  }
  const liste = (Array.isArray(data) ? data : []) as SagAfvikling[];
  for (const a of liste) await udfoerSagAfvikling(a);
  return liste.length;
}
