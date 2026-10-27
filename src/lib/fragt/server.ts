import "server-only";

// Fragt på serveren: oprettelse/annullering af labels, registrering af
// sporingshændelser og sporings-cron. Bruger service-role (createAdminClient)
// - kaldere SKAL selv have verificeret brugeren med auth først.
//
// Hændelser -> handelsflow (ROADMAP-BESLUTNINGER, "Pakken er kommet frem" og
// "48-timers uret"):
//   afleveret  Handlen flyttes IKKE til 'pakke_sendt' automatisk:
//              pakkebillederne er stadig krævet fra sælgeren, og
//              trade_marker_sendt kræver auth.uid() = sælgeren. Står handlen
//              stadig i 'betaling_modtaget', får sælgeren en påmindelse om at
//              markere pakken sendt med billeder, og forsendelsen markeres
//              til staff (kraever_opmaerksomhed) med afsendelsesfristens dato.
//              Fristen ændres ikke.
//   leveret    48-timers uret starter af sig selv (src/lib/betaling/fragtUr.ts,
//              handel_fragt_leveret_start): handlen går til 'modtaget' som
//              ved købers "modtaget", regnet fra registreringen hos os. Køber
//              får "Pakken er kommet frem - 48 timer til at melde en fejl",
//              sælger får fristen. Kun når meldingen må frigive penge
//              (leveret_frigiver), handlen er 'pakke_sendt', og der hverken
//              er sag, retur, ikke-afhentet, indsigelse eller refusion -
//              ellers den gamle besked (pakke_leveret, idempotent nøgle).
//              Ingen penge flyttes her; handel_auto_frigiv frigiver efter
//              48 timer uden sag.
//   returneret Markeres til staff (kraever_opmaerksomhed, sat i SQL). Er
//              pakken aldrig leveret, og adapteren har returErIkkeAfhentet,
//              registreres "ikke afhentet" (src/lib/betaling/ikkeAfhentet.ts):
//              handlen annulleres, og refusionen claimes - selve refusionen
//              laver betalings-cron'en. Ingen udbetaling.
//   fejl       Markeres til staff.
// Ingen pengeflytning her (refusionen sker i betalings-cron'en).
//
// Sporing (koerFragtCron):
//   - Firmaer med et feed (DAO Track & Trace V2, hentSporingFeed): ét kald pr.
//     kørsel (højst hvert 10. minut) henter alle nye hændelser på alle vores
//     pakker. Tokenet gemmes først, når ALLE hændelser er gemt - et nedbrud,
//     en databasefejl eller et opbrugt tidsbudget giver en gentagelse næste
//     gang og aldrig et hul (hændelser er idempotente via nøglen). DAO's
//     sporing kan være op til 24 timer forsinket. Pakke-for-pakke-opslag er
//     kun reserve (højst hver 12. time pr. pakke).
//   - Andre firmaer: pakke for pakke (højst hvert 20. minut) som hidtil.
//   - Ukendte hændelseskoder ændrer aldrig status: de gemmes i
//     fragt_ukendte_koder, og drift får en advarsel første gang.
//
// Efterlysning (ROADMAP fase 2, Filip 11. okt. 2026): ingen leverings-
// melding 14 dage efter afsendelse -> én efterlysning hos fragtfirmaet
// (createclaim.php, kun med FRAGT_EFTERLYSNING_AKTIV=true - ellers manuel) og
// en markering til staff under Fragt. Pengene holdes tilbage af
// handel_auto_frigiv (frigiver aldrig efter 14 dage uden leveret_kl).
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl, renFejltekst } from "@/lib/drift";
import { DAO_OPRET_VAERSTE_MS } from "@/lib/fragt/dao";
import { send } from "@/lib/notifikationer/send";
import { adapterFor, fragtErSatOp, hentFragtfirma, FRAGTFIRMAER } from "@/lib/fragt";
import { sendSenest, sendSenestTekst } from "@/lib/afsendelsesfrist";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { INDSIGELSE_FEJL } from "@/lib/tekster/handel";
import { annullerPaymentIntentForLevering } from "@/lib/betaling/stripeBetaling";
import { hentEksisterende } from "@/lib/fragt/shipmondo";
import {
  DAO_BETINGELSER,
  DAO_BETINGELSER_FEJL,
  DAO_BETINGELSER_KODE,
  kraeverDaoBetingelser,
} from "@/lib/fragt/betingelser";
import {
  type Adresse,
  type ForsendelseInput,
  type ForsendelseKontekst,
  type Fragtfirma,
  type Label,
  type OprettetForsendelse,
  type Leveringsmaade,
  type Pakkeshop,
  type Pakkestoerrelse,
  type Sporingshaendelse,
  type Transportoer,
  type WebhookHaendelse,
  FragtAnnulleringIkkeMulig,
  FragtFejl,
  FragtUkendtUdfald,
  FRAGT_IKKE_SAT_OP,
  UKENDT_UDFALD_TEKST,
  erLeveringsmaade,
  erSporingsType,
  erTransportoer,
  transportoerLukket,
} from "@/lib/fragt/types";

export const FRAGT_LABEL_BUCKET = "fragt-labels";
const LABEL_MAKS_BYTES = 5 * 1024 * 1024;

type Admin = ReturnType<typeof createAdminClient>;

export type HaendelseKilde = "webhook" | "sporing" | "test";

const GENERISK_FEJL = "Noget gik galt. Prøv igen om lidt.";

const CLAIM_FEJL: Record<string, string> = {
  ikke_fundet: "Handlen findes ikke.",
  afhentning: "Handlen er en afhentning - der skal ikke laves fragtlabel.",
  forkert_status: "Der kan kun laves fragtlabel, når køberen har betalt, og pakken ikke er sendt.",
  ingen_retur: "Der er ingen sag, hvor varen skal sendes retur.",
  i_gang: "Fragtlabelen er ved at blive lavet. Vent et øjeblik, og opdatér siden.",
  mangler_levering: "Køberen har ikke valgt levering endnu.",
  for_mange_labels:
    "Du har allerede lavet 2 fragtlabels til denne handel. Skriv til BidHamr, hvis du skal bruge en ny – så godkender vi den.",
  // Bankindsigelse (20261102080000_handel_testfund.sql).
  indsigelse: INDSIGELSE_FEJL,
  ugyldig: "Ugyldigt valg.",
};

// DAO: annullerede labels tæller ikke, men der er et loft på 10 i alt.
const FOR_MANGE_LABELS_DAO =
  "Du har lavet mange fragtlabels til denne handel. Skriv til BidHamr, hvis du skal bruge en ny – så godkender vi den.";

// Shipmondo: en label, transportøren har bekræftet annulleret, tæller ikke
// (loft 10) - derfor samme tekst som DAO.
function claimFejlTekst(kode: string | undefined, firma: string): string {
  if (kode === "for_mange_labels" && (firma === "dao" || firma === "shipmondo")) return FOR_MANGE_LABELS_DAO;
  return CLAIM_FEJL[kode ?? ""] ?? GENERISK_FEJL;
}

// Kolonnen/funktionen fra 20261024010000 findes ikke endnu (koden er deployet
// før migrationen): fald stille tilbage til DAO uden valg af fragtfirma.
// 42703 = ukendt kolonne, 42883/PGRST202 = ukendt funktion.
export function foerTransportoerMigration(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  return (
    err.code === "42703" ||
    err.code === "42883" ||
    err.code === "PGRST202" ||
    /transportoer|forsendelse_gem_qr|forsendelse_annullering_bekraeftet|forsendelse_leveret_frigiver/.test(err.message ?? "") &&
      /does not exist|could not find/i.test(err.message ?? "")
  );
}

// Shipmondo kræver migrationen 20261024010000: uden kolonnen
// leveret_frigiver kører den gamle handel_auto_frigiv, og så ville
// Shipmondos "leveret" frigive penge efter 14 dage. Derfor regnes fragt som
// "ikke sat op", og Shipmondo-labels nægtes, indtil migrationen er kørt.
// Svaret huskes (migreret: altid; ikke migreret: 1 minut).
let migreretCache: { ok: boolean; til: number } | null = null;
export async function shipmondoMigreret(): Promise<boolean> {
  if (migreretCache && (migreretCache.ok || Date.now() < migreretCache.til)) return migreretCache.ok;
  const { error } = await createAdminClient().from("forsendelser").select("leveret_frigiver").limit(1);
  if (error && !foerTransportoerMigration(error) && !/leveret_frigiver/.test(error.message ?? "")) {
    // Ukendt fejl: nægt (fail closed), men husk ikke svaret.
    return false;
  }
  migreretCache = { ok: !error, til: Date.now() + 60_000 };
  return migreretCache.ok;
}

// Kun til test.
export function _nulstilMigreretCache() {
  migreretCache = null;
}

// Fragtfirmaet kan bruges nu (Shipmondo: kun efter migrationen).
async function firmaKlar(firma: Fragtfirma): Promise<boolean> {
  return firma.navn !== "shipmondo" || (await shipmondoMigreret());
}

function brugerFejl(err: unknown): string {
  return err instanceof FragtFejl ? err.brugerbesked : GENERISK_FEJL;
}

// Vi gav op at vente (kaldet til fragtfirmaet kan stadig være i gang).
class MedTimeoutFejl extends Error {
  constructor(hvad: string, ms: number) {
    super(`${hvad}: timeout efter ${ms} ms`);
    this.name = "MedTimeoutFejl";
  }
}

async function medTimeout<T>(p: Promise<T>, ms: number, hvad: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, afvis) => {
        timer = setTimeout(() => afvis(new MedTimeoutFejl(hvad, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function labelBytes(label: Label): Promise<Uint8Array> {
  if (label.type === "pdf") return label.data;
  // Fragtfirmaets link kan udløbe - hent og gem i vores egen bucket.
  if (!label.url.startsWith("https://")) throw new Error("Label-URL er ikke https");
  const svar = await fetch(label.url, { signal: AbortSignal.timeout(15_000) });
  if (!svar.ok) throw new Error(`Label kunne ikke hentes (${svar.status})`);
  const buf = new Uint8Array(await svar.arrayBuffer());
  if (buf.byteLength > LABEL_MAKS_BYTES) throw new Error("Labelen er for stor");
  return buf;
}

// ------------------------------------------------------------ adresser

export type AdresseInput = {
  navn?: unknown;
  adresse?: unknown;
  postnummer?: unknown;
  by?: unknown;
  telefon?: unknown;
};

function tekst(v: unknown, maks: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, maks) : "";
}

// Dansk telefonnummer: 8 cifre (evt. +45) eller internationalt med +.
export function renTelefon(v: unknown): string | null {
  const t = typeof v === "string" ? v.replace(/[\s().-]/g, "") : "";
  if (/^\d{8}$/.test(t)) return `+45${t}`;
  if (/^(\+|00)\d{8,14}$/.test(t)) return t.startsWith("00") ? `+${t.slice(2)}` : t;
  return null;
}

// Validerer en adresse fra brugeren. kraevAdresse: gade, postnummer og by
// er krævet (levering til døren, afsender, retur). Byen hentes fra
// postnummeret, hvis den mangler.
export function valideerAdresse(
  a: AdresseInput | null | undefined,
  opts: { kraevAdresse: boolean; kraevTelefon: boolean },
): { ok: true; adresse: Adresse } | { fejl: string } {
  const navn = tekst(a?.navn, 100);
  if (navn.length < 2) return { fejl: "Skriv dit fulde navn." };
  const telefon = renTelefon(a?.telefon);
  if (opts.kraevTelefon && !telefon) return { fejl: "Skriv et gyldigt telefonnummer (8 cifre)." };
  const adresse = tekst(a?.adresse, 200);
  const postnummer = tekst(a?.postnummer, 10);
  let by = tekst(a?.by, 80);
  if (opts.kraevAdresse || adresse || postnummer) {
    if (adresse.length < 3) return { fejl: "Skriv vejnavn og husnummer." };
    const opslag = slaaPostnummerOp(postnummer);
    if (!opslag) return { fejl: "Skriv et gyldigt dansk postnummer." };
    by = by || opslag.by;
  }
  return {
    ok: true,
    adresse: {
      navn,
      adresse: adresse || null,
      postnummer: postnummer || null,
      by: by || null,
      telefon,
      land: "DK",
    },
  };
}

async function brugerEmail(admin: Admin, brugerId: string): Promise<string | null> {
  const { data } = await admin.from("users").select("email").eq("id", brugerId).maybeSingle<{ email: string | null }>();
  return data?.email ?? null;
}

// ------------------------------------------------------------ priser

export type Fragtpris = {
  kode: Pakkestoerrelse;
  navn: string;
  maksGram: number;
  pakkeshopOere: number;
  doerOere: number | null;
};

// Pakkestørrelser og købers priser fra databasen (fragt_pakkestoerrelser -
// det ene sted, priserne står). Offentlige data.
export async function hentFragtpriser(): Promise<Fragtpris[]> {
  const { data, error } = await createAdminClient()
    .from("fragt_pakkestoerrelser")
    .select("kode, navn, maks_gram, pakkeshop_oere, doer_oere, sortering")
    .order("sortering", { ascending: true });
  if (error) throw new Error(`fragt_pakkestoerrelser: ${error.message}`);
  return (data ?? []).map((r) => ({
    kode: r.kode as Pakkestoerrelse,
    navn: r.navn as string,
    maksGram: Number(r.maks_gram),
    pakkeshopOere: Number(r.pakkeshop_oere),
    doerOere: r.doer_oere === null ? null : Number(r.doer_oere),
  }));
}

// ------------------------------------------------------------ pakkeshops

// Transportøren fra klienten: kun en af dem, køberen kan vælge nu
// (adapterens transportoerer - Shipmondo: DAO og GLS, PostNord kun med
// SHIPMONDO_POSTNORD_AKTIV=true; Filip, 20. okt. 2026). Adaptere uden valg:
// null. Mangler den hos en adapter med valg: den første (DAO). alle = true
// (kun søgning efter indleveringssteder til retur): alle kendte
// transportører, så retur af en pakke, der allerede er sendt med PostNord,
// virker videre.
function valgtTransportoer(
  firma: Fragtfirma,
  v: unknown,
  alle = false,
): Transportoer | null | { fejl: string } {
  const muligt = firma.transportoerer ?? [];
  if (muligt.length === 0) return null;
  if (v === undefined || v === null || v === "") return muligt[0];
  if (!erTransportoer(v)) return { fejl: "Vælg et fragtfirma." };
  if (alle || muligt.includes(v)) return v;
  return { fejl: transportoerLukket(v, muligt) };
}

// Pakkeshops nær et postnummer/en adresse hos det aktive fragtfirma (og den
// valgte transportør). indlevering: shops, hvor man kan aflevere (retur).
// Kaldere skal have tjekket login og rate limit.
export async function soegPakkeshops(
  q: { postnummer?: unknown; adresse?: unknown; by?: unknown; antal?: unknown; transportoer?: unknown; indlevering?: unknown },
): Promise<{ ok: true; fragtfirma: string; transportoer: Transportoer | null; pakkeshops: Pakkeshop[] } | { fejl: string }> {
  if (!fragtErSatOp()) return { fejl: FRAGT_IKKE_SAT_OP };
  const postnummer = tekst(q.postnummer, 10);
  if (!slaaPostnummerOp(postnummer)) return { fejl: "Skriv et gyldigt dansk postnummer." };
  const antal = typeof q.antal === "number" && Number.isInteger(q.antal) ? Math.min(Math.max(q.antal, 1), 20) : 10;
  const firma = hentFragtfirma();
  if (!(await firmaKlar(firma))) return { fejl: FRAGT_IKKE_SAT_OP };
  const transportoer = valgtTransportoer(firma, q.transportoer, q.indlevering === true);
  if (transportoer && typeof transportoer === "object") return transportoer;
  try {
    const pakkeshops = await medTimeout(
      firma.soegPakkeshops({
        postnummer,
        adresse: tekst(q.adresse, 100) || null,
        by: tekst(q.by, 60) || null,
        antal,
        transportoer,
        indlevering: q.indlevering === true,
      }),
      15_000,
      "soegPakkeshops",
    );
    return { ok: true, fragtfirma: firma.navn, transportoer, pakkeshops: pakkeshops.slice(0, antal) };
  } catch (err) {
    if (!(err instanceof FragtFejl)) {
      await logDriftFejl({ kilde: "server", hvor: "Fragt: søg pakkeshops", fejl: err });
    }
    return { fejl: err instanceof FragtFejl ? err.brugerbesked : "Pakkeshops kunne ikke hentes. Prøv igen om lidt." };
  }
}

// ------------------------------------------------------------ leveringsvalg (checkout)

export type LeveringsvalgInput = {
  maade?: unknown;
  // Valgt pakkeshop: id + postnummer (bruges til at slå shoppen op igen hos
  // fragtfirmaet - navn og adresse tages derfra, aldrig fra klienten).
  pakkeshopId?: unknown;
  pakkeshopPostnummer?: unknown;
  // Kun søgehjælp (i tætte byer ligger der over 20 shops i ét postnummer).
  pakkeshopAdresse?: unknown;
  modtager?: AdresseInput | null;
  gemForslag?: unknown;
  // Køberens valgte fragtfirma (Shipmondo: "dao" | "gls" | "postnord").
  transportoer?: unknown;
};

const LEVERING_FEJL: Record<string, string> = {
  ikke_fundet: "Handlen findes ikke.",
  afhentning: "Handlen er en afhentning hos sælgeren - der skal ikke vælges levering.",
  forkert_status: "Leveringen kan ikke ændres længere.",
  laast: "Sælgeren har allerede lavet fragtlabelen, så leveringen kan ikke ændres.",
  ikke_mulig: "Levering til døren er ikke muligt for denne pakkestørrelse. Vælg en pakkeshop.",
  pris_laast: "Du har allerede betalt. Du kan skifte pakkeshop, men ikke leveringsmåde.",
  ugyldig: "Ugyldigt valg.",
};

const AFHENTNING_IKKE_MULIG = "Sælgeren tilbyder ikke afhentning af denne vare. Vælg en pakkeshop eller levering hjem.";

type GemSvar = {
  kode?: string;
  pi?: string;
  fragt_oere?: number;
  total_oere?: number;
  beskyttelse_oere?: number;
  afhentning?: boolean;
  pris_aendret?: boolean;
};

export type GemtLeveringsvalg = {
  ok: true;
  fragtOere: number;
  totalOere: number;
  // BidHamr Beskyttelse på betalingen efter valget (0 ved afhentning).
  beskyttelseOere: number;
  afhentning: boolean;
  prisAendret: boolean;
};

// Kalder handel_gem_levering. Svarer databasen 'pi_skal_annulleres' (beløbet
// ændres, og der findes en PaymentIntent), annulleres den hos Stripe først,
// og kaldet gentages med dens id.
async function gemValgIDatabasen(
  admin: Admin,
  tradeId: string,
  koeberId: string,
  valg: Record<string, unknown>,
  fejlTekster: Record<string, string>,
): Promise<GemtLeveringsvalg | { fejl: string }> {
  const kald = (pi: string | null) =>
    admin.rpc("handel_gem_levering", {
      p_trade: tradeId,
      p_bruger: koeberId,
      p_valg: valg,
      p_annulleret_pi: pi,
    });

  try {
    let { data, error } = await kald(null);
    if (error) throw new Error(`handel_gem_levering: ${error.message}`);
    let svar = data as GemSvar;
    if (svar?.kode === "pi_skal_annulleres" && svar.pi) {
      // Beløbet ændres: den gamle PaymentIntent må aldrig kunne betales.
      const r = await annullerPaymentIntentForLevering(svar.pi);
      if (r === "betalt") {
        return { fejl: "Betalingen er allerede gennemført, så leveringsmåden kan ikke ændres. Genindlæs siden." };
      }
      ({ data, error } = await kald(svar.pi));
      if (error) throw new Error(`handel_gem_levering: ${error.message}`);
      svar = data as GemSvar;
    }
    if (svar?.kode !== "ok") {
      return { fejl: fejlTekster[svar?.kode ?? ""] ?? LEVERING_FEJL[svar?.kode ?? ""] ?? GENERISK_FEJL };
    }
    return {
      ok: true,
      fragtOere: Number(svar.fragt_oere),
      totalOere: Number(svar.total_oere),
      beskyttelseOere: Number(svar.beskyttelse_oere ?? 0),
      afhentning: Boolean(svar.afhentning),
      prisAendret: Boolean(svar.pris_aendret),
    };
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: gem leveringsvalg", fejl: err, brugerId: koeberId });
    return { fejl: GENERISK_FEJL };
  }
}

// Køberen vælger afhentning hos sælger (kun når auktionen tilbyder både
// forsendelse og afhentning, og kun før betaling). Fragten bliver 0, og
// handlen følger afhentningsflowet (kode, 7 dages frist). Kræver ikke, at
// fragtfirmaet er sat op.
async function gemAfhentning(tradeId: string, koeberId: string): Promise<GemtLeveringsvalg | { fejl: string }> {
  return gemValgIDatabasen(createAdminClient(), tradeId, koeberId, { maade: "afhentning" }, {
    ikke_mulig: AFHENTNING_IKKE_MULIG,
    pris_laast: "Du har allerede betalt, så leveringsmåden kan ikke ændres.",
  });
}

// Gemmer købers leveringsvalg (checkout før betalingen) og retter
// betalingens fragt. koeberId SKAL være verificeret med auth af kalderen;
// databasen tjekker igen under lås (handel_gem_levering). Ændres beløbet, og
// findes der en PaymentIntent, annulleres den hos Stripe først og nulstilles
// (pi_forsoeg + 1) - næste "Betal" laver en ny med det nye beløb.
export async function gemLeveringsvalg(
  tradeId: string,
  koeberId: string,
  input: LeveringsvalgInput,
): Promise<GemtLeveringsvalg | { fejl: string }> {
  if (input.maade === "afhentning") return gemAfhentning(tradeId, koeberId);
  if (!fragtErSatOp()) return { fejl: FRAGT_IKKE_SAT_OP };
  if (!erLeveringsmaade(input.maade)) return { fejl: "Vælg pakkeshop eller levering til døren." };
  const maade = input.maade;
  const mod = valideerAdresse(input.modtager, { kraevAdresse: maade === "doer", kraevTelefon: true });
  if ("fejl" in mod) return mod;

  const admin = createAdminClient();
  const firma = hentFragtfirma();
  if (!(await firmaKlar(firma))) return { fejl: FRAGT_IKKE_SAT_OP };
  const tilladte = firma.transportoerer ?? [];
  const transportoer = valgtTransportoer(firma, input.transportoer);
  if (transportoer && typeof transportoer === "object") return transportoer;

  let pakkeshop: Pakkeshop | null = null;
  if (maade === "pakkeshop") {
    const id = tekst(input.pakkeshopId, 50);
    const postnummer = tekst(input.pakkeshopPostnummer, 10);
    if (!id || !slaaPostnummerOp(postnummer)) return { fejl: "Vælg en pakkeshop." };
    try {
      // Shoppen slås op hos den valgte transportør: en shop fra et andet
      // fragtfirma findes ikke (id'erne overlapper ikke på tværs).
      pakkeshop = await medTimeout(
        firma.hentPakkeshop(id, {
          postnummer,
          adresse: tekst(input.pakkeshopAdresse, 100) || null,
          antal: 20,
          transportoer,
        }),
        15_000,
        "hentPakkeshop",
      );
    } catch (err) {
      if (!(err instanceof FragtFejl)) await logDriftFejl({ kilde: "server", hvor: "Fragt: hent pakkeshop", fejl: err });
      return { fejl: brugerFejl(err) };
    }
    if (!pakkeshop) return { fejl: "Pakkeshoppen findes ikke længere. Vælg en anden." };
  }

  const valg = {
    maade,
    fragtfirma: firma.navn,
    // Kun Shipmondo (databasen kræver den dér og ignorerer den ellers).
    transportoer,
    // Databasen afviser en transportør uden for listen (20261028010000) -
    // fail closed, også for kode, der glemmer tjekket.
    tilladte: [...tilladte],
    // Til databasen før 20261028010000 (afviser GLS uden gls_aktiv = true),
    // så GLS virker, hvis koden deployes før migrationen.
    gls_aktiv: tilladte.includes("gls"),
    pakkeshop: pakkeshop
      ? {
          id: pakkeshop.id,
          navn: pakkeshop.navn,
          adresse: pakkeshop.adresse,
          postnummer: /^\d{4}$/.test(pakkeshop.postnummer) ? pakkeshop.postnummer : null,
          by: pakkeshop.by,
          lat: pakkeshop.lat,
          lng: pakkeshop.lng,
        }
      : null,
    modtager: {
      navn: mod.adresse.navn,
      adresse: mod.adresse.adresse,
      postnummer: mod.adresse.postnummer,
      by: mod.adresse.by,
      telefon: mod.adresse.telefon,
      email: await brugerEmail(admin, koeberId),
    },
    gem_forslag: input.gemForslag !== false,
  };

  // Databasens værn (20261028010000): transportøren står ikke i listen.
  const lukket = transportoer ? transportoerLukket(transportoer, tilladte) : "Vælg et fragtfirma.";
  return gemValgIDatabasen(admin, tradeId, koeberId, valg, { transportoer_lukket: lukket, gls_lukket: lukket });
}

// ------------------------------------------------------------ gemt pakkeshop (checkout)

// Køberens gemte pakkeshop ("Husk mine oplysninger og min pakkeshop",
// leveringsforslag). Testfund 27. okt. 2026: en gemt GLS-pakkeshop blev ikke
// forudfyldt, fordi leveringsforslag.transportoer er fragtfirmaet fra det
// SENESTE valg (fx "levering hjem med DAO"), mens pakkeshoppen bliver stående
// fra et tidligere valg. Fra 20261102080000 gemmes shoppens eget fragtfirma i
// pakkeshop_transportoer. Ældre rækker (null) slås op hos det seneste
// fragtfirma én gang og rettes.
export type GemtPakkeshopInput = {
  id: string | null;
  navn: string | null;
  adresse: string | null;
  postnummer: string | null;
  by: string | null;
  // Shoppens fragtfirma (pakkeshop_transportoer). undefined = kolonnen findes
  // ikke endnu (før migrationen).
  shopTransportoer: string | null | undefined;
  // Fragtfirmaet fra det seneste valg (leveringsforslag.transportoer).
  senesteTransportoer: string | null;
};

export type GemtPakkeshop = {
  transportoer: Transportoer | null;
  id: string;
  navn: string;
  adresse: string;
  postnummer: string;
  by: string;
};

// En pakkeshop, der ikke findes længere eller hører til et fragtfirma, som
// ikke kan vælges, ryddes stille - køberen vælger bare en ny.
async function rydGemtPakkeshop(admin: Admin, brugerId: string, id: string): Promise<void> {
  const tom = { pakkeshop_id: null, pakkeshop_navn: null, pakkeshop_adresse: null, pakkeshop_postnummer: null, pakkeshop_by: null };
  const { error } = await admin
    .from("leveringsforslag")
    .update({ ...tom, pakkeshop_transportoer: null })
    .eq("user_id", brugerId)
    .eq("pakkeshop_id", id);
  // Før migrationen 20261102080000 findes pakkeshop_transportoer ikke.
  if (error && (error.code === "42703" || error.code === "PGRST204")) {
    await admin.from("leveringsforslag").update(tom).eq("user_id", brugerId).eq("pakkeshop_id", id);
  } else if (error) {
    console.error("Rydning af gemt pakkeshop fejlede:", error.message);
  }
}

// Til checkout: den gemte pakkeshop, hvis den stadig kan bruges - ellers null
// (og den ryddes, når vi ved, at den er ugyldig). Kaster aldrig. Et
// opslag, der fejler (fx timeout hos fragtfirmaet), rydder intet - så vises
// den gemte shop, og gemLeveringsvalg tjekker den igen.
export async function tjekGemtPakkeshop(brugerId: string, g: GemtPakkeshopInput): Promise<GemtPakkeshop | null> {
  const id = g.id?.trim() ?? "";
  if (!id || !fragtErSatOp()) return null;
  const admin = createAdminClient();
  try {
    const firma = hentFragtfirma();
    const muligt = firma.transportoerer ?? [];
    const verificeret = typeof g.shopTransportoer === "string";
    // Fragtfirmaer, shoppen kan høre til - i den rækkefølge, de prøves.
    let kandidater: (Transportoer | null)[];
    if (muligt.length === 0) {
      // DAO direkte/testfragt: kun shops gemt uden fragtfirma. En shop fra
      // Shipmondo (med fragtfirma) vises ikke, men ryddes heller ikke - den
      // er gyldig, når Shipmondo er slået til igen.
      if (g.shopTransportoer ?? g.senesteTransportoer) return null;
      kandidater = [null];
    } else if (verificeret) {
      const t = g.shopTransportoer;
      kandidater = erTransportoer(t) && muligt.includes(t) ? [t] : [];
    } else {
      // Ældre række: shoppens fragtfirma er ukendt (det seneste valgs kan
      // være et andet). Prøv det seneste først, så de andre.
      const seneste = erTransportoer(g.senesteTransportoer) ? g.senesteTransportoer : null;
      kandidater = [...muligt].sort((a, b) => Number(b === seneste) - Number(a === seneste));
    }
    const postnummer = g.postnummer?.trim() ?? "";
    if (kandidater.length === 0 || !slaaPostnummerOp(postnummer)) {
      // Et fragtfirma, der ikke kan vælges længere, eller et ugyldigt postnummer.
      await rydGemtPakkeshop(admin, brugerId, id);
      return null;
    }
    const gemt: GemtPakkeshop = {
      transportoer: kandidater[0],
      id,
      navn: g.navn ?? "Pakkeshop",
      adresse: g.adresse ?? "",
      postnummer,
      by: g.by ?? "",
    };
    if (!(await firmaKlar(firma))) return verificeret || muligt.length === 0 ? gemt : null;
    let fundet: Pakkeshop | null = null;
    let transportoer: Transportoer | null = null;
    for (const t of kandidater) {
      try {
        fundet = await medTimeout(
          firma.hentPakkeshop(id, { postnummer, adresse: g.adresse || null, antal: 20, transportoer: t }),
          4_000,
          "hentPakkeshop (gemt)",
        );
      } catch {
        // Ukendt (timeout, netværk): intet ryddes. Den gemte vises kun, hvis
        // fragtfirmaet er kendt - ellers kunne det være en shop fra et andet firma.
        return verificeret || muligt.length === 0 ? gemt : null;
      }
      if (fundet) {
        transportoer = t;
        break;
      }
    }
    if (!fundet) {
      await rydGemtPakkeshop(admin, brugerId, id);
      return null;
    }
    if (!verificeret && transportoer) {
      // Ældre række: shoppens fragtfirma er nu kendt.
      await admin
        .from("leveringsforslag")
        .update({ pakkeshop_transportoer: transportoer })
        .eq("user_id", brugerId)
        .eq("pakkeshop_id", id);
    }
    return {
      transportoer,
      id: fundet.id,
      navn: fundet.navn,
      adresse: fundet.adresse,
      postnummer: /^\d{4}$/.test(fundet.postnummer) ? fundet.postnummer : postnummer,
      by: fundet.by,
    };
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: gemt pakkeshop", fejl: err, brugerId });
    return null;
  }
}

type LeveringRaekke = {
  maade: Leveringsmaade;
  fragtfirma: string;
  transportoer: string | null;
  pakkeshop_id: string | null;
  modtager_navn: string;
  modtager_adresse: string | null;
  modtager_postnummer: string | null;
  modtager_by: string | null;
  modtager_telefon: string;
  modtager_email: string | null;
  pakkeshop_navn: string | null;
  pakkeshop_adresse: string | null;
  pakkeshop_postnummer: string | null;
  pakkeshop_by: string | null;
};

async function hentLevering(admin: Admin, tradeId: string): Promise<LeveringRaekke | null> {
  const kolonner =
    "maade, fragtfirma, pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by, " +
    "modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, modtager_email";
  let { data, error } = await admin
    .from("handel_levering")
    .select(`${kolonner}, transportoer`)
    .eq("trade_id", tradeId)
    .maybeSingle<LeveringRaekke>();
  if (error && foerTransportoerMigration(error)) {
    ({ data, error } = await admin
      .from("handel_levering")
      .select(kolonner)
      .eq("trade_id", tradeId)
      .maybeSingle<LeveringRaekke>());
    if (data) data = { ...data, transportoer: null };
  }
  if (error) throw new Error(`handel_levering: ${error.message}`);
  return data;
}

// Modtageradressen på labelen. Ved pakkeshop uden hjemmeadresse bruges
// pakkeshoppens adresse (Shipmondo kræver en adresse; pakken går til shoppen).
function modtagerFraLevering(l: LeveringRaekke): Adresse {
  const harAdresse = Boolean(l.modtager_adresse && l.modtager_postnummer && l.modtager_by);
  return {
    navn: l.modtager_navn,
    adresse: harAdresse ? l.modtager_adresse : l.pakkeshop_adresse,
    postnummer: harAdresse ? l.modtager_postnummer : l.pakkeshop_postnummer,
    by: harAdresse ? l.modtager_by : l.pakkeshop_by,
    telefon: l.modtager_telefon,
    email: l.modtager_email,
    land: "DK",
  };
}

// ------------------------------------------------------------ oprettelse

const MAKS_GRAM_STANDARD: Record<Pakkestoerrelse, number> = { lille: 1000, mellem: 5000, stor: 15000 };

type ClaimSvar = { kode?: string; id?: string; pakkestoerrelse?: Pakkestoerrelse; levering?: string; fragtfirma?: string };

// Fælles: claim -> fragtfirma -> gem label -> gem detaljer.
// Fejl:
//   FragtFejl før oprettelsen (afvist, ugyldige data): claimet markeres
//     fejlet - intet er oprettet hos fragtfirmaet.
//   Alt andet (timeout, netværk, 5xx, fejl efter oprettelsen): ukendt udfald.
//     Claimet bliver stående, og næste forsøg genoptager med SAMME reference
//     ('genoptag'), så fragtfirmaet giver den eksisterende forsendelse
//     tilbage. Der bestilles aldrig en ny label, før det er afklaret.
//
// Fragtfirmaer UDEN opslag på reference (genforsoegOpretterNy - DAO):
//   DAO kan ikke give os en forsendelse tilbage ud fra referencen, men en
//   forsendelse, der aldrig indleveres, faktureres ikke. Derfor:
//   - Ukendt udfald UDEN stregkode (timeout/netværk/5xx på ordren): claimet
//     bliver stående som ovenfor, og næste forsøg (efter mindst 1 minut)
//     laver en NY forsendelse med samme BidHamr-id. En eventuel pakke fra det
//     første forsøg kan ikke bruges - sælgeren har aldrig set dens labelfri
//     kode - og koster derfor intet.
//   - Ukendt udfald MED stregkode (DAO oprettede pakken, men vi kunne ikke
//     gemme den): stregkoden gemmes i fragt_foraeldreloese og annulleres med
//     det samme (og igen af fragt-cron'en, højst 5 gange, derefter staff).
//     Næste forsøg annullerer også først forsendelsens kendte forældreløse.
//   - En FragtFejl i et genoptaget forsøg betyder, at DAO afviste NETOP dette
//     forsøg (intet nyt er oprettet), så claimet markeres fejlet, og sælgeren
//     kan prøve igen. Hos Shipmondo kunne et genoptaget forsøg derimod stamme
//     fra en tidligere POST og bliver aldrig 'fejlet' af systemet.
//   Opret-kaldet genforsøges ALDRIG automatisk - kun når sælgeren selv
//   trykker igen.
async function opretForsendelse(
  admin: Admin,
  args: {
    tradeId: string;
    brugerId: string;
    type: "udgaaende" | "retur";
    firma: Fragtfirma;
    byg: (claim: Required<Pick<ClaimSvar, "id" | "pakkestoerrelse">>) => Promise<ForsendelseInput>;
  },
): Promise<{ ok: true; forsendelseId: string } | { fejl: string }> {
  const { tradeId, brugerId, type } = args;
  // Shipmondo uden migrationen: ingen labels (se shipmondoMigreret).
  if (!(await firmaKlar(args.firma))) return { fejl: FRAGT_IKKE_SAT_OP };
  const { data: claim, error: claimFejl } = await admin.rpc("forsendelse_claim", {
    p_trade: tradeId,
    p_bruger: brugerId,
    p_type: type,
    p_fragtfirma: args.firma.navn,
    p_pakkestoerrelse: null,
  });
  if (claimFejl) {
    console.error("forsendelse_claim fejlede:", claimFejl.message);
    return { fejl: GENERISK_FEJL };
  }
  const svar = claim as ClaimSvar | null;
  if (svar?.kode === "findes" && svar.id) return { ok: true, forsendelseId: svar.id };
  if ((svar?.kode !== "ok" && svar?.kode !== "genoptag") || !svar.id || !svar.pakkestoerrelse) {
    return { fejl: claimFejlTekst(svar?.kode, args.firma.navn) };
  }
  const id = svar.id;
  // Shipmondos "leveret" må kun starte 14-dages-frigivelsen, når Filip har
  // slået det til (SHIPMONDO_LEVERET_FRIGIVER=true) efter at have set rigtige
  // webhooks. Databasen sætter leveret_frigiver = false for Shipmondo; her
  // slås den til ved oprettelsen (før pakken kan være leveret).
  if (svar.kode === "ok" && args.firma.navn === "shipmondo" && process.env.SHIPMONDO_LEVERET_FRIGIVER === "true") {
    const { error: fFejl } = await admin.rpc("forsendelse_leveret_frigiver", { p_id: id });
    if (fFejl && !foerTransportoerMigration(fFejl)) {
      await logDriftFejl({ kilde: "server", hvor: "Fragt: leveret frigiver", fejl: fFejl });
    }
  }
  // Genoptag: samme fragtfirma som det første forsøg.
  if (svar.kode === "genoptag" && svar.fragtfirma && svar.fragtfirma !== args.firma.navn) {
    const tidligere = adapterFor(svar.fragtfirma);
    if (!tidligere || !(await firmaKlar(tidligere))) return { fejl: FRAGT_IKKE_SAT_OP };
    args = { ...args, firma: tidligere };
  }

  const firma = args.firma;
  const opretterNy = firma.genforsoegOpretterNy === true;
  // Genoptag uden opslag på reference: annullér først de forældreløse, vi
  // kender fra tidligere forsøg (fejl her stopper ikke det nye forsøg -
  // cron'en prøver igen).
  if (svar.kode === "genoptag" && opretterNy) {
    await annullerForaeldreloese(admin, id, FORAELDRELOESE_I_FORSOEG, 30_000);
  }
  let oprettetHosFirma: string | null = null;
  let qrPng: string | null = null;
  try {
    const input = await args.byg({ id, pakkestoerrelse: svar.pakkestoerrelse });
    const kald = type === "retur" ? firma.opretReturforsendelse(input) : firma.opretForsendelse(input);
    let oprettet: OprettetForsendelse;
    try {
      oprettet = await medTimeout(
        kald,
        // DAO: ordre + kort PDF + evt. annullering kan tage ca. 45 s.
        opretterNy ? OPRET_MAKS_MS_UDEN_OPSLAG : 30_000,
        type === "retur" ? "opretReturforsendelse" : "opretForsendelse",
      );
    } catch (err) {
      // Vi gav op at vente, men kaldet kører videre. Kommer der senere en
      // stregkode, er den forældreløs (sælgeren ser den aldrig): gem og
      // annullér den. after() holder funktionen i live efter svaret.
      if (err instanceof MedTimeoutFejl && opretterNy) efterOpgivetOpret(admin, id, kald);
      throw err;
    }
    oprettetHosFirma = oprettet.forsendelsesId;

    // Uden PDF (kun DAO med labelfri kode): gemmes uden label_sti; PDF'en
    // hentes, når sælgeren trykker "Hent label" (sikrLabelPdf).
    let sti: string | null = null;
    if (oprettet.label) {
      const bytes = await labelBytes(oprettet.label);
      sti = `${tradeId}/${id}.pdf`;
      const { error: upFejl } = await admin.storage
        .from(FRAGT_LABEL_BUCKET)
        .upload(sti, bytes, { contentType: "application/pdf", upsert: false });
      if (upFejl && !/exists|duplicate/i.test(upFejl.message)) {
        throw new Error(`Label kunne ikke gemmes: ${upFejl.message}`);
      }
    } else if (!oprettet.qrKode) {
      throw new Error("Fragtfirmaet gav hverken label eller labelfri kode");
    }

    const { error: detFejl } = await admin.rpc("forsendelse_gem_detaljer", {
      p_id: id,
      p_produkt: oprettet.produkt ?? null,
      p_vaegt_gram: input.vaegtGram ?? null,
      p_labelfri: Boolean(oprettet.qrKode),
      p_pakkeshop_id: input.pakkeshopId ?? null,
      p_afsender: input.afsender,
      p_modtager: input.modtager,
    });
    if (detFejl) throw new Error(`forsendelse_gem_detaljer: ${detFejl.message}`);

    const { data: gemt, error: gemFejl } = await admin.rpc("forsendelse_gem_oprettet", {
      p_id: id,
      p_forsendelses_id: oprettet.forsendelsesId,
      p_sporingsnummer: oprettet.sporingsnummer,
      p_label_sti: sti,
      p_qr_kode: oprettet.qrKode ?? null,
      p_pris_oere: oprettet.prisOere ?? null,
    });
    if (gemFejl) throw new Error(`forsendelse_gem_oprettet: ${gemFejl.message}`);
    if (!gemt) throw new Error("Forsendelsen var ikke længere claimet");
    qrPng = oprettet.qrPng ?? null;
  } catch (err) {
    // Kun den rensede tekst (aldrig rå fejl med evt. URL'er/nøgler).
    console.error("Fragtlabel kunne ikke laves:", renFejltekst(err, 300));
    // 'fejlet' KUN når vi ved, at intet er oprettet: en FragtFejl (validering
    // før første kald eller 4xx på oprettelsen) i et FØRSTE forsøg. Et
    // genoptaget forsøg kan stamme fra en tidligere POST - det bliver aldrig
    // 'fejlet' her (kun staff kan afslutte det, se staffAfslutClaim).
    // Undtagelse: genforsoegOpretterNy (DAO) - se kommentaren øverst.
    if (err instanceof FragtFejl && !oprettetHosFirma && (svar.kode !== "genoptag" || opretterNy)) {
      await admin.rpc("forsendelse_marker_fejlet", { p_id: id, p_fejl: renFejltekst(err, 500) });
      return { fejl: err.brugerbesked };
    }
    // DAO oprettede pakken, men den kan ikke bruges: gem og annullér den.
    const foraeldreloes =
      opretterNy ? (oprettetHosFirma ?? (err instanceof FragtUkendtUdfald ? err.foraeldreloesId : null)) : null;
    if (foraeldreloes) {
      const { error: oFejl } = await admin.rpc("fragt_foraeldreloes_registrer", {
        p_forsendelse: id,
        p_forsendelses_id: foraeldreloes,
      });
      if (oFejl) {
        await logDriftFejl({ kilde: "server", hvor: "Fragt: forældreløs forsendelse", fejl: oFejl });
      } else {
        await annullerForaeldreloese(admin, id, FORAELDRELOESE_I_FORSOEG, 30_000);
      }
    }
    // Ukendt udfald: lad claimet stå - næste forsøg genbruger referencen
    // (DAO: laver en ny forsendelse).
    await admin.rpc("forsendelse_marker_ukendt", { p_id: id, p_fejl: renFejltekst(err, 500) });
    await logDriftFejl({
      kilde: "server",
      hvor: "Fragt: ukendt udfald",
      fejl:
        `${renFejltekst(err, 300)} - forsendelse ${id} hos ${firma.visningsnavn}` +
        (foraeldreloes ?? oprettetHosFirma ? ` (oprettet som ${foraeldreloes ?? oprettetHosFirma})` : "") +
        (opretterNy
          ? ". Næste forsøg laver en ny forsendelse (fragtfirmaet kan ikke slå op på reference)."
          : ". Næste forsøg genbruger samme reference."),
    });
    return { fejl: err instanceof FragtFejl ? err.brugerbesked : UKENDT_UDFALD_TEKST };
  }

  // QR-koden (PostNord, GLS retur) - labelen er gemt, så en fejl her giver
  // kun PDF'en (sælgeren/køberen kan stadig printe).
  if (qrPng) await gemQr(admin, id, qrPng);

  // Første hændelse (oprettet) - giver en tidslinje fra start. Labelen er
  // gemt, så en fejl her må ikke annullere den.
  try {
    await registrerForsendelseshaendelse(id, {
      type: "oprettet",
      tidspunkt: new Date().toISOString(),
      noegle: "bidhamr:oprettet",
      beskrivelse: type === "retur" ? "Returlabel oprettet" : "Fragtlabel oprettet",
    }, "sporing");
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: oprettet-hændelse", fejl: err });
  }
  return { ok: true, forsendelseId: id };
}

async function gemQr(admin: Admin, forsendelseId: string, qrPng: string): Promise<void> {
  const { error } = await admin.rpc("forsendelse_gem_qr", { p_id: forsendelseId, p_png: qrPng });
  if (error && !foerTransportoerMigration(error)) await logDriftFejl({ kilde: "server", hvor: "Fragt: gem QR-kode", fejl: error });
}

// I sælgerens eget forsøg annulleres højst 2 forældreløse (og højst i 30 s),
// så kaldet holder sig under maxDuration (120 s) - resten tager fragt-cron'en.
const FORAELDRELOESE_I_FORSOEG = 2;

// Mindst DAO_OPRET_VAERSTE_MS (ca. 45 s) + lidt luft.
const OPRET_MAKS_MS_UDEN_OPSLAG = Math.max(50_000, DAO_OPRET_VAERSTE_MS + 5_000);

// Et opgivet opret-kald (MedTimeoutFejl) fortsætter i baggrunden. Giver det
// senere en forsendelse - eller en forældreløs stregkode i fejlen - gemmes
// den som forældreløs og annulleres. Kaster aldrig.
function efterOpgivetOpret(admin: Admin, forsendelseId: string, kald: Promise<OprettetForsendelse>): void {
  const opgave = kald.then(
    (o) => o.forsendelsesId,
    (err) => (err instanceof FragtUkendtUdfald ? err.foraeldreloesId : null),
  ).then(async (stregkode) => {
    if (!stregkode) return;
    const { data, error } = await admin.rpc("fragt_foraeldreloes_registrer", {
      p_forsendelse: forsendelseId,
      p_forsendelses_id: stregkode,
    });
    if (error) {
      await logDriftFejl({ kilde: "server", hvor: "Fragt: forsinket forældreløs", fejl: error });
      return;
    }
    if (data === true) await annullerForaeldreloese(admin, forsendelseId, 5);
  }).catch((err) => logDriftFejl({ kilde: "server", hvor: "Fragt: forsinket forældreløs", fejl: err }));
  try {
    after(() => opgave);
  } catch {
    // Uden for en request (fx cron eller test): promise'et kører alligevel.
    void opgave;
  }
}

// Annullerer forældreløse forsendelser hos fragtfirmaet (fragt_foraeldreloese).
// forsendelseId: kun dem for den forsendelse (før et nyt forsøg) - ellers de
// ældste (fragt-cron). Kaster aldrig. Svar: antal annulleret.
async function annullerForaeldreloese(
  admin: Admin,
  forsendelseId: string | null,
  graense: number,
  budgetMs = 60_000,
): Promise<number> {
  let antal = 0;
  const slut = Date.now() + budgetMs;
  try {
    const { data, error } = await admin.rpc("fragt_foraeldreloese_claim", {
      p_forsendelse: forsendelseId,
      p_graense: graense,
    });
    if (error) throw new Error(`fragt_foraeldreloese_claim: ${error.message}`);
    for (const o of (data ?? []) as { id: string; fragtfirma: string; forsendelses_id: string }[]) {
      // Tidsbudget: resten tager fragt-cron'en (claimet venter 1 time).
      if (Date.now() > slut) break;
      const adapter = adapterFor(o.fragtfirma);
      let ok = false;
      let fejl: string | null = null;
      if (!adapter) {
        fejl = "Fragtfirmaet er ikke sat op her";
      } else {
        try {
          await medTimeout(adapter.annullerForsendelse(o.forsendelses_id), 20_000, "annullerForsendelse");
          ok = true;
        } catch (err) {
          fejl = renFejltekst(err, 300);
        }
      }
      const { error: aFejl } = await admin.rpc("fragt_foraeldreloes_afslut", { p_id: o.id, p_ok: ok, p_fejl: fejl });
      if (aFejl) throw new Error(`fragt_foraeldreloes_afslut: ${aFejl.message}`);
      if (ok) antal++;
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: annullér forældreløse", fejl: err });
  }
  return antal;
}

// Henter og gemmer label-PDF'en, når den manglede ved oprettelsen (DAO med
// labelfri kode). Kaldere SKAL have tjekket, at brugeren må se labelen.
// Svar: stien i bucket'en, eller null (kan ikke hentes lige nu).
export async function sikrLabelPdf(forsendelseId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data: f } = await admin
    .from("forsendelser")
    .select("id, trade_id, fragtfirma, forsendelses_id, label_sti, status")
    .eq("id", forsendelseId)
    .maybeSingle<{ id: string; trade_id: string; fragtfirma: string; forsendelses_id: string | null; label_sti: string | null; status: string }>();
  if (!f) return null;
  if (f.label_sti) return f.label_sti;
  if (!f.forsendelses_id || ["opretter", "annulleres", "annulleret", "fejlet"].includes(f.status)) return null;
  const adapter = adapterFor(f.fragtfirma);
  if (!adapter?.hentLabel) return null;
  try {
    const label = await medTimeout(adapter.hentLabel(f.forsendelses_id), 20_000, "hentLabel");
    const bytes = await labelBytes(label);
    const sti = `${f.trade_id}/${f.id}.pdf`;
    const { error: upFejl } = await admin.storage
      .from(FRAGT_LABEL_BUCKET)
      .upload(sti, bytes, { contentType: "application/pdf", upsert: false });
    if (upFejl && !/exists|duplicate/i.test(upFejl.message)) throw new Error(`Label kunne ikke gemmes: ${upFejl.message}`);
    const { error } = await admin.rpc("forsendelse_gem_label", { p_id: f.id, p_sti: sti });
    if (error) throw new Error(`forsendelse_gem_label: ${error.message}`);
    return sti;
  } catch (err) {
    if (!(err instanceof FragtFejl)) await logDriftFejl({ kilde: "server", hvor: "Fragt: hent label senere", fejl: err });
    return null;
  }
}

// Transportøren på en claimet forsendelse. Databasen sætter den ved
// oprettelsen (triggeren forsendelser_transportoer: købers valg for en
// udgående, den udgåendes for en retur) og låser den bagefter, så et
// genforsøg altid bruger samme transportør.
async function forsendelseTransportoer(admin: Admin, forsendelseId: string): Promise<Transportoer | null> {
  const { data, error } = await admin
    .from("forsendelser")
    .select("transportoer")
    .eq("id", forsendelseId)
    .maybeSingle<{ transportoer: string | null }>();
  if (error && foerTransportoerMigration(error)) return null;
  if (error) throw new Error(`forsendelser (transportør): ${error.message}`);
  return erTransportoer(data?.transportoer) ? data.transportoer : null;
}

async function vaegtOgTitel(admin: Admin, tradeId: string) {
  const { data: handel } = await admin
    .from("trades")
    .select("id, auction_id, buyer_id, seller_id")
    .eq("id", tradeId)
    .single<{ id: string; auction_id: string; buyer_id: string; seller_id: string }>();
  if (!handel) throw new Error("Handlen findes ikke");
  const { data: auktion } = await admin
    .from("auctions")
    .select("titel, vaegt_gram")
    .eq("id", handel.auction_id)
    .maybeSingle<{ titel: string | null; vaegt_gram: number | null }>();
  return { handel, titel: auktion?.titel ?? "Vare fra BidHamr", vaegtGram: auktion?.vaegt_gram ?? null };
}

// ------------------------------------------------------------ DAO's handelsbetingelser

// Har sælgeren accepteret den aktuelle version af DAO's handelsbetingelser?
// Kaster ved databasefejl (fx før migrationen 20261028010000).
export async function harAccepteretDaoBetingelser(admin: Admin, brugerId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("fragt_betingelser_accept")
    .select("version")
    .eq("bruger_id", brugerId)
    .eq("fragtfirma", DAO_BETINGELSER.fragtfirma)
    .eq("version", DAO_BETINGELSER.version)
    .maybeSingle<{ version: string }>();
  if (error) throw new Error(`fragt_betingelser_accept: ${error.message}`);
  return data !== null;
}

// "ok", når accepten findes eller netop er gemt (accepter = true). Ellers
// fejlen med kode 'dao_betingelser'. Fail closed: kan accepten ikke læses
// eller gemmes, laves der ingen DAO-label.
async function sikrDaoBetingelser(
  admin: Admin,
  brugerId: string,
  accepter: boolean,
): Promise<"ok" | { fejl: string; kode?: string }> {
  try {
    if (await harAccepteretDaoBetingelser(admin, brugerId)) return "ok";
    if (!accepter) return { fejl: DAO_BETINGELSER_FEJL, kode: DAO_BETINGELSER_KODE };
    // Idempotent: dobbeltklik giver én række (primærnøglen), tidspunktet er
    // det første.
    const { error } = await admin
      .from("fragt_betingelser_accept")
      .upsert(
        { bruger_id: brugerId, fragtfirma: DAO_BETINGELSER.fragtfirma, version: DAO_BETINGELSER.version },
        { onConflict: "bruger_id,fragtfirma,version", ignoreDuplicates: true },
      );
    if (error) throw new Error(`fragt_betingelser_accept (gem): ${error.message}`);
    return "ok";
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: DAO's handelsbetingelser", fejl: err, brugerId });
    return { fejl: GENERISK_FEJL };
  }
}

// Laver den udgående fragtlabel ("Send pakke"). saelgerId SKAL være
// verificeret med auth af kalderen; SQL'en tjekker igen under lås, at han er
// sælger, at handlen er en betalt forsendelseshandel med købers
// leveringsvalg, og at der ikke allerede er en aktiv label (dobbeltklik giver
// samme label). Pakkestørrelsen er auktionens; fragtfirmaet er det, køberen
// valgte pakkeshop hos.
//
// DAO (Filip, 20. okt. 2026): sælgeren skal have accepteret DAO's
// handelsbetingelser (aktuel version), før labelen laves. Mangler accepten,
// og sender han den ikke med (accepterDaoBetingelser), afvises kaldet med
// kode 'dao_betingelser' - før claimet, så intet bestilles.
export async function opretUdgaaendeForsendelse(
  tradeId: string,
  saelgerId: string,
  afsenderInput: AdresseInput,
  valg: { accepterDaoBetingelser?: boolean } = {},
): Promise<{ ok: true; forsendelseId: string } | { fejl: string; kode?: string }> {
  const afs = valideerAdresse(afsenderInput, { kraevAdresse: true, kraevTelefon: false });
  if ("fejl" in afs) return afs;
  const admin = createAdminClient();

  let levering: LeveringRaekke | null;
  try {
    levering = await hentLevering(admin, tradeId);
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: hent leveringsvalg", fejl: err });
    return { fejl: GENERISK_FEJL };
  }
  if (!levering) return { fejl: CLAIM_FEJL.mangler_levering };
  const firma = adapterFor(levering.fragtfirma);
  if (!firma) return { fejl: FRAGT_IKKE_SAT_OP };
  // "Ikke sat op" før accepten (opretForsendelse tjekker igen).
  if (!(await firmaKlar(firma))) return { fejl: FRAGT_IKKE_SAT_OP };
  if (kraeverDaoBetingelser(levering.fragtfirma, levering.transportoer)) {
    const b = await sikrDaoBetingelser(admin, saelgerId, valg.accepterDaoBetingelser === true);
    if (b !== "ok") return b;
  }
  const afsender: Adresse = { ...afs.adresse, email: await brugerEmail(admin, saelgerId) };

  const svar = await opretForsendelse(admin, {
    tradeId,
    brugerId: saelgerId,
    type: "udgaaende",
    firma,
    byg: async ({ id, pakkestoerrelse }) => {
      // Læs valget igen EFTER claimet: nu er det låst (handel_gem_levering
      // svarer 'laast', når der findes en forsendelse), så køberen kan ikke
      // have ændret det mellem læsning og oprettelse.
      const lev = await hentLevering(admin, tradeId);
      if (!lev || lev.fragtfirma !== firma.navn) {
        throw new FragtFejl("Køberens levering er ændret. Prøv igen.");
      }
      // Køberens transportør (Shipmondo) - som databasen gemte den på
      // forsendelsen ved claimet.
      // Før migrationen 20261024010000 findes kolonnen ikke: altid DAO.
      const harValg = (firma.transportoerer?.length ?? 0) > 0;
      const transportoer = harValg ? ((await forsendelseTransportoer(admin, id)) ?? "dao") : null;
      if (harValg && transportoer !== (erTransportoer(lev.transportoer) ? lev.transportoer : "dao")) {
        throw new FragtFejl("Køberens levering er ændret. Prøv igen.");
      }
      // DAO's handelsbetingelser igen ud fra det låste valg: køberen kan have
      // skiftet fx GLS -> DAO mellem tjekket før claimet og claimet. Uden
      // accept (eller kan den ikke læses): FragtFejl - intet er bestilt.
      if (kraeverDaoBetingelser(lev.fragtfirma, lev.transportoer)) {
        let accepteret: boolean;
        try {
          accepteret = await harAccepteretDaoBetingelser(admin, saelgerId);
        } catch (err) {
          throw new FragtFejl(GENERISK_FEJL, renFejltekst(err, 300));
        }
        if (!accepteret) throw new FragtFejl(DAO_BETINGELSER_FEJL);
      }
      const { titel, vaegtGram } = await vaegtOgTitel(admin, tradeId);
      return {
        reference: id,
        handel: { id: tradeId, titel },
        afsender,
        modtager: modtagerFraLevering(lev),
        pakkestoerrelse,
        levering: lev.maade,
        pakkeshopId: lev.maade === "pakkeshop" ? lev.pakkeshop_id : null,
        vaegtGram: vaegtGram ?? MAKS_GRAM_STANDARD[pakkestoerrelse],
        transportoer,
      };
    },
  });
  if ("ok" in svar) {
    // Forslag til næste gang (ikke kritisk).
    await admin.rpc("leveringsforslag_gem_afsender", { p_bruger: saelgerId, p_afsender: afs.adresse });
  }
  return svar;
}

// Teksten, når et label-forsøg allerede er i gang (returfragt.ts tæller det
// ikke som en fejl).
export const RETUR_I_GANG_TEKST = CLAIM_FEJL.i_gang;

// Returlabel i en sag (afgjort med retur): køberen sender varen tilbage til
// sælgeren via en pakkeshop tæt på sælgerens adresse (fragtfirmaet vælger
// den). koeberId SKAL være verificeret med auth; SQL'en kræver en sag i
// 'afventer_retur' med retur_kraeves. Sælgerens adresse tages fra den
// udgående label. Bag flaget FRAGT_RETURLABEL_AKTIV.
// Kun når køberen HAR BETALT returfragten (Filip, 13. okt. 2026 -
// src/lib/betaling/returfragt.ts): kaldes derfra efter betalingen. Databasen
// afviser også en returlabel uden betalt returfragt (forsendelser_returfragt_vagt).
export async function opretReturForsendelse(
  tradeId: string,
  koeberId: string,
  afsenderInput: AdresseInput,
): Promise<{ ok: true; forsendelseId: string } | { fejl: string }> {
  if (process.env.FRAGT_RETURLABEL_AKTIV !== "true") {
    return { fejl: "Returlabel via BidHamr er ikke slået til endnu. Skriv til BidHamr i sagen." };
  }
  const afs = valideerAdresse(afsenderInput, { kraevAdresse: true, kraevTelefon: true });
  if ("fejl" in afs) return afs;
  const admin = createAdminClient();

  const { data: betalt, error: bFejl } = await admin
    .from("returfragt_betalinger")
    .select("id")
    .eq("trade_id", tradeId)
    .eq("koeber_id", koeberId)
    .eq("status", "betalt")
    .maybeSingle<{ id: string }>();
  if (bFejl) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: returfragt-tjek", fejl: bFejl });
    return { fejl: GENERISK_FEJL };
  }
  if (!betalt) return { fejl: "Betal returfragten, før returkoden kan laves." };

  const { data: ud } = await admin
    .from("forsendelser")
    .select("fragtfirma, afsender, pakkestoerrelse")
    .eq("trade_id", tradeId)
    .eq("type", "udgaaende")
    .not("afsender", "is", null)
    .order("oprettet_kl", { ascending: false })
    .limit(1)
    .maybeSingle<{ fragtfirma: string; afsender: Adresse | null; pakkestoerrelse: Pakkestoerrelse }>();
  if (!ud?.afsender) {
    return { fejl: "Sælgerens adresse mangler, så returlabelen kan ikke laves. Skriv til BidHamr i sagen." };
  }
  const firma = adapterFor(ud.fragtfirma);
  if (!firma) return { fejl: FRAGT_IKKE_SAT_OP };
  const afsender: Adresse = { ...afs.adresse, email: await brugerEmail(admin, koeberId) };

  return opretForsendelse(admin, {
    tradeId,
    brugerId: koeberId,
    type: "retur",
    firma,
    byg: async ({ id, pakkestoerrelse }) => {
      const { titel, vaegtGram } = await vaegtOgTitel(admin, tradeId);
      const t = await admin.from("trades").select("seller_id").eq("id", tradeId).single<{ seller_id: string }>();
      return {
        reference: id,
        handel: { id: tradeId, titel: `Retur: ${titel}` },
        afsender,
        modtager: { ...ud.afsender!, email: t.data ? await brugerEmail(admin, t.data.seller_id) : null },
        pakkestoerrelse,
        levering: "pakkeshop",
        pakkeshopId: null,
        vaegtGram: vaegtGram ?? MAKS_GRAM_STANDARD[pakkestoerrelse],
        // Samme transportør som den udgående pakke (sat af databasen).
        transportoer: (await forsendelseTransportoer(admin, id)) ?? ((firma.transportoerer?.length ?? 0) > 0 ? "dao" : null),
      };
    },
  });
}

// Staff afslutter en hængende claim ('opretter' efter ukendt udfald), efter
// at have tjekket hos fragtfirmaet:
//   'fejlet'   intet er oprettet - sælgeren kan prøve igen (ny reference).
//   'tilknyt'  forsendelsen findes (Shipmondo-id): labelen hentes og gemmes,
//              og forsendelsen bliver 'oprettet'. Referencen hos Shipmondo
//              SKAL være BidHamrs forsendelses-id.
// Kaldere SKAL have tjekket staff-rollen og inhabilitet og logger selv.
export async function staffAfslutHaengendeClaim(
  forsendelseId: string,
  valg: "fejlet" | "tilknyt",
  opts: { note: string; forsendelsesId?: string | null },
): Promise<{ ok: true; tradeId: string } | { fejl: string }> {
  const admin = createAdminClient();
  const { data: f } = await admin
    .from("forsendelser")
    .select("id, trade_id, status, fragtfirma, pakkeshop_id, modtager")
    .eq("id", forsendelseId)
    .maybeSingle<{ id: string; trade_id: string; status: string; fragtfirma: string; pakkeshop_id: string | null; modtager: Adresse | null }>();
  if (!f) return { fejl: "Forsendelsen findes ikke." };
  if (f.status !== "opretter") return { fejl: "Forsendelsen hænger ikke (status er " + f.status + ")." };

  if (valg === "fejlet") {
    const { data, error } = await admin.rpc("forsendelse_staff_marker_fejlet", { p_id: f.id, p_note: opts.note });
    if (error) throw new Error("forsendelse_staff_marker_fejlet: " + error.message);
    if (data === "ok") return { ok: true, tradeId: f.trade_id };
    const STAFF_FEJL: Record<string, string> = {
      note_mangler: "Skriv, hvad du har tjekket hos fragtfirmaet.",
      ikke_fundet: "Forsendelsen findes ikke.",
      ikke_haengende: "Forsendelsen hænger ikke længere. Opdatér siden.",
      i_gang:
        "Oprettelsen kan stadig være i gang. Vent, til der er gået 10 minutter siden sidste forsøg (eller til den er markeret med ukendt udfald), og tjek hos fragtfirmaet igen.",
    };
    return { fejl: STAFF_FEJL[String(data)] ?? "Forsendelsen blev ændret imens. Opdatér siden." };
  }

  if (f.fragtfirma !== "shipmondo") return { fejl: "Kun Shipmondo-forsendelser kan tilknyttes." };
  const sid = (opts.forsendelsesId ?? "").trim();
  let eks: Awaited<ReturnType<typeof hentEksisterende>>;
  try {
    eks = await medTimeout(hentEksisterende(sid), 20_000, "hentEksisterende");
  } catch (err) {
    return { fejl: err instanceof FragtFejl ? err.brugerbesked : "Shipmondo svarede ikke. Prøv igen om lidt." };
  }
  if (eks.reference !== f.id) {
    return { fejl: `Forsendelsen hos Shipmondo har en anden reference (${eks.reference ?? "ingen"}) end BidHamrs (${f.id}).` };
  }
  if (!eks.label) return { fejl: "Shipmondo gav ingen label til forsendelsen." };
  const sti = `${f.trade_id}/${f.id}.pdf`;
  const bytes = await labelBytes(eks.label);
  const { error: upFejl } = await admin.storage
    .from(FRAGT_LABEL_BUCKET)
    .upload(sti, bytes, { contentType: "application/pdf", upsert: false });
  if (upFejl && !/exists|duplicate/i.test(upFejl.message)) throw new Error("Label kunne ikke gemmes: " + upFejl.message);
  const { error: detFejl } = await admin.rpc("forsendelse_gem_detaljer", {
    p_id: f.id,
    p_produkt: eks.produkt ?? null,
    p_vaegt_gram: eks.vaegtGram,
    p_labelfri: Boolean(eks.qrKode),
    p_pakkeshop_id: f.pakkeshop_id,
    p_afsender: eks.afsender,
    p_modtager: f.modtager,
  });
  if (detFejl) throw new Error("forsendelse_gem_detaljer: " + detFejl.message);
  const { data: gemt, error: gemFejl } = await admin.rpc("forsendelse_gem_oprettet", {
    p_id: f.id,
    p_forsendelses_id: eks.forsendelsesId,
    p_sporingsnummer: eks.sporingsnummer,
    p_label_sti: sti,
    p_qr_kode: eks.qrKode ?? null,
    p_pris_oere: eks.prisOere ?? null,
  });
  if (gemFejl) throw new Error("forsendelse_gem_oprettet: " + gemFejl.message);
  if (!gemt) return { fejl: "Forsendelsen blev ændret imens. Opdatér siden." };
  if (eks.qrPng) await gemQr(admin, f.id, eks.qrPng);
  await registrerForsendelseshaendelse(f.id, {
    type: "oprettet",
    tidspunkt: new Date().toISOString(),
    noegle: "bidhamr:oprettet",
    beskrivelse: "Fragtlabel tilknyttet af BidHamr",
  }, "sporing");
  return { ok: true, tradeId: f.trade_id };
}

// Markering til staff på en forsendelse. Fejler den, logges det til drift
// (markeringen er det, der får staff til at se på sagen). Kaster aldrig.
async function markerTilStaff(admin: Admin, args: { p_id: string; p_note: string }): Promise<void> {
  const { error } = await admin.rpc("forsendelse_marker_opmaerksomhed", args);
  if (error) {
    await logDriftFejl({
      kilde: "server",
      hvor: "Fragt: markering til staff",
      fejl: `Forsendelse ${args.p_id} kunne ikke markeres (${error.message}). Note: ${args.p_note}`,
    });
  }
}

// Annullerer en label hos fragtfirmaet i to trin, så en samtidig "afleveret"
// ikke giver uoverensstemmelse:
//   1. forsendelse_annuller_claim sætter status 'annulleres' FØR fragtfirmaet
//      kaldes (dobbeltklik/cron giver ikke to kald).
//   2. forsendelse_annuller_afslut: 'annulleret' ved succes. Ved fejl rulles
//      status tilbage til 'oprettet' (labelen er stadig aktiv), og staff
//      markeres, når vi ikke ved, hvad fragtfirmaet nåede (ukendt fejl/timeout)
//      eller når det er systemet, der annullerer.
// brugerId: brugeren (SKAL være verificeret med auth af kalderen), eller null
// for systemet (fragt-cron - kun på annullerede handler, tjekkes i SQL).
async function annullerForsendelse(
  admin: Admin,
  forsendelseId: string,
  brugerId: string | null,
): Promise<{ ok: true } | { fejl: string }> {
  const { data: kode, error: claimFejl } = await admin.rpc("forsendelse_annuller_claim", {
    p_id: forsendelseId,
    p_bruger: brugerId,
  });
  if (claimFejl) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: forsendelse_annuller_claim", fejl: claimFejl });
    return { fejl: GENERISK_FEJL };
  }
  if (kode === "ikke_fundet") return { fejl: "Fragtlabelen findes ikke." };
  if (kode === "i_gang") return { fejl: "Labelen er ved at blive annulleret. Opdatér siden om lidt." };
  if (kode !== "ok") return { fejl: "Labelen kan ikke annulleres, når pakken er afleveret." };

  const afslut = async (ok: boolean, note: string | null): Promise<string | null> => {
    const { data, error } = await admin.rpc("forsendelse_annuller_afslut", {
      p_id: forsendelseId,
      p_ok: ok,
      p_note: note,
    });
    if (error) {
      // Status bliver stående i 'annulleres'; fragt-cron rydder op efter 15 min.
      await logDriftFejl({ kilde: "server", hvor: "Fragt: forsendelse_annuller_afslut", fejl: error });
      return null;
    }
    return data as string;
  };

  const { data: f } = await admin
    .from("forsendelser")
    .select("type, fragtfirma, forsendelses_id")
    .eq("id", forsendelseId)
    .maybeSingle<{ type: string; fragtfirma: string; forsendelses_id: string | null }>();
  // Returkode (returfragt i sager): kun en annullering, fragtfirmaet har
  // BEKRÆFTET, giver køberen ret til en ny kode (returfragt_annullering_bekraeftet).
  const returBekraeftet = async () => {
    if (f?.type !== "retur") return;
    const { error } = await admin.rpc("returfragt_annullering_bekraeftet", { p_forsendelse: forsendelseId });
    if (error) await logDriftFejl({ kilde: "server", hvor: "Fragt: returkode annulleret", fejl: error });
  };
  const adapter = f ? adapterFor(f.fragtfirma) : null;
  if (!f?.forsendelses_id || !adapter) {
    await afslut(
      false,
      brugerId === null
        ? "Handlen er annulleret, men fragtfirmaet er ikke sat op her, så labelen kunne ikke annulleres. Annullér den manuelt hos fragtfirmaet."
        : null,
    );
    return { fejl: FRAGT_IKKE_SAT_OP };
  }

  let bekraeftet = true;
  try {
    const r = await medTimeout(adapter.annullerForsendelse(f.forsendelses_id), 20_000, "annullerForsendelse");
    // Shipmondo: annulleret hos Shipmondo, men transportøren har ikke
    // bekræftet det (cancelled_at_carrier = false).
    if (r && r.bekraeftet === false) bekraeftet = false;
  } catch (err) {
    // Fragtfirmaet kan ikke annullere (DAO via Shipmondo): labelen annulleres
    // hos BidHamr (sælgeren kan ikke længere se den), og staff får besked,
    // så de kan bede fragtfirmaet kreditere den. Bruges labelen alligevel,
    // markeres forsendelsen til staff (hændelse på annulleret label).
    if (err instanceof FragtAnnulleringIkkeMulig) {
      const svar = await afslut(true, null);
      await markerTilStaff(admin, {
        p_id: forsendelseId,
        p_note:
          `Labelen er annulleret i BidHamr, men fragtfirmaet kan ikke annullere den selv (${f.fragtfirma} ${f.forsendelses_id}). ` +
          (f.type === "retur"
            ? "Returkoden kan stadig være gyldig: køberen får ikke en ny kode, og returfragten refunderes ikke automatisk - staff afgør (Refundér returfragt på sagen)."
            : "Bed fragtfirmaet kreditere den, hvis den ikke bliver brugt."),
      });
      if (svar === "aendret") {
        return { fejl: "Fragtfirmaet har netop meldt pakken indleveret. BidHamr kigger på forsendelsen." };
      }
      return { ok: true };
    }
    const kendt = err instanceof FragtFejl;
    const detalje = renFejltekst(err, 200);
    let note: string | null = null;
    if (brugerId === null) {
      note = `Handlen er annulleret, men labelen kunne ikke annulleres hos fragtfirmaet (${detalje}). Annullér den manuelt hos fragtfirmaet, eller kontakt sælgeren.`;
    } else if (!kendt) {
      note = `Sælgeren prøvede at annullere labelen, men fragtfirmaet svarede ikke korrekt (${detalje}). Tjek hos fragtfirmaet, om labelen er annulleret.`;
    }
    await afslut(false, note);
    if (!kendt) {
      await logDriftFejl({ kilde: "server", hvor: "Fragt: annullér label", fejl: err });
    }
    return { fejl: brugerFejl(err) };
  }

  const svar = await afslut(true, null);
  if (svar === "aendret") {
    return { fejl: "Fragtfirmaet har netop meldt pakken indleveret. BidHamr kigger på forsendelsen." };
  }
  if (!bekraeftet) {
    // Labelen tæller stadig i labelgrænsen (forsendelse_claim), og en
    // returkode giver ikke ret til en ny uden staff - transportøren kan
    // stadig modtage pakken på den.
    if (f.type === "retur") {
      await markerTilStaff(admin, {
        p_id: forsendelseId,
        p_note:
          `Returkoden er annulleret hos ${adapter.visningsnavn} (${f.forsendelses_id}), men transportøren har ikke bekræftet det. ` +
          "Koden kan stadig være gyldig: køberen får ikke en ny kode, og returfragten refunderes ikke automatisk - staff afgør (Refundér returfragt på sagen).",
      });
    }
    return { ok: true };
  }
  // Fragtfirmaet har bekræftet annulleringen: labelen tæller ikke i
  // labelgrænsen (Shipmondo/DAO, forsendelse_claim), og en returkode kan
  // erstattes uden ny betaling.
  const { error: bFejl } = await admin.rpc("forsendelse_annullering_bekraeftet", { p_id: forsendelseId });
  if (bFejl) {
    // Labelen ER annulleret, men bekræftelsen er ikke gemt: stop her - ingen
    // ny returkode uden betaling (returBekraeftet), og labelen tæller stadig
    // i labelgrænsen. Før migrationen findes funktionen ikke (stille).
    if (!foerTransportoerMigration(bFejl)) {
      await logDriftFejl({ kilde: "server", hvor: "Fragt: annullering bekræftet", fejl: bFejl });
      await markerTilStaff(admin, {
        p_id: forsendelseId,
        p_note: "Fragtfirmaet har bekræftet annulleringen, men BidHamr kunne ikke gemme det. Tjek labelgrænsen og en evt. returkode.",
      });
    }
    return { ok: true };
  }
  await returBekraeftet();
  return { ok: true };
}

// Annullerer en udgående label, før pakken er afleveret. saelgerId SKAL være
// verificeret med auth af kalderen (SQL tjekker igen, at han er sælgeren).
export async function annullerUdgaaendeForsendelse(
  forsendelseId: string,
  saelgerId: string,
): Promise<{ ok: true } | { fejl: string }> {
  const admin = createAdminClient();
  const { data: f } = await admin
    .from("forsendelser")
    .select("type")
    .eq("id", forsendelseId)
    .maybeSingle<{ type: string }>();
  if (!f || f.type !== "udgaaende") return { fejl: "Fragtlabelen findes ikke." };
  return annullerForsendelse(admin, forsendelseId, saelgerId);
}

// ------------------------------------------------------------ hændelser

// Gemmer en hændelse idempotent (samme nøgle = ingen ny række) og udfører
// derefter handelseffekterne (beskeder/markeringer). Kaster ved databasefejl.
// effekter: false = kun gem (webhooken skal svare inden for 3 sekunder; den
// kører effekterne bagefter med after(), og fragt-cron'en sender beskeder,
// der mangler).
// En databasefejl med Postgres-koden og HTTP-status fra PostgREST, så feedet
// kan skelne en midlertidig fejl fra en hændelse, der aldrig kan gemmes.
export class DbFejl extends Error {
  readonly kode: string | null;
  readonly status: number | null;
  constructor(besked: string, kode: string | null, status: number | null) {
    super(besked);
    this.name = "DbFejl";
    this.kode = kode;
    this.status = status;
  }
}

// Midlertidig: serialisering (40001), deadlock (40P01), statement timeout
// (57014), lås ikke ledig (55P03), forbindelse (08xxx), HTTP 5xx/0, og alt,
// der ikke er en kendt databasefejl (fx netværk). Tæller aldrig som poison.
export function erMidlertidigFejl(err: unknown): boolean {
  if (!(err instanceof DbFejl)) return true;
  const k = (err.kode ?? "").toUpperCase();
  if (["40001", "40P01", "57014", "55P03"].includes(k) || k.startsWith("08")) return true;
  if (err.status === null || err.status === 0 || err.status >= 500) return true;
  return false;
}

export async function registrerForsendelseshaendelse(
  forsendelseId: string,
  h: Sporingshaendelse,
  kilde: HaendelseKilde,
  opts: { effekter?: boolean } = {},
): Promise<{ ny: boolean }> {
  if (!erSporingsType(h.type)) throw new DbFejl(`Ukendt hændelsestype: ${String(h.type)}`, "BHFRAGT", 400);
  const tid = Number.isNaN(Date.parse(h.tidspunkt)) ? new Date().toISOString() : h.tidspunkt;
  const admin = createAdminClient();
  const { data, error, status } = await admin.rpc("forsendelse_registrer_haendelse", {
    p_forsendelse: forsendelseId,
    p_type: h.type,
    p_tidspunkt: tid,
    p_noegle: h.noegle.slice(0, 200),
    p_beskrivelse: h.beskrivelse?.slice(0, 300) ?? null,
    p_raa: h.raa ?? null,
    p_kilde: kilde,
  });
  if (error) throw new DbFejl(`forsendelse_registrer_haendelse: ${error.message}`, error.code ?? null, status ?? null);
  const ny = Boolean((data as { ny?: boolean } | null)?.ny);
  // Fragtfirmaets målte vægt over pakkestørrelsen: staff + udbetalingen holdes.
  const maalt = h.raa && typeof h.raa.maalt_vaegt_gram === "number" ? Math.round(h.raa.maalt_vaegt_gram) : null;
  if (ny && maalt && maalt > 0) {
    const { error: vFejl, status: vStatus } = await admin.rpc("forsendelse_tjek_vaegt", { p_id: forsendelseId, p_maalt_gram: maalt });
    if (vFejl) throw new DbFejl("forsendelse_tjek_vaegt: " + vFejl.message, vFejl.code ?? null, vStatus ?? null);
  }
  if (ny && opts.effekter !== false) await udfoerHandelseffekter(admin, forsendelseId);
  return { ny };
}

// Beskeder/markeringer for en forsendelse (fx efter webhooken). Kaster aldrig.
export async function udfoerHandelseffekterFor(forsendelseId: string): Promise<number> {
  return udfoerHandelseffekter(createAdminClient(), forsendelseId);
}

type ForsendelseFuld = {
  id: string;
  trade_id: string;
  type: "udgaaende" | "retur";
  status: string;
  sporingsnummer: string | null;
  afleveret_kl: string | null;
  leveret_kl: string | null;
  returneret_kl: string | null;
  afleveret_besked_kl: string | null;
  leveret_besked_kl: string | null;
};

// Beskeder ud fra forsendelsens tilstand. Idempotent: hver besked har en
// fast nøgle, og *_besked_kl sættes bagefter, så cron kan prøve igen, hvis
// serveren døde imellem. Kaster aldrig.
async function udfoerHandelseffekter(admin: Admin, forsendelseId: string): Promise<number> {
  let sendt = 0;
  try {
    const { data: f } = await admin
      .from("forsendelser")
      .select("id, trade_id, type, status, sporingsnummer, afleveret_kl, leveret_kl, returneret_kl, afleveret_besked_kl, leveret_besked_kl")
      .eq("id", forsendelseId)
      .maybeSingle<ForsendelseFuld>();
    if (!f || f.type !== "udgaaende") return 0;
    if (["opretter", "annulleret", "fejlet"].includes(f.status)) return 0;
    // Pakken er sendt retur uden at være leveret: ikke afhentet (kun når
    // adapterens signal er sikkert - ellers afgør staff). Idempotent; kaster
    // aldrig. Beskederne sendes af ikkeAfhentet.ts.
    if (f.returneret_kl && !f.leveret_kl) {
      const { ikkeAfhentetFraFragt } = await import("@/lib/betaling/ikkeAfhentet");
      await ikkeAfhentetFraFragt(f.id);
    }
    const mangler =
      (f.afleveret_kl && !f.afleveret_besked_kl) || (f.leveret_kl && !f.leveret_besked_kl);
    if (!mangler) return 0;

    const { data: t } = await admin
      .from("trades")
      .select("id, auction_id, buyer_id, seller_id, status")
      .eq("id", f.trade_id)
      .maybeSingle<{ id: string; auction_id: string; buyer_id: string; seller_id: string; status: string }>();
    if (!t) return 0;
    const { data: a } = await admin
      .from("auctions")
      .select("titel")
      .eq("id", t.auction_id)
      .maybeSingle<{ titel: string | null }>();
    const titel = a?.titel ?? "din vare";
    const link = `/mine-handler/${t.id}`;

    // Pakken er indleveret, men sælgeren har ikke markeret den sendt: sælgeren
    // får en påmindelse, og forsendelsen markeres til staff, så de kan
    // kontakte sælgeren. Afsendelsesfristen ændres IKKE (ROADMAP-BESLUTNINGER,
    // "Sælger markerer selv pakken sendt") - handlen annulleres stadig, hvis
    // pakken ikke er markeret sendt, når fristen udløber.
    if (f.afleveret_kl && !f.afleveret_besked_kl) {
      let note: string | null = null;
      if (t.status === "betaling_modtaget") {
        const { data: b } = await admin
          .from("betalinger")
          .select("betalt_kl")
          .eq("trade_id", t.id)
          .not("betalt_kl", "is", null)
          .order("betalt_kl", { ascending: false })
          .limit(1)
          .maybeSingle<{ betalt_kl: string }>();
        const frist = sendSenest(b?.betalt_kl);
        note =
          "Fragtfirmaet har pakken, men sælger har ikke trykket Send pakke – afsendelsesfristen annullerer handlen " +
          (frist ? sendSenestTekst(frist) : "når fristen udløber") +
          ". Kontakt sælgeren.";
        await send(t.seller_id, "pakke_indleveret", {
          titel: "Pakken er indleveret",
          tekst: `Fragtfirmaet har modtaget pakken med "${titel}". Har du ikke allerede gjort det, så markér pakken sendt med de to pakkebilleder på handelssiden - ellers bliver handlen annulleret, når fristen for afsendelse udløber.`,
          link,
          data: { trade_id: t.id },
          noegle: `fragt_afleveret:${f.id}`,
        });
        sendt++;
      } else if (t.status === "annulleret") {
        note = "Fragtfirmaet har modtaget pakken, men handlen er annulleret. Tjek, om pakken skal sendes retur til sælgeren.";
      }
      await admin.rpc("forsendelse_marker_besked", { p_id: f.id, p_felt: "afleveret", p_note: note });
    }

    // Pakken er kommet frem: 48-timers uret starter af sig selv
    // (src/lib/betaling/fragtUr.ts, 20261030010000), når handlen er sendt,
    // og meldingen må frigive penge (leveret_frigiver). Ingen penge flyttes
    // her. Startede uret, sender fragtUr beskeden ("48 timer til at melde en
    // fejl") - ellers den gamle besked. Står handlen stadig i
    // 'betaling_modtaget', starter cron-reserven uret, når sælgeren har
    // markeret pakken sendt.
    if (f.leveret_kl && !f.leveret_besked_kl) {
      let note: string | null = null;
      if (t.status === "pakke_sendt" || t.status === "modtaget") {
        const { startUrFraFragt, urStartetAfFragt } = await import("@/lib/betaling/fragtUr");
        // Idempotent (databasen + nøgle + fragt_ur_besked_kl) - også når
        // cron gentager efter et nedbrud, og uret allerede er startet.
        const start = await startUrFraFragt(t.id);
        const fraFragt = start.ok ? await urStartetAfFragt(t.id) : null;
        // Ukendt (databasen fejlede): ingen besked og ingen markering nu -
        // ellers kunne køberen få både den gamle besked og (når cron senere
        // starter uret) "48 timer til at melde en fejl". Cron prøver igen,
        // fordi leveret_besked_kl stadig er tom.
        if (fraFragt === null) return sendt;
        if (fraFragt) {
          await admin.rpc("forsendelse_marker_besked", { p_id: f.id, p_felt: "leveret", p_note: null });
          return sendt + 1;
        }
      }
      if (t.status === "betaling_modtaget" || t.status === "pakke_sendt") {
        await send(t.buyer_id, "pakke_leveret", {
          titel: "Pakken er kommet frem",
          tekst:
            t.status === "pakke_sendt"
              ? `Fragtfirmaet melder, at "${titel}" er leveret. Tryk "Jeg har modtaget pakken" på handelssiden, når du har den, og tjek varen.`
              : `Fragtfirmaet melder, at "${titel}" er leveret. Tjek varen, når du har den.`,
          link,
          data: { trade_id: t.id },
          noegle: `fragt_leveret:${t.id}`,
        });
        sendt++;
        if (t.status === "betaling_modtaget") {
          note = "Fragtfirmaet melder pakken leveret, men sælgeren har ikke markeret den sendt med pakkebilleder.";
        }
      } else if (t.status === "annulleret") {
        note = "Fragtfirmaet melder pakken leveret, men handlen er annulleret. Tjek handlen og pengene.";
      }
      await admin.rpc("forsendelse_marker_besked", { p_id: f.id, p_felt: "leveret", p_note: note });
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: handelseffekter", fejl: err });
  }
  return sendt;
}

// Som findForsendelse, men med forsendelsens transportør (webhook-ruten
// tjekker, at fragtfirmaets transportør passer).
export async function findForsendelseInfo(
  fragtfirma: string,
  ref: { forsendelsesId?: string | null; sporingsnummer?: string | null },
): Promise<({ id: string; transportoer: string | null } & ForsendelseKontekst) | null> {
  const id = await findForsendelse(fragtfirma, ref);
  if (!id) return null;
  const admin = createAdminClient();
  type Raekke = { trade_id: string; type: "udgaaende" | "retur"; levering: string | null; modtager: Adresse | null; transportoer?: string | null };
  let { data, error } = await admin
    .from("forsendelser")
    .select("trade_id, type, levering, modtager, transportoer")
    .eq("id", id)
    .maybeSingle<Raekke>();
  if (error && foerTransportoerMigration(error)) {
    ({ data, error } = await admin
      .from("forsendelser")
      .select("trade_id, type, levering, modtager")
      .eq("id", id)
      .maybeSingle<Raekke>());
  }
  if (error) throw new DbFejl(`forsendelser: ${error.message}`, error.code ?? null, null);
  if (!data) return null;
  // Hvor pakken skal hen: modtagerens adresse (på labelen) og - ved
  // pakkeshop - køberens pakkeshop.
  const steder: ForsendelseKontekst["steder"] = [];
  if (data.modtager) steder.push({ by: data.modtager.by ?? null, postnummer: data.modtager.postnummer ?? null });
  if (data.type === "udgaaende" && data.levering === "pakkeshop") {
    const { data: lev, error: lFejl } = await admin
      .from("handel_levering")
      .select("pakkeshop_by, pakkeshop_postnummer")
      .eq("trade_id", data.trade_id)
      .maybeSingle<{ pakkeshop_by: string | null; pakkeshop_postnummer: string | null }>();
    if (lFejl) throw new DbFejl(`handel_levering: ${lFejl.message}`, lFejl.code ?? null, null);
    if (lev) steder.push({ by: lev.pakkeshop_by, postnummer: lev.pakkeshop_postnummer });
  }
  return { id, transportoer: data.transportoer ?? null, type: data.type, steder };
}

// Statuskoder fra en webhook, adapteren ikke kender: ændrer aldrig status.
// Gemmes i fragt_ukendte_koder; drift får en advarsel første gang en kode
// ses. Kaster aldrig.
export async function registrerUkendteKoder(
  fragtfirma: string,
  visningsnavn: string,
  ukendte: { kode: string; liste: string | null; beskrivelse: string | null; sporingsnummer: string | null }[],
): Promise<number> {
  let nye = 0;
  try {
    const admin = createAdminClient();
    for (const u of ukendte.slice(0, 10)) {
      const { data: ny, error } = await admin.rpc("fragt_ukendt_kode_registrer", {
        p_fragtfirma: fragtfirma,
        p_kode: u.kode.slice(0, 60),
        p_liste: (u.liste ?? "").slice(0, 40),
        p_beskrivelse: u.beskrivelse?.slice(0, 300) ?? null,
        p_sporingsnummer: u.sporingsnummer?.slice(0, 100) ?? null,
      });
      if (error) throw new Error(`fragt_ukendt_kode_registrer: ${error.message}`);
      if (ny === true) {
        nye++;
        await logDriftFejl({
          kilde: "webhook",
          hvor: "Fragt: ukendt sporingskode",
          fejl:
            `${visningsnavn} sendte statuskoden ${u.kode} (${u.liste ?? "ukendt transportør"}), som BidHamr ikke kender. ` +
            "Den ændrer ikke pakkens status. Tilføj den i src/lib/fragt/shipmondo.ts (MONITOR_STATUSSER), hvis den skal bruges.",
        });
      }
    }
  } catch (err) {
    await logDriftFejl({ kilde: "webhook", hvor: "Fragt: ukendte koder", fejl: err });
  }
  return nye;
}

// Finder BidHamrs forsendelse ud fra fragtfirmaets id eller sporingsnummer.
export async function findForsendelse(
  fragtfirma: string,
  ref: { forsendelsesId?: string | null; sporingsnummer?: string | null },
): Promise<string | null> {
  const admin = createAdminClient();
  if (ref.forsendelsesId) {
    const { data } = await admin
      .from("forsendelser")
      .select("id")
      .eq("fragtfirma", fragtfirma)
      .eq("forsendelses_id", ref.forsendelsesId)
      .maybeSingle<{ id: string }>();
    if (data) return data.id;
  }
  if (ref.sporingsnummer) {
    // Nyeste først: en annulleret label og en ny kan i teorien dele nummer.
    const { data } = await admin
      .from("forsendelser")
      .select("id")
      .eq("fragtfirma", fragtfirma)
      .eq("sporingsnummer", ref.sporingsnummer)
      .order("oprettet_kl", { ascending: false })
      .limit(1);
    if (data && data.length > 0) return data[0].id as string;
  }
  return null;
}

// ------------------------------------------------------------ cron

const POLL_INTERVAL_MIN = 20;
const POLL_MAKS = 20;
const CRON_BUDGET_MS = 25_000;

const ANNULLER_MAKS = 10;

// Sporingsfeed (DAO): højst hvert 10. minut, og højst 12 sekunder til at gemme
// hændelserne i én kørsel. Reserve: pakke for pakke højst hver 12. time.
const FEED_INTERVAL_SEK = 10 * 60;
const FEED_BUDGET_MS = 12_000;
const FEED_RESERVE_INTERVAL_MIN = 12 * 60;
const FEED_RESERVE_MAKS = 5;
const EFTERLYSNING_MAKS = 5;

// Firmaer, hvis sporing kommer fra et feed (og som er sat op).
function feedFirmaer(): Fragtfirma[] {
  return FRAGTFIRMAER.map((n) => adapterFor(n)).filter(
    (a): a is Fragtfirma => !!a && typeof a.hentSporingFeed === "function",
  );
}

type FeedResultat = {
  haendelser: number;
  nye: number;
  ukendte: number;
  // Hændelser, der aldrig kunne gemmes, og som er sprunget over (poison).
  sprunget: number;
  // Hændelser, fragtfirmaet sendte, men som ikke kunne læses.
  ugyldige: number;
  gemt: boolean;
};

// En hændelse, der fejler i så mange kørsler, springes over (fragt_feed_fejl).
const FEED_POISON_MAKS = 3;
// Budgettet til at gemme hændelserne er aldrig under dette.
const FEED_MIN_BUDGET_MS = 3_000;
// Alarm, når samme token har fejlet så mange gange i træk (ca. 2 timer).
const FEED_ALARM_FEJL_I_TRAEK = 12;

// Ét feed-kald for et firma. Tokenet gemmes KUN, når alle hændelser er gemt
// (fragt_sporing_token_gem, compare-and-set, kun med vores lås). Ellers
// registreres en fejl, og næste kørsel henter de samme hændelser igen
// (idempotent). Budgettet regnes fra, at svaret er hentet. En hændelse, der
// aldrig kan gemmes, springes over efter FEED_POISON_MAKS kørsler, så feedet
// ikke står stille for altid. Kaster aldrig.
export async function koerSporingsfeed(firma: Fragtfirma, budgetMs = FEED_BUDGET_MS): Promise<FeedResultat | null> {
  if (!firma.hentSporingFeed) return null;
  if (firma.erSatOp && !firma.erSatOp()) return null;
  const admin = createAdminClient();
  const res: FeedResultat = { haendelser: 0, nye: 0, ukendte: 0, sprunget: 0, ugyldige: 0, gemt: false };
  const { data: claim, error: tFejl } = await admin.rpc("fragt_sporing_token_claim", {
    p_fragtfirma: firma.navn,
    p_interval_sek: FEED_INTERVAL_SEK,
  });
  if (tFejl) {
    await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: sporings-token", fejl: tFejl });
    return null;
  }
  const c = claim as { token?: unknown; laas?: unknown } | null;
  // Ikke tid endnu, eller en anden kørsel har låsen.
  if (!c || typeof c.token !== "string" || typeof c.laas !== "string") return null;
  const token = c.token;
  const laas = c.laas;
  const budget = Math.max(FEED_MIN_BUDGET_MS, Number.isFinite(budgetMs) ? budgetMs : FEED_BUDGET_MS);

  const fejl = async (grund: unknown, log: boolean) => {
    const { data: iTraek } = await admin.rpc("fragt_sporing_token_fejl", {
      p_fragtfirma: firma.navn,
      p_laas: laas,
      p_fejl: renFejltekst(grund, 300),
    });
    const n = Number(iTraek);
    // Drift ved første fejl og derefter hver 6. gang (ca. hver time).
    if (log && (n <= 1 || n % 6 === 0)) {
      await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: `Fragt: sporingsfeed (${firma.visningsnavn})`, fejl: grund });
    }
    if (n >= FEED_ALARM_FEJL_I_TRAEK && n % FEED_ALARM_FEJL_I_TRAEK === 0) {
      await logDriftFejl({
        kilde: "cron",
        sti: "fragt",
        hvor: "Fragt: sporingsfeed står stille",
        fejl: `Samme token hos ${firma.visningsnavn} har fejlet ${n} gange i træk, så sporingen er gået i stå. Seneste fejl: ${renFejltekst(grund, 200)}`,
      });
    }
  };
  const tidenEr = (slut: number) => Date.now() > slut;

  try {
    const feed = await medTimeout(firma.hentSporingFeed(token), 25_000, "hentSporingFeed");
    // Budgettet starter, når svaret er hentet.
    const slut = Date.now() + budget;

    res.ugyldige = Math.max(0, Number(feed.ugyldige ?? 0));
    if (res.ugyldige > 0) {
      await logDriftFejl({
        kilde: "cron",
        sti: "fragt",
        hvor: "Fragt: ulæselige sporingshændelser",
        fejl: `${res.ugyldige} hændelse(r) fra ${firma.visningsnavn} kunne ikke læses (fx uden tidspunkt eller kode) og er sprunget over.`,
      });
    }
    if (feed.afkortet) {
      await fejl(
        `Svaret fra ${firma.visningsnavn} var større end adapterens lofter og blev afkortet - tokenet gemmes ikke.`,
        true,
      );
      await logDriftFejl({
        kilde: "cron",
        sti: "fragt",
        hvor: "Fragt: sporingsfeed afkortet",
        fejl: `Sporingsfeedet fra ${firma.visningsnavn} var for stort til at blive læst helt. Tokenet er ikke gemt. Hæv lofterne i daoParse.ts.`,
      });
      return res;
    }

    // Ukendte koder: ændrer aldrig status. Gemmes, og drift får en advarsel
    // første gang en kode ses.
    const set = new Set<string>();
    for (const u of feed.ukendte) {
      const k = `${u.kode}|${u.liste ?? ""}`;
      if (set.has(k) || set.size >= 50) continue;
      if (tidenEr(slut)) {
        await fejl("Tidsbudgettet slap op under de ukendte koder - hændelserne hentes igen næste gang.", true);
        return res;
      }
      set.add(k);
      const { data: ny, error } = await admin.rpc("fragt_ukendt_kode_registrer", {
        p_fragtfirma: firma.navn,
        p_kode: u.kode,
        p_liste: u.liste ?? "",
        p_beskrivelse: u.beskrivelse,
        p_sporingsnummer: u.sporingsnummer,
      });
      if (error) throw new Error(`fragt_ukendt_kode_registrer: ${error.message}`);
      if (ny === true) {
        res.ukendte++;
        await logDriftFejl({
          kilde: "server",
          hvor: "Fragt: ukendt sporingskode",
          fejl:
            `${firma.visningsnavn} sendte hændelseskoden ${u.kode} (liste: ${u.liste ?? "ukendt"}), som BidHamr ikke kender. ` +
            "Den ændrer ikke pakkens status. Tilføj den i src/lib/fragt/daoKoder.ts (se fragt_ukendte_koder).",
        });
      }
    }

    // Kun vores egne forsendelser (opslag på sporingsnummer i klumper - en
    // databasefejl kaster, så tokenet ikke gemmes).
    const haendelser = [...feed.haendelser].sort((a, b) => a.tidspunkt.localeCompare(b.tidspunkt));
    const numre = [...new Set(haendelser.map((h) => h.sporingsnummer).filter((s): s is string => !!s))];
    const tilId = new Map<string, string>();
    for (let i = 0; i < numre.length; i += 100) {
      const { data, error } = await admin
        .from("forsendelser")
        .select("id, sporingsnummer, oprettet_kl")
        .eq("fragtfirma", firma.navn)
        .in("sporingsnummer", numre.slice(i, i + 100))
        .order("oprettet_kl", { ascending: true });
      if (error) throw new Error(`forsendelser (feed): ${error.message}`);
      // Nyeste vinder (som findForsendelse).
      for (const f of data ?? []) tilId.set(f.sporingsnummer as string, f.id as string);
    }

    // Hændelser, vi allerede har (de fleste ved en gentagelse), springes over
    // uden et kald pr. hændelse: ét opslag pr. klump af nøgler.
    const egne = (haendelser as WebhookHaendelse[])
      .map((h) => ({ h, id: h.sporingsnummer ? tilId.get(h.sporingsnummer) : undefined, noegle: h.noegle.slice(0, 200) }))
      .filter((x): x is { h: WebhookHaendelse; id: string; noegle: string } => !!x.id);
    // Klumper på højst 100 id'er og 100 nøgler pr. forespørgsel (URL-længde).
    const ids = [...new Set(egne.map((x) => x.id))];
    const findes = new Set<string>();
    for (let i = 0; i < ids.length; i += 100) {
      const idKlump = ids.slice(i, i + 100);
      const idSet = new Set(idKlump);
      const noegler = [...new Set(egne.filter((x) => idSet.has(x.id)).map((x) => x.noegle))];
      for (let j = 0; j < noegler.length; j += 100) {
        const { data, error } = await admin
          .from("forsendelse_haendelser")
          .select("forsendelse_id, noegle")
          .in("forsendelse_id", idKlump)
          .in("noegle", noegler.slice(j, j + 100));
        if (error) throw new Error(`forsendelse_haendelser (feed): ${error.message}`);
        for (const r of data ?? []) findes.add(`${r.forsendelse_id as string}|${r.noegle as string}`);
      }
    }

    for (const { h, id, noegle } of egne) {
      if (findes.has(`${id}|${noegle}`)) continue;
      if (tidenEr(slut)) {
        await fejl(
          `Tidsbudgettet slap op efter ${res.haendelser} nye af ${egne.length} hændelser - resten hentes igen næste gang.`,
          true,
        );
        return res;
      }
      try {
        const { ny } = await registrerForsendelseshaendelse(id, h, "sporing");
        res.haendelser++;
        if (ny) res.nye++;
      } catch (err) {
        // Midlertidig fejl (lås, timeout, forbindelse, 5xx): stop uden at
        // tælle - hele kørslen gentages næste gang.
        if (erMidlertidigFejl(err)) throw err;
        // Er det hændelsen (poison) eller databasen? Kan fejlen ikke engang
        // registreres, er databasen nede: stop, og prøv det hele igen.
        const { data: p, error: pFejl } = await admin.rpc("fragt_feed_haendelse_fejl", {
          p_fragtfirma: firma.navn,
          p_noegle: noegle,
          p_forsendelse: id,
          p_fejl: renFejltekst(err, 300),
          p_maks: FEED_POISON_MAKS,
          // Den rå (normaliserede) hændelse, så staff kan trykke "Prøv igen".
          p_haendelse: {
            type: h.type,
            tidspunkt: h.tidspunkt,
            noegle,
            beskrivelse: h.beskrivelse ?? null,
            raa: h.raa ?? null,
            sporingsnummer: h.sporingsnummer ?? null,
          },
        });
        if (pFejl) throw err;
        const pp = p as { opgivet?: boolean; nu?: boolean } | null;
        if (!pp?.opgivet) throw err;
        res.sprunget++;
        if (pp.nu) {
          await logDriftFejl({
            kilde: "cron",
            sti: "fragt",
            hvor: "Fragt: sporingshændelse sprunget over",
            fejl: `En hændelse fra ${firma.visningsnavn} kunne ikke gemmes i ${FEED_POISON_MAKS} kørsler og er sprunget over (forsendelse ${id}): ${renFejltekst(err, 200)}`,
          });
        }
      }
    }

    const { data: gemt, error: gFejl } = await admin.rpc("fragt_sporing_token_gem", {
      p_fragtfirma: firma.navn,
      p_laas: laas,
      p_gammel: token,
      p_ny: feed.nyToken,
      p_antal: haendelser.length,
    });
    if (gFejl) throw new Error(`fragt_sporing_token_gem: ${gFejl.message}`);
    res.gemt = gemt === true;
    return res;
  } catch (err) {
    await fejl(err, !(err instanceof FragtFejl));
    return res;
  }
}


// Staff: "Prøv igen" på sporingshændelser, som feedet opgav (fragt_feed_fejl).
// Den gemte hændelse registreres som en almindelig sporingshændelse
// (idempotent via nøglen) og markeres løst. Kaldere SKAL have tjekket
// staff-rollen og inhabilitet og logger selv i moderation_log.
export async function staffProevFeedHaendelserIgen(
  forsendelseId: string,
  staffId: string,
): Promise<{ ok: true; gemt: number; tradeId: string } | { fejl: string }> {
  const admin = createAdminClient();
  const { data: f } = await admin
    .from("forsendelser")
    .select("id, trade_id")
    .eq("id", forsendelseId)
    .maybeSingle<{ id: string; trade_id: string }>();
  if (!f) return { fejl: "Forsendelsen findes ikke." };
  const { data: raekker, error } = await admin
    .from("fragt_feed_fejl")
    .select("fragtfirma, noegle, haendelse")
    .eq("forsendelse_id", forsendelseId)
    .not("opgivet_kl", "is", null)
    .is("loest_kl", null)
    .limit(50);
  if (error) throw new Error(`fragt_feed_fejl: ${error.message}`);
  if (!raekker || raekker.length === 0) return { fejl: "Der er ingen sprungne sporingshændelser på forsendelsen." };
  let gemt = 0;
  const fejl: string[] = [];
  for (const r of raekker as { fragtfirma: string; noegle: string; haendelse: Record<string, unknown> | null }[]) {
    const h = r.haendelse;
    if (!h || !erSporingsType(h.type) || typeof h.tidspunkt !== "string" || h.noegle !== r.noegle) {
      fejl.push("Hændelsen er ikke gemt i et brugbart format - tjek sporingen hos fragtfirmaet.");
      continue;
    }
    try {
      await registrerForsendelseshaendelse(forsendelseId, {
        type: h.type,
        tidspunkt: h.tidspunkt,
        noegle: r.noegle,
        beskrivelse: typeof h.beskrivelse === "string" ? h.beskrivelse : null,
        raa: h.raa && typeof h.raa === "object" ? (h.raa as Record<string, unknown>) : null,
      }, "sporing");
      const { error: lFejl } = await admin.rpc("fragt_feed_fejl_loest", {
        p_fragtfirma: r.fragtfirma,
        p_noegle: r.noegle,
        p_staff: staffId,
      });
      if (lFejl) throw new Error(`fragt_feed_fejl_loest: ${lFejl.message}`);
      gemt++;
    } catch (err) {
      fejl.push(renFejltekst(err, 200));
    }
  }
  if (gemt === 0) return { fejl: `Hændelsen kunne stadig ikke gemmes: ${fejl[0] ?? "ukendt fejl"}` };
  return { ok: true, gemt, tradeId: f.trade_id };
}

// Efterlysning hos fragtfirmaet (ingen leveringsmelding 14 dage efter
// afsendelse). Højst én pr. forsendelse; opret-kaldet genforsøges aldrig
// (udebliver svaret, bliver den 'ukendt', og staff tjekker hos DAO).
// FRAGT_EFTERLYSNING_AKTIV=true slår kaldet til fragtfirmaet til; ellers
// får staff opgaven at efterlyse manuelt. Kaster aldrig.
async function koerEfterlysninger(admin: Admin, slut: number): Promise<number> {
  let antal = 0;
  // Firmaer med efterlysnings-API (DAO) og firmaer med sporing, men uden API
  // (Shipmondo - staff efterlyser manuelt).
  const firmaer = FRAGTFIRMAER.filter((n) => {
    const a = adapterFor(n);
    return typeof a?.opretEfterlysning === "function" || a?.efterlysningUdenApi === true;
  });
  if (firmaer.length === 0) return 0;
  try {
    const { data, error } = await admin.rpc("fragt_efterlysning_kandidater", {
      p_fragtfirmaer: firmaer,
      p_graense: EFTERLYSNING_MAKS,
    });
    if (error) throw new Error(`fragt_efterlysning_kandidater: ${error.message}`);
    for (const k of (data ?? []) as { forsendelse_id: string; fragtfirma: string; sporingsnummer: string }[]) {
      if (Date.now() > slut) break;
      const adapter = adapterFor(k.fragtfirma);
      const auto =
        process.env.FRAGT_EFTERLYSNING_AKTIV === "true" &&
        !!adapter?.opretEfterlysning &&
        (!adapter.erSatOp || adapter.erSatOp());
      const { data: c, error: cFejl } = await admin.rpc("fragt_efterlysning_claim", {
        p_forsendelse: k.forsendelse_id,
        p_auto: auto,
      });
      if (cFejl) throw new Error(`fragt_efterlysning_claim: ${cFejl.message}`);
      const claim = c as { kode?: string; id?: string; sporingsnummer?: string; vaerdi_oere?: number } | null;
      if (claim?.kode !== "ok" || !claim.id) continue;
      antal++;
      if (!auto || !adapter?.opretEfterlysning) continue;
      let status: "oprettet" | "afvist" | "ukendt" = "oprettet";
      let fejltekst: string | null = null;
      try {
        await medTimeout(
          adapter.opretEfterlysning(claim.sporingsnummer ?? k.sporingsnummer, {
            reference: k.forsendelse_id,
            vaerdiOere: Number(claim.vaerdi_oere ?? 0),
          }),
          25_000,
          "opretEfterlysning",
        );
      } catch (err) {
        status = err instanceof FragtFejl ? "afvist" : "ukendt";
        fejltekst = renFejltekst(err, 300);
        if (!(err instanceof FragtFejl)) {
          await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: efterlysning", fejl: err });
        }
      }
      const { error: aFejl } = await admin.rpc("fragt_efterlysning_afslut", {
        p_id: claim.id,
        p_status: status,
        p_fejl: fejltekst,
      });
      if (aFejl) throw new Error(`fragt_efterlysning_afslut: ${aFejl.message}`);
    }
  } catch (err) {
    await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: efterlysninger", fejl: err });
  }
  return antal;
}

// Henter sporing for aktive forsendelser (feed for DAO; ellers højst 20 pr.
// kørsel, hver højst hvert 20. minut) og sender beskeder, der mangler.
// Annullerer desuden labels på annullerede handler og forældreløse
// forsendelser og opretter efterlysninger. Let og begrænset - kaldes fra
// betalings-cron-ruten. Kaster aldrig.
export async function koerFragtCron(): Promise<{
  sporet: number;
  nyeHaendelser: number;
  beskeder: number;
  annulleret: number;
  fejl: number;
  feedHaendelser: number;
  foraeldreloese: number;
  efterlysninger: number;
}> {
  const r = {
    sporet: 0,
    nyeHaendelser: 0,
    beskeder: 0,
    annulleret: 0,
    fejl: 0,
    feedHaendelser: 0,
    foraeldreloese: 0,
    efterlysninger: 0,
  };
  const start = Date.now();
  const admin = createAdminClient();
  const feeds = feedFirmaer();
  const feedNavne = feeds.map((f) => f.navn);

  // Handlen er annulleret (afsendelsesfrist, afhentningsfrist, ubetalt, admin,
  // sag - uanset grund): annullér udgående labels, der ikke er afleveret, hos
  // fragtfirmaet. De eksisterende annulleringsfunktioner røres ikke - cron
  // finder dem her. Fejler annulleringen, markeres forsendelsen til staff
  // (højst 3 forsøg, 1 time imellem - se fragt_cron_annulleringer).
  const { data: annuller, error: annFejl } = await admin.rpc("fragt_cron_annulleringer", {
    p_graense: ANNULLER_MAKS,
  });
  if (annFejl) {
    r.fejl++;
    await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: find annulleringer", fejl: annFejl });
  } else {
    for (const a of (annuller ?? []) as { id: string; trade_id: string }[]) {
      if (Date.now() - start > CRON_BUDGET_MS / 2) break;
      const svar = await annullerForsendelse(admin, a.id, null);
      if ("ok" in svar) r.annulleret++;
      else r.fejl++;
    }
  }

  // Feed (DAO): ét kald henter alle nye hændelser.
  for (const firma of feeds) {
    if (Date.now() - start > CRON_BUDGET_MS / 2) break;
    const f = await koerSporingsfeed(firma, Math.min(FEED_BUDGET_MS, CRON_BUDGET_MS - (Date.now() - start) - 5_000));
    if (f) {
      r.feedHaendelser += f.haendelser;
      r.nyeHaendelser += f.nye;
      if (!f.gemt) r.fejl++;
    }
  }

  const graense = new Date(Date.now() - POLL_INTERVAL_MIN * 60_000).toISOString();
  const aeldst = new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString();
  let q = admin
    .from("forsendelser")
    .select("id, fragtfirma, sporingsnummer")
    .in("status", ["oprettet", "annulleres", "afleveret", "i_transit", "klar_til_afhentning"])
    .gte("oprettet_kl", aeldst)
    .or(`sidst_polled_kl.is.null,sidst_polled_kl.lt.${graense}`);
  // Feed-firmaer har deres egen (sjældnere) reserve herunder.
  if (feedNavne.length > 0) q = q.not("fragtfirma", "in", `(${feedNavne.join(",")})`);
  const { data: aktive, error } = await q
    .order("sidst_polled_kl", { ascending: true, nullsFirst: true })
    .limit(POLL_MAKS);
  if (error) {
    r.fejl++;
    await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: hent aktive", fejl: error });
    return r;
  }

  // Reserve for feed-firmaer: pakke for pakke, højst hver 12. time pr. pakke
  // (fx hvis et token er gået tabt hos DAO).
  let reserve: { id: string; fragtfirma: string; sporingsnummer: string | null }[] = [];
  if (feedNavne.length > 0 && Date.now() - start < CRON_BUDGET_MS / 2) {
    const rGraense = new Date(Date.now() - FEED_RESERVE_INTERVAL_MIN * 60_000).toISOString();
    const { data: rs, error: rFejl } = await admin
      .from("forsendelser")
      .select("id, fragtfirma, sporingsnummer")
      .in("fragtfirma", feedNavne)
      .in("status", ["oprettet", "annulleres", "afleveret", "i_transit", "klar_til_afhentning"])
      .gte("oprettet_kl", aeldst)
      .lt("oprettet_kl", rGraense)
      .or(`sidst_polled_kl.is.null,sidst_polled_kl.lt.${rGraense}`)
      .order("sidst_polled_kl", { ascending: true, nullsFirst: true })
      .limit(FEED_RESERVE_MAKS);
    if (rFejl) {
      r.fejl++;
      await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: hent reserve", fejl: rFejl });
    } else {
      reserve = (rs ?? []) as typeof reserve;
    }
  }

  for (const f of [...(aktive ?? []), ...reserve]) {
    if (Date.now() - start > CRON_BUDGET_MS) break;
    // Markér altid som hentet, så en fejlende forsendelse ikke blokerer køen.
    await admin
      .from("forsendelser")
      .update({ sidst_polled_kl: new Date().toISOString() })
      .eq("id", f.id);
    const adapter = adapterFor(f.fragtfirma as string);
    if (!adapter || !f.sporingsnummer) continue;
    if (adapter.erSatOp && !adapter.erSatOp()) continue;
    try {
      const haendelser = await medTimeout(
        adapter.hentSporing(f.sporingsnummer as string),
        10_000,
        "hentSporing",
      );
      r.sporet++;
      for (const h of haendelser.slice(0, 100)) {
        const { ny } = await registrerForsendelseshaendelse(f.id as string, h, "sporing");
        if (ny) r.nyeHaendelser++;
      }
    } catch (err) {
      r.fejl++;
      if (!(err instanceof FragtFejl)) {
        await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: hent sporing", fejl: err });
      }
    }
  }

  // Forældreløse forsendelser (oprettet hos DAO, men ikke brugt): annulleres.
  if (Date.now() - start < CRON_BUDGET_MS) {
    r.foraeldreloese = await annullerForaeldreloese(admin, null, 5, Math.max(0, CRON_BUDGET_MS - (Date.now() - start)));
  }

  // Efterlysning: ingen leveringsmelding 14 dage efter afsendelse.
  if (Date.now() - start < CRON_BUDGET_MS) {
    r.efterlysninger = await koerEfterlysninger(admin, start + CRON_BUDGET_MS);
  }

  // Gamle handler (fra før checkout), hvor køberen har startet betalingen
  // uden at vælge levering: én besked om at vælge levering. Betalingen kan
  // ikke gennemføres uden valget (sikrPaymentIntent annullerer den gamle
  // PaymentIntent).
  if (Date.now() - start < CRON_BUDGET_MS) {
    const { data: mangler, error: mFejl } = await admin.rpc("fragt_mangler_leveringsvalg", { p_graense: 20 });
    if (mFejl) {
      r.fejl++;
      await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: mangler leveringsvalg", fejl: mFejl });
    } else {
      for (const m of (mangler ?? []) as { trade_id: string; buyer_id: string; auction_id: string }[]) {
        if (Date.now() - start > CRON_BUDGET_MS) break;
        const { data: a } = await admin.from("auctions").select("titel").eq("id", m.auction_id).maybeSingle<{ titel: string | null }>();
        await send(m.buyer_id, "betalingsfrist", {
          titel: "Vælg levering",
          tekst: `Vælg, hvor du vil have "${a?.titel ?? "din vare"}" leveret – en pakkeshop eller levering til døren. Derefter kan du betale.`,
          link: `/mine-handler/${m.trade_id}`,
          data: { trade_id: m.trade_id },
          noegle: `vaelg_levering:${m.trade_id}`,
        });
        r.beskeder++;
      }
    }
  }

  // Beskeder, der mangler (fx serveren døde mellem hændelse og besked).
  if (Date.now() - start < CRON_BUDGET_MS) {
    const { data: mangler } = await admin
      .from("forsendelser")
      .select("id")
      .eq("type", "udgaaende")
      .not("status", "in", "(opretter,annulleret,fejlet)")
      .or(
        "and(afleveret_kl.not.is.null,afleveret_besked_kl.is.null)," +
          "and(leveret_kl.not.is.null,leveret_besked_kl.is.null)",
      )
      // Nyeste først, så en forsendelse, der bliver ved med at fejle, ikke
      // blokerer beskeder til nye handler.
      .order("opdateret_kl", { ascending: false })
      .limit(20);
    for (const m of mangler ?? []) {
      if (Date.now() - start > CRON_BUDGET_MS) break;
      r.beskeder += await udfoerHandelseffekter(admin, m.id as string);
    }
  }

  return r;
}

// Kun til test.
export const _test = { efterOpgivetOpret };
