import "server-only";

// Server-only hjælpere til sager: notifikationer og afvikling af afgørelser
// efter ankefristen. Bruges af server actions (src/app/actions/sager.ts,
// adminSager.ts) og cron.
import { createAdminClient } from "@/lib/supabase/admin";
import { send, type SendResultat } from "@/lib/notifikationer/send";
import { overfoerTilSaelger, refunderBetaling } from "@/lib/betaling/stripeBetaling";
import { sendSaelgerAfregning } from "@/lib/betaling/handelsbeskeder";
import {
  SAG_RETUR_VENTETID_DAGE,
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

// Ventetid ved retur (SAG_RETUR_VENTETID_DAGE): sender køberen ikke varen
// inden 7 dage efter beskeden, kan BidHamr afgøre sagen til sælgerens fordel.
const RETUR_FRIST_NOTE = `Send varen inden ${SAG_RETUR_VENTETID_DAGE} dage – ellers kan BidHamr afgøre sagen til sælgerens fordel.`;

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
  | "genaabnet"
  // Cron: ankefristen er udløbet uden anke - køberen kan sende varen retur nu.
  | "retur_kan_sendes";

export type SagAfgoerelseValg = {
  // Sagen er anket, og ankeafgørelsen er endelig (sag_afgoer med en afgjort
  // anke, fx fordi køberen ikke sendte returen): ingen ny ankefrist, og sagen
  // kan ikke genåbnes.
  endelig?: boolean;
  // Kun med endelig: pengene er flyttet nu (sag_afvikl gennemførte). Ellers
  // flyttes de, så snart det er muligt (cron prøver igen).
  flyttetNu?: boolean;
  // Til cron: kan nøglen ikke claimes af ukendt årsag, sendes beskeden ikke
  // (se SendOptions.springOverVedClaimFejl) - næste kørsel prøver igen.
  springOverVedClaimFejl?: boolean;
};

// Besked til køber og sælger om en sag. Begrundelsen fra staff medsendes
// (den er skrevet til parterne). Beløb nævnes aldrig. Kaster aldrig.
// Returnerer true, når mindst én ny besked faktisk er leveret nu.
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
  valg: SagAfgoerelseValg = {},
): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const h = await handelOgTitel(admin, tradeId);
    if (!h) return false;
    const link = sagLink(tradeId);
    const data = { trade_id: tradeId, sag_id: sagId };
    const endelig = !!valg.endelig;
    // En endelig afgørelse (efter anke) har ingen ankefrist og kan ikke genåbnes.
    const grund = (endelig ? " Afgørelsen er endelig." : "") + (begrundelse ? ` Begrundelse: ${begrundelse}` : "");
    const t = h.titel;
    const dato = fristKl ? sagFristTekst(fristKl) : "";
    const tidligst = endelig
      ? valg.flyttetNu
        ? " nu"
        : ""
      : dato
        ? ` – tidligst ${dato}`
        : " efter ankefristen på 4 dage";
    const fortsaetter = endelig ? (valg.flyttetNu ? " nu" : "") : dato ? ` efter ${dato}` : " om 4 dage";
    const forbehold = endelig ? "" : ", medmindre sagen genåbnes";
    // Ankefristen, til køberen må sende varen retur (sælgeren kan anke indtil da).
    const ankefrist = dato ? ` ${dato}` : " om 4 dage";
    // Det køberen får tilbage ved medhold. Returfragten betaler køberen selv
    // direkte til fragtfirmaet - den trækkes ikke fra refusionen.
    // Kun køberen får sin BidHamr Beskyttelse nævnt - sælgeren får det aldrig at vide.
    const hvad = h.beskyttelse ? "pengene for varen, gebyret og fragten" : "alle pengene";
    const beskyttelseNote = h.beskyttelse ? " Prisen for BidHamr Beskyttelse får du ikke tilbage." : "";

    const tekster: Record<SagUdfaldBesked, { koeber: [string, string]; saelger: [string, string] }> = {
      planlagt_refusion: {
        koeber: ["Du har fået medhold i din sag", `BidHamr har afgjort sagen om "${t}" til din fordel. Du får ${hvad} tilbage${tidligst}${forbehold}.${beskyttelseNote}${grund}`],
        saelger: ["Sagen er afgjort", `BidHamr har afgjort sagen om "${t}" til køberens fordel. Køberen får pengene tilbage${tidligst}${forbehold}, og handlen annulleres.${grund}`],
      },
      // Sælgeren kan anke inden for 4 dage. Køberen venter med at sende
      // varen, til ankefristen er udløbet (cron sender "retur_kan_sendes"),
      // eller til BidHamr giver besked (ankens afgørelse) - ellers kunne en
      // omgørelse give sælgeren både varen og pengene.
      afvent_retur: {
        koeber: ["Du har fået medhold i din sag", `BidHamr har afgjort sagen om "${t}" til din fordel. Sælgeren kan anke afgørelsen inden for 4 dage. Vent med at sende varen retur, til ankefristen er udløbet${ankefrist}, eller til BidHamr giver dig besked. Du betaler selv returfragten. Når pakken er afleveret, får du ${hvad} tilbage${forbehold}.${beskyttelseNote}${grund}`],
        saelger: ["Varen sendes retur", `BidHamr har afgjort sagen om "${t}" til køberens fordel. Er du uenig, kan du anke afgørelsen inden for 4 dage. Køberen sender varen retur til dig, når ankefristen er udløbet${ankefrist}, og betaler selv returfragten. Når pakken er afleveret, får køberen pengene tilbage${forbehold}.${grund}`],
      },
      retur_kan_sendes: {
        koeber: ["Send varen retur nu", `Ankefristen i sagen om "${t}" er udløbet. Send varen retur til sælgeren nu. Du betaler selv returfragten. Når pakken er afleveret, får du ${hvad} tilbage.${beskyttelseNote} ${RETUR_FRIST_NOTE}`],
        saelger: ["Køberen sender varen retur", `Ankefristen i sagen om "${t}" er udløbet. Køberen sender nu varen retur til dig og betaler selv returfragten.`],
      },
      planlagt_frigivelse: {
        koeber: ["Sagen er afgjort", `BidHamr har afgjort sagen om "${t}" til sælgerens fordel. Pengene udbetales til sælgeren${tidligst}${forbehold}.${grund}`],
        saelger: ["Du har fået medhold i sagen", `BidHamr har afgjort sagen om "${t}" til din fordel. Pengene udbetales til dig${tidligst}${forbehold}.${grund}`],
      },
      lukket: {
        // Køberen fik afvist sin sag og kan anke (ikke ved en endelig afgørelse).
        koeber: ["Sagen er lukket", `BidHamr har lukket sagen om "${t}". Handlen fortsætter som normalt${fortsaetter}${forbehold}.${endelig ? "" : " Er du uenig, kan du anke afgørelsen inden for 4 dage."}${grund}`],
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
    // En endelig afgørelse efter anke har samme version som den oprindelige
    // afgørelse - egen nøgle, så den ikke bliver set som en dublet.
    const n = `sag_${udfald}${endelig ? "_endelig" : ""}`;
    const opts = { springOverVedClaimFejl: !!valg.springOverVedClaimFejl };
    const r1 = await send(
      h.buyer_id,
      "sag",
      {
        titel: tekst.koeber[0],
        tekst: tekst.koeber[1],
        link,
        data,
        noegle: `${n}_koeber:${sagId}:${version}`,
      },
      opts,
    );
    const r2 = await send(
      h.seller_id,
      "sag",
      {
        titel: tekst.saelger[0],
        tekst: tekst.saelger[1],
        link,
        data,
        noegle: `${n}_saelger:${sagId}:${version}`,
      },
      opts,
    );
    // Kun nye, faktisk leverede beskeder tæller (ikke dubletter fra en
    // tidligere kørsel og ikke sprungne).
    const nyLeveret = (r: SendResultat) => !r.dublet && !r.sprunget && (r.klokke || r.mail || r.push);
    return nyLeveret(r1) || nyLeveret(r2);
  } catch (err) {
    console.error("Notifikation om afgørelse fejlede:", sagId, err);
    return false;
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
// notificer: false, når kalderen selv sender én samlet besked (anke og
// endelig afgørelse efter anke), så parterne ikke får to beskeder.
export async function udfoerSagAfvikling(
  a: SagAfvikling,
  { notificer = true }: { notificer?: boolean } = {},
): Promise<string> {
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
  // "refusion_konflikt": en anden tilbagebetaling findes allerede hos Stripe,
  // og betalingen er markeret til admin. Parterne får ingen "refunderet"-besked,
  // før admin har tjekket den. ("refusion_i_gang": en anden kørsel gennemfører
  // tilbagebetalingen - beskeden sendes som normalt.)
  if (
    notificer &&
    status !== "refusion_konflikt" &&
    erSagType(a.type) &&
    (a.handling === "refunder" || a.handling === "frigiv")
  ) {
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

// Er beskeden leveret (eller allerede sendt før)? En nøgle, der ikke kunne
// claimes, eller en besked, der ikke nåede nogen kanal, prøves igen.
function leveret(r: SendResultat): boolean {
  if (r.dublet) return true;
  if (r.sprunget) return false;
  return r.klokke || r.mail || r.push;
}

// "Anke indgivet" til begge parter - også for anker indgivet direkte fra
// appen (cron samler op). Hver besked har en idempotent nøgle, så den sendes
// højst én gang. sag_anker.notificeret_kl sættes først, når begge beskeder er
// leveret - ellers prøver cron igen. Kaster aldrig.
export async function notificerAnkeIndgivet(ankeId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data: a } = await admin
      .from("sag_anker")
      .select("id, sag_id, trade_id, part, ankede_status")
      .eq("id", ankeId)
      .is("notificeret_kl", null)
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
    const r1 = await send(
      ankendeId,
      "sag",
      {
        titel: "Vi har modtaget din anke",
        tekst: `Vi har modtaget din anke af afgørelsen i sagen om "${t}". ${anden} ${venter} Afgørelsen på anken er endelig.`,
        link,
        data,
        noegle: `sag_anke_indgivet_${a.part}:${a.id}`,
      },
      { springOverVedClaimFejl: true },
    );
    const r2 = await send(
      andenId,
      "sag",
      {
        titel: "Afgørelsen er anket",
        tekst: `${hvem} har anket afgørelsen i sagen om "${t}". ${anden} ${venter}${returPause}`,
        link,
        data,
        noegle: `sag_anke_indgivet_${a.part === "koeber" ? "saelger" : "koeber"}:${a.id}`,
      },
      { springOverVedClaimFejl: true },
    );
    if (!leveret(r1) || !leveret(r2)) return false;
    // Claim efter vellykket afsendelse (nøglerne forhindrer dubletter, hvis
    // to kørsler når hertil samtidig).
    const { data: sat } = await admin
      .from("sag_anker")
      .update({ notificeret_kl: new Date().toISOString() })
      .eq("id", a.id)
      .is("notificeret_kl", null)
      .select("id")
      .maybeSingle();
    return !!sat;
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

// Cron: medhold til køber med retur, hvor ankefristen er udløbet uden anke.
// Køberen fik besked om at vente med at sende varen til fristen; nu får
// begge parter besked om, at returen kan sendes. Nøglen (pr. sag og version)
// gør det idempotent; sager med en anke springes over (ankens afgørelse giver
// selv besked). Ser 3 dage tilbage, så en mistet kørsel indhentes.
export async function notificerReturKanSendes(): Promise<number> {
  const admin = createAdminClient();
  const nu = Date.now();
  const { data, error } = await admin
    .from("sager")
    .select("id, trade_id, type, genaabnet_antal")
    .eq("status", "afventer_retur")
    .is("retur_afleveret_kl", null)
    .lte("penge_flyttes_efter_kl", new Date(nu).toISOString())
    .gte("penge_flyttes_efter_kl", new Date(nu - 3 * 24 * 60 * 60 * 1000).toISOString())
    .limit(100);
  if (error) {
    console.error("Hentning af sager, hvor returen kan sendes, fejlede:", error.message);
    return 0;
  }
  const sager = (data ?? []) as { id: string; trade_id: string; type: string; genaabnet_antal: number }[];
  if (sager.length === 0) return 0;
  const { data: anker, error: aErr } = await admin
    .from("sag_anker")
    .select("sag_id")
    .in(
      "sag_id",
      sager.map((s) => s.id),
    );
  if (aErr) {
    console.error("Hentning af anker fejlede:", aErr.message);
    return 0;
  }
  const anket = new Set(((anker ?? []) as { sag_id: string }[]).map((a) => a.sag_id));
  let antal = 0;
  for (const s of sager) {
    if (anket.has(s.id) || !erSagType(s.type)) continue;
    // Kun beskeder, der faktisk leveres nu, tælles (dubletter tælles ikke). En nøgle, der
    // ikke kunne claimes, springes over og prøves igen ved næste kørsel.
    const ok = await notificerSagAfgoerelse(
      s.id,
      s.trade_id,
      s.type,
      "retur_kan_sendes",
      null,
      Number(s.genaabnet_antal ?? 0),
      null,
      { springOverVedClaimFejl: true },
    );
    if (ok) antal++;
  }
  return antal;
}

// Hvad der nu sker med pengene efter ankens afgørelse:
//   'koeber_retur'  - køberen har medhold og skal sende varen retur
//   'koeber'        - køberen får pengene tilbage
//   'saelger'       - sælgeren får pengene
//   'lukket'        - sagen forbliver lukket (anken på en lukket sag er
//                     afvist); handlen fortsætter normalt
export type AnkeSlutUdfald = "koeber" | "koeber_retur" | "saelger" | "lukket";

// Hvad der faktisk skete med pengene (koeber/saelger):
//   'nu'      - sag_afvikl gennemførte; pengene er sendt til Stripe nu
//   'senere'  - pengene kan ikke flyttes lige nu (fx indsigelse eller en
//               Stripe-fejl); de flyttes, så snart det er muligt
//   'ingen'   - pengene var allerede flyttet (intet nyt at sige om dem)
export type AnkePengeStatus = "nu" | "senere" | "ingen";

// "Anke afgjort" til begge parter - ÉN samlet besked pr. part (afviklingen
// sender ikke sin egen "refunderet"/"frigivet"-besked her; se afgoerAnke).
// Begrundelsen fra BidHamr medsendes. Beløb nævnes aldrig. Kaster aldrig.
export async function notificerAnkeAfgjort(
  ankeId: string,
  tradeId: string,
  sagId: string,
  part: "koeber" | "saelger",
  udfald: "stadfaest" | "omgoer",
  slut: AnkeSlutUdfald,
  begrundelse: string,
  pengeStatus: AnkePengeStatus,
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
    const beskyttelseNote = h.beskyttelse ? " Prisen for BidHamr Beskyttelse får du ikke tilbage." : "";

    // Kun "nu", når pengene faktisk er flyttet. Ellers en tekst uden tidspunkt.
    const returFristNote = RETUR_FRIST_NOTE;
    const stripe = "Betalingen håndteres af vores betalingspartner Stripe.";
    const penge: Record<AnkeSlutUdfald, { koeber: string; saelger: string }> = {
      koeber:
        pengeStatus === "nu"
          ? {
              koeber: `Pengene er sendt tilbage til dig.${beskyttelseNote} Der kan gå nogle dage, før de står på din konto. ${stripe}`,
              saelger: "Køberen har fået pengene tilbage, og handlen er annulleret.",
            }
          : pengeStatus === "senere"
            ? {
                koeber: `Du får ${hvad} tilbage, så snart betalingen kan gennemføres.${beskyttelseNote}`,
                saelger: "Køberen får pengene tilbage, og handlen annulleres.",
              }
            : { koeber: "", saelger: "" },
      koeber_retur: {
        koeber: `Send varen retur til sælgeren nu. Du betaler selv returfragten. Når pakken er afleveret, får du ${hvad} tilbage.${beskyttelseNote} ${returFristNote}`,
        saelger: "Køberen sender varen retur til dig og betaler selv returfragten. Når pakken er afleveret, får køberen pengene tilbage.",
      },
      lukket: {
        koeber: "Sagen forbliver lukket, og handlen fortsætter som normalt.",
        saelger: "Sagen forbliver lukket, og handlen fortsætter som normalt.",
      },
      saelger:
        pengeStatus === "nu"
          ? {
              koeber: "Pengene er udbetalt til sælgeren.",
              saelger: `Pengene bliver nu udbetalt til din udbetalingskonto. ${stripe}`,
            }
          : pengeStatus === "senere"
            ? {
                koeber: "Pengene udbetales til sælgeren.",
                saelger: "Pengene udbetales til dig, så snart betalingen kan gennemføres.",
              }
            : { koeber: "", saelger: "" },
    };

    const ankende = part;
    const tekst = (rolle: "koeber" | "saelger"): [string, string] => {
      const pengeTekst = penge[slut][rolle];
      const p = pengeTekst ? `${pengeTekst} ` : "";
      if (rolle === ankende) {
        return udfald === "omgoer"
          ? ["Du har fået medhold i din anke", `BidHamr har set på sagen om "${t}" igen og ændret afgørelsen til din fordel. ${p}${endelig}${grund}`]
          : ["Din anke er afgjort", `BidHamr har set på sagen om "${t}" igen, og afgørelsen står ved magt. ${p}${endelig}${grund}`];
      }
      return udfald === "omgoer"
        ? ["Afgørelsen er ændret", `BidHamr har behandlet anken i sagen om "${t}" og ændret afgørelsen. ${p}${endelig}${grund}`]
        : ["Anken er afgjort", `BidHamr har behandlet anken i sagen om "${t}", og afgørelsen står ved magt. ${p}${endelig}${grund}`];
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
