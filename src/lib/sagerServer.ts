import "server-only";

// Server-only hjælpere til sager: notifikationer og afvikling af afgørelser
// efter ankefristen. Bruges af server actions (src/app/actions/sager.ts,
// adminSager.ts) og cron.
import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { overfoerTilSaelger, refunderBetaling } from "@/lib/betaling/stripeBetaling";
import { sendSaelgerAfregning } from "@/lib/betaling/handelsbeskeder";
import {
  SAG_TYPE_NAVN,
  type SagPengeHandling,
  type SagType,
  erSagType,
  sagLink,
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
    const link = sagLink(sag.trade_id);
    const data = { trade_id: sag.trade_id, sag_id: sag.id };
    await send(h.buyer_id, "sag", {
      titel: "Din sag er oprettet",
      tekst: `Vi har modtaget din sag om "${h.titel}" (${hvad}). Sælgeren får ikke pengene udbetalt, mens BidHamr kigger på sagen. Vi vender tilbage hurtigst muligt.`,
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
    const link = sagLink(tradeId);
    const data = { trade_id: tradeId, sag_id: sagId };
    const grund = begrundelse ? ` Begrundelse: ${begrundelse}` : "";
    const t = h.titel;
    const dato = fristKl ? sagFristTekst(fristKl) : "";
    const tidligst = dato ? ` – tidligst ${dato}` : " efter ankefristen på 4 dage";
    const fortsaetter = dato ? ` efter ${dato}` : " om 4 dage";
    const forbehold = ", medmindre sagen genåbnes";
    // Det køberen får tilbage ved medhold. Returfragten betaler køberen selv
    // direkte til fragtfirmaet - den trækkes ikke fra refusionen.
    // Kun køberen får sin BidHamr Beskyttelse nævnt - sælgeren får det aldrig at vide.
    const hvad = h.beskyttelse ? "pengene for varen, gebyret og fragten" : "alle pengene";
    const beskyttelseNote = h.beskyttelse ? " BidHamr Beskyttelse refunderes ikke." : "";

    const tekster: Record<SagUdfaldBesked, { koeber: [string, string]; saelger: [string, string] }> = {
      planlagt_refusion: {
        koeber: ["Du har fået medhold i din sag", `BidHamr har afgjort sagen om "${t}" til din fordel. Du får ${hvad} tilbage${tidligst}${forbehold}.${beskyttelseNote}${grund}`],
        saelger: ["Sagen er afgjort", `BidHamr har afgjort sagen om "${t}" til køberens fordel. Køberen får pengene tilbage${tidligst}${forbehold}, og handlen annulleres.${grund}`],
      },
      afvent_retur: {
        koeber: ["Send varen retur", `BidHamr har afgjort sagen om "${t}" til din fordel. Send varen retur til sælgeren. Du betaler selv returfragten. Når pakken er afleveret, får du ${hvad} tilbage${tidligst}${forbehold}.${beskyttelseNote}${grund}`],
        saelger: ["Varen sendes retur", `BidHamr har afgjort sagen om "${t}" til køberens fordel. Køberen sender varen retur til dig og betaler selv returfragten. Når pakken er afleveret, får køberen pengene tilbage${tidligst}${forbehold}.${grund}`],
      },
      planlagt_frigivelse: {
        koeber: ["Sagen er afgjort", `BidHamr har afgjort sagen om "${t}" til sælgerens fordel. Pengene udbetales til sælgeren${tidligst}${forbehold}.${grund}`],
        saelger: ["Du har fået medhold i sagen", `BidHamr har afgjort sagen om "${t}" til din fordel. Pengene udbetales til dig${tidligst}${forbehold}.${grund}`],
      },
      lukket: {
        koeber: ["Sagen er lukket", `BidHamr har lukket sagen om "${t}". Handlen fortsætter som normalt${fortsaetter}${forbehold}.${grund}`],
        saelger: ["Sagen er lukket", `BidHamr har lukket sagen om "${t}". Handlen fortsætter som normalt${fortsaetter}${forbehold}.${grund}`],
      },
      retur_afleveret: {
        koeber: ["Returpakken er afleveret", `Returpakken med "${t}" er afleveret. Du får ${hvad} tilbage${tidligst}${forbehold}.${beskyttelseNote}`],
        saelger: ["Returpakken er afleveret", `Returpakken med "${t}" er afleveret. Køberen får pengene tilbage${tidligst}${forbehold}, og handlen annulleres.`],
      },
      refunderet: {
        koeber: ["Pengene er på vej tilbage", `Pengene for "${t}" er sendt tilbage til dig.${beskyttelseNote} Der kan gå nogle dage, før de står på din konto. Betalingen håndteres af vores betalingspartner Stripe.`],
        saelger: ["Handlen er annulleret", `Køberen har fået pengene for "${t}" tilbage efter sagens afgørelse, og handlen er annulleret.`],
      },
      frigivet: {
        koeber: ["Sagen er afsluttet", `Pengene for "${t}" er udbetalt til sælgeren efter sagens afgørelse.`],
        saelger: ["Pengene er på vej til dig", `Pengene for "${t}" bliver nu udbetalt til din udbetalingskonto hos vores betalingspartner Stripe.`],
      },
      genaabnet: {
        koeber: ["Sagen er genåbnet", `BidHamr har genåbnet sagen om "${t}". Den tidligere afgørelse er sat på pause, til sagen er afgjort igen.`],
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
    // Afregning til sælgeren før overførslen (kaster aldrig).
    await sendSaelgerAfregning(a.trade_id, "sag");
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

// ------------------------------------------------------------------ Anke

type AnkeRaekke = {
  id: string;
  sag_id: string;
  trade_id: string;
  part: "koeber" | "saelger";
  ankede_status: string;
};

// "Anke indgivet" til begge parter. Claimes atomisk (sag_anker.notificeret_kl),
// så den sendes præcis én gang - også for anker indgivet direkte fra appen
// (cron samler op). Kaster aldrig.
export async function notificerAnkeIndgivet(ankeId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data: a } = await admin
      .from("sag_anker")
      .update({ notificeret_kl: new Date().toISOString() })
      .eq("id", ankeId)
      .is("notificeret_kl", null)
      .select("id, sag_id, trade_id, part, ankede_status")
      .maybeSingle<AnkeRaekke>();
    if (!a) return false;
    const h = await handelOgTitel(admin, a.trade_id);
    if (!h) return false;
    const link = sagLink(a.trade_id);
    const data = { trade_id: a.trade_id, sag_id: a.sag_id };
    const t = h.titel;
    const venter = "Pengene flyttes ikke, mens anken behandles.";
    const anden = "En anden medarbejder end den, der afgjorde sagen, ser på den igen.";
    // Sælgeren har anket et medhold til køberen, hvor varen skal sendes retur.
    const returPause =
      a.part === "saelger" && a.ankede_status === "afventer_retur"
        ? " Vent med at sende varen retur, til anken er afgjort."
        : "";

    const ankendeId = a.part === "koeber" ? h.buyer_id : h.seller_id;
    const andenId = a.part === "koeber" ? h.seller_id : h.buyer_id;
    const hvem = a.part === "koeber" ? "Køberen" : "Sælgeren";
    await send(ankendeId, "sag", {
      titel: "Vi har modtaget din anke",
      tekst: `Vi har modtaget din anke af afgørelsen i sagen om "${t}". ${anden} ${venter} Afgørelsen på anken er endelig.`,
      link,
      data,
      noegle: `sag_anke_indgivet_${a.part}:${a.id}`,
    });
    await send(andenId, "sag", {
      titel: "Afgørelsen er anket",
      tekst: `${hvem} har anket afgørelsen i sagen om "${t}". ${anden} ${venter}${returPause}`,
      link,
      data,
      noegle: `sag_anke_indgivet_${a.part === "koeber" ? "saelger" : "koeber"}:${a.id}`,
    });
    return true;
  } catch (err) {
    console.error("Notifikation om anke fejlede:", ankeId, err);
    return false;
  }
}

// Cron: anker fra de seneste 7 dage, der ikke er notificeret endnu.
export async function notificerNyeAnker(): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("sag_anker")
    .select("id")
    .is("notificeret_kl", null)
    .gte("indgivet_kl", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .limit(100);
  if (error) {
    console.error("Hentning af nye anker fejlede:", error.message);
    return 0;
  }
  let antal = 0;
  for (const { id } of (data ?? []) as { id: string }[]) {
    if (await notificerAnkeIndgivet(id)) antal++;
  }
  return antal;
}

// Hvad der nu sker med pengene efter ankens afgørelse:
//   'koeber_retur'  - køberen har medhold og skal sende varen retur
//   'koeber'        - køberen får pengene tilbage
//   'saelger'       - sælgeren får pengene
export type AnkeSlutUdfald = "koeber" | "koeber_retur" | "saelger";

// "Anke afgjort" til begge parter. Begrundelsen fra BidHamr medsendes. Beløb
// nævnes aldrig. Kaster aldrig.
export async function notificerAnkeAfgjort(
  ankeId: string,
  tradeId: string,
  sagId: string,
  part: "koeber" | "saelger",
  udfald: "stadfaest" | "omgoer",
  slut: AnkeSlutUdfald,
  begrundelse: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const h = await handelOgTitel(admin, tradeId);
    if (!h) return;
    const link = sagLink(tradeId);
    const data = { trade_id: tradeId, sag_id: sagId };
    const t = h.titel;
    const grund = begrundelse ? ` Begrundelse: ${begrundelse}` : "";
    const endelig = "Afgørelsen er endelig.";
    // Kun køberen får sin BidHamr Beskyttelse nævnt - sælgeren får det aldrig at vide.
    const hvad = h.beskyttelse ? "pengene for varen, gebyret og fragten" : "alle pengene";
    const beskyttelseNote = h.beskyttelse ? " BidHamr Beskyttelse refunderes ikke." : "";

    const penge: Record<AnkeSlutUdfald, { koeber: string; saelger: string }> = {
      koeber: {
        koeber: `Du får ${hvad} tilbage nu.${beskyttelseNote}`,
        saelger: "Køberen får pengene tilbage, og handlen annulleres.",
      },
      koeber_retur: {
        koeber: `Send varen retur til sælgeren. Du betaler selv returfragten. Når pakken er afleveret, får du ${hvad} tilbage.${beskyttelseNote}`,
        saelger: "Køberen sender varen retur til dig og betaler selv returfragten. Når pakken er afleveret, får køberen pengene tilbage.",
      },
      saelger: {
        koeber: "Pengene udbetales til sælgeren.",
        saelger: "Pengene udbetales til dig nu.",
      },
    };

    const ankende = part;
    const tekst = (rolle: "koeber" | "saelger"): [string, string] => {
      const p = penge[slut][rolle];
      if (rolle === ankende) {
        return udfald === "omgoer"
          ? ["Du har fået medhold i din anke", `BidHamr har set på sagen om "${t}" igen og ændret afgørelsen til din fordel. ${p} ${endelig}${grund}`]
          : ["Din anke er afgjort", `BidHamr har set på sagen om "${t}" igen, og afgørelsen står ved magt. ${p} ${endelig}${grund}`];
      }
      return udfald === "omgoer"
        ? ["Afgørelsen er ændret", `BidHamr har behandlet anken i sagen om "${t}" og ændret afgørelsen. ${p} ${endelig}${grund}`]
        : ["Anken er afgjort", `BidHamr har behandlet anken i sagen om "${t}", og afgørelsen står ved magt. ${p} ${endelig}${grund}`];
    };

    const [kt, kx] = tekst("koeber");
    const [st, sx] = tekst("saelger");
    await send(h.buyer_id, "sag", {
      titel: kt,
      tekst: kx,
      link,
      data,
      noegle: `sag_anke_afgjort_koeber:${ankeId}`,
    });
    await send(h.seller_id, "sag", {
      titel: st,
      tekst: sx,
      link,
      data,
      noegle: `sag_anke_afgjort_saelger:${ankeId}`,
    });
  } catch (err) {
    console.error("Notifikation om ankens afgørelse fejlede:", ankeId, err);
  }
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
