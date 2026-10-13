import "server-only";

// DAO direkte (Filip, 9. okt. 2026 - i stedet for DAO via Shipmondo). Bygget
// ud fra DAO's offentlige dokumentation (https://api.dao.as/docs/v1/, version
// 132) UDEN nøgler og uden testmiljø: alt er afprøvet med egne eksempelsvar
// (src/lib/fragt/__fixtures__/dao/, tests/fragt/). Se docs/DAO-API.md for
// hvad der mangler (nøgler, hændelseskoder, Allans svar, vægtgrænse).
//
// Env (Filip sætter dem - aldrig i koden, aldrig i loggen):
//   DAO_KUNDEID      kunde-id hos DAO
//   DAO_KODE         "issued password for dao's parcel-api"
//   DAO_API_URL      valgfri, standard https://api.dao.as (kun https://*.dao.as)
//   DAO_TESTMODE     "true" = test=1 på ordrer (DAO opretter ingen stregkode
//                    og ingen ordrelinjer). Kun til afprøvning lokalt.
//   DAO_LABEL_PAPIR  valgfri, standard A4Foldable (60x100, 100x150,
//                    A4Foldable, 150x100, 100x150l, 100x150p)
//   FRAGTFIRMA=dao   gør DAO til det aktive fragtfirma (src/lib/fragt/index.ts)
//
// SIKKERHED: kundeid og kode står i URL'en (query) på alle kald. URL'en må
// ALDRIG logges eller stå i en fejl. Fejl bygges kun af stien (fx
// "/AnnullerePakke.php"), DAO's fejlkode og en saniteret fejltekst
// (saniter() i daoParse.ts fjerner også selve værdierne fra enhver tekst).
//
// Fejl: DAO svarer HTTP 200 med "status": "FEJL" (FindPakkeshop: "ERROR").
//   - FEJL/ERROR                  -> DaoFejl (en FragtFejl med dansk tekst).
//     På en ordre betyder det, at DAO har afvist - intet er oprettet.
//   - Læsekald (pakkeshops, label, sporing): timeout på 6 s og op til 2
//     genforsøg ved netværksfejl, timeout, 5xx/429 og ugyldigt svar.
//   - Skrivekald (ordre, annullering, efterlysning): ÉT forsøg (20 s), aldrig
//     genforsøg her. Timeout/netværk/5xx/ugyldigt svar på en ordre ->
//     FragtUkendtUdfald (vi ved ikke, om DAO har oprettet pakken).
//
// Idempotens: DAO har intet opslag på `reference`. En ordre, der aldrig
// indleveres, faktureres ikke. Derfor har adapteren genforsoegOpretterNy:
// efter et ukendt udfald laver næste forsøg en NY forsendelse, og en kendt,
// forældreløs stregkode annulleres (server.ts, opretForsendelse).
import { logDriftFejl } from "@/lib/drift";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { DAO_RETUR_ER_IKKE_AFHENTET } from "@/lib/fragt/daoKoder";
import {
  feedFraSvar,
  gyldigStregkode,
  pakkeshopsFraResultat,
  parseDaoJson,
  renLabelfriKode,
  saniter,
  sporingFraResultat,
  tolkSvar,
  felt,
  type DaoSvar,
} from "@/lib/fragt/daoParse";
import {
  type Adresse,
  type ForsendelseInput,
  type Fragtfirma,
  type Label,
  type OprettetForsendelse,
  type Pakkeshop,
  type PakkeshopSoegning,
  type Pakkestoerrelse,
  type SporingsFeed,
  type Sporingshaendelse,
  FragtFejl,
  FragtUkendtUdfald,
  FRAGT_IKKE_SAT_OP,
} from "@/lib/fragt/types";

// Fragtfirmaets produktkoder. Samme koder som DAO via Shipmondo, så
// kostprisen (fragt_forventet_kostpris_oere: DAO_STS = shop2shop, DAO_STH =
// shop2home) og admin virker uændret.
export const DAO_SHOP2SHOP = "DAO_STS";
export const DAO_SHOP2HOME = "DAO_STH";

// Vægtgrænser fra Shipmondos sandbox (DAO_STS 250 g-15 kg, DAO_STH 250 g-5 kg).
// TODO(DAO): bekræft med Allan (vægt- og målgrænser for Shop2Shop/Shop2Home).
const MAKS_GRAM: Record<Pakkestoerrelse, number> = { lille: 1000, mellem: 5000, stor: 15000 };
const PAKKESHOP_MAKS_GRAM = 15000;
const DOER_MAKS_GRAM = 5000;
// DAO's feltlængder (daoHOME-ordren): navn og adresse højst 45 tegn.
const MAKS_FELT = 45;

const LAES_TIMEOUT_MS = 6_000;
const LAES_FORSOEG = 3;
const SKRIV_TIMEOUT_MS = 20_000;

const PAPIR = ["60x100", "100x150", "A4Foldable", "150x100", "100x150l", "100x150p"] as const;

// ------------------------------------------------------------ konfiguration

type Konfig = { base: string; kundeid: string; kode: string; test: boolean; papir: string };

function laesKonfig(): Konfig | null {
  const base = (process.env.DAO_API_URL ?? "https://api.dao.as").trim().replace(/\/+$/, "");
  const kundeid = (process.env.DAO_KUNDEID ?? "").trim();
  const kode = (process.env.DAO_KODE ?? "").trim();
  // Kun https og kun DAO's egne domæner (nøglerne sendes i URL'en).
  if (!/^https:\/\/([a-z0-9-]+\.)*dao\.as$/i.test(base)) return null;
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(kundeid) || kode.length === 0 || kode.length > 200 || /\s/.test(kode)) {
    return null;
  }
  const papir = (process.env.DAO_LABEL_PAPIR ?? "A4Foldable").trim();
  return {
    base,
    kundeid,
    kode,
    test: process.env.DAO_TESTMODE === "true",
    papir: (PAPIR as readonly string[]).includes(papir) ? papir : "A4Foldable",
  };
}

function konfig(): Konfig {
  const k = laesKonfig();
  // Ingen detaljer om værdierne - kun hvilke variabler det drejer sig om.
  if (!k) throw new FragtFejl(FRAGT_IKKE_SAT_OP, "DAO er ikke sat op (DAO_KUNDEID/DAO_KODE/DAO_API_URL).");
  return k;
}

// Saniterer en tekst med de aktuelle hemmeligheder (også når konfigurationen
// er ugyldig - så står værdierne stadig ikke i loggen).
function ren(tekst: unknown): string {
  return saniter(String(tekst ?? ""), [process.env.DAO_KODE?.trim(), process.env.DAO_KUNDEID?.trim()]);
}

// ------------------------------------------------------------ fejl

// DAO afviste kaldet (status FEJL/ERROR). brugerbesked er dansk og må vises.
export class DaoFejl extends FragtFejl {
  readonly fejlkode: string | null;
  readonly sti: string;
  constructor(sti: string, fejlkode: string | null, fejltekst: string | null, brugerbesked: string) {
    super(brugerbesked, ren(`DAO ${sti}: FEJL ${fejlkode ?? "?"} ${fejltekst ?? ""}`.trim()));
    this.name = "DaoFejl";
    this.fejlkode = fejlkode;
    this.sti = sti;
  }
}

// Kendte fejlkoder -> dansk tekst. Hele listen hentes med FejlKoder.php, når
// nøglerne er der. TODO(DAO): udvid, når listen er kendt.
const FEJLKODER: Record<string, string> = {
  "1": "Fragtfirmaet kunne ikke finde adressen. Tjek vejnavn og husnummer.",
};

type Hvad = "opret" | "pakkeshop" | "label" | "annuller" | "sporing" | "efterlysning";

const FEJL_STANDARD: Record<Hvad, string> = {
  opret: "Fragtfirmaet kunne ikke oprette pakken. Tjek adresserne, og prøv igen.",
  pakkeshop: "Pakkeshops kunne ikke hentes. Prøv igen om lidt, eller søg kun på postnummer.",
  label: "Labelen kunne ikke hentes hos fragtfirmaet. Prøv igen om lidt.",
  annuller:
    "Fragtfirmaet kan ikke annullere labelen. Er pakken allerede afleveret, kan den ikke annulleres. Skriv til BidHamr, hvis du ikke har afleveret den.",
  sporing: "Sporingen kunne ikke hentes hos fragtfirmaet.",
  efterlysning: "Fragtfirmaet afviste efterlysningen.",
};

function daoFejl(sti: string, hvad: Hvad, fejlkode: string | null, fejltekst: string | null): DaoFejl {
  const kendt = hvad === "opret" && fejlkode ? FEJLKODER[fejlkode] : undefined;
  return new DaoFejl(sti, fejlkode, fejltekst, kendt ?? FEJL_STANDARD[hvad]);
}

// Netværk/timeout/5xx på et læsekald efter alle forsøg (ikke en FragtFejl:
// serveren logger den i drift og viser en generisk tekst).
class DaoIkkeSvar extends Error {
  constructor(sti: string, grund: string) {
    super(ren(`DAO ${sti}: ${grund}`));
    this.name = "DaoIkkeSvar";
  }
}

// ------------------------------------------------------------ HTTP

type Param = string | number | null | undefined;

function byggUrl(k: Konfig, sti: string, params: Record<string, Param>, medFormat = true): string {
  const q = new URLSearchParams();
  q.set("kundeid", k.kundeid);
  q.set("kode", k.kode);
  if (medFormat) q.set("format", "JSON");
  for (const [n, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    q.set(n, String(v));
  }
  return `${k.base}${sti}?${q.toString()}`;
}

function grundTekst(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
    return `netværksfejl (${err.name})`;
  }
  return "netværksfejl";
}

type RaaSvar = { status: number; type: string; bytes: Uint8Array };

// Ét HTTP-kald. Kaster DaoIkkeSvar ved netværk/timeout (uden URL).
async function hent(url: string, sti: string, timeoutMs: number): Promise<RaaSvar> {
  let svar: Response;
  try {
    svar = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json, application/pdf" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "error",
    });
  } catch (err) {
    throw new DaoIkkeSvar(sti, grundTekst(err));
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await svar.arrayBuffer());
  } catch (err) {
    throw new DaoIkkeSvar(sti, grundTekst(err));
  }
  return { status: svar.status, type: (svar.headers.get("content-type") ?? "").toLowerCase(), bytes };
}

const vent = (ms: number) => new Promise((r) => setTimeout(r, ms));

function erPdf(r: RaaSvar): boolean {
  return (
    r.type.includes("application/pdf") ||
    (r.bytes.length > 4 && r.bytes[0] === 0x25 && r.bytes[1] === 0x50 && r.bytes[2] === 0x44 && r.bytes[3] === 0x46)
  );
}

function tekstAf(r: RaaSvar): string {
  return new TextDecoder("utf-8").decode(r.bytes.slice(0, 2_000_000));
}

type OkSvar = Extract<DaoSvar, { status: "ok" }>;

// Læsekald med genforsøg (kun idempotente GET's: pakkeshops, label, sporing).
// FEJL fra DAO genforsøges ikke - det er et svar. tolk() returnerer null for
// "ugyldigt svar" (prøv igen).
async function laes<T>(
  sti: string,
  params: Record<string, Param>,
  hvad: Hvad,
  medFormat: boolean,
  tolk: (r: RaaSvar, s: DaoSvar) => T | null,
  ugyldigTekst: string,
): Promise<T> {
  const k = konfig();
  const url = byggUrl(k, sti, params, medFormat);
  let sidste = "ingen svar";
  for (let forsoeg = 1; forsoeg <= LAES_FORSOEG; forsoeg++) {
    if (forsoeg > 1) await vent(300 * forsoeg);
    let r: RaaSvar;
    try {
      r = await hent(url, sti, LAES_TIMEOUT_MS);
    } catch (err) {
      sidste = err instanceof Error ? err.message : "netværksfejl";
      continue;
    }
    if (r.status >= 500 || r.status === 429 || r.status === 408) {
      sidste = `HTTP ${r.status}`;
      continue;
    }
    const s = erPdf(r) ? ({ status: "ugyldig" } as const) : tolkSvar(parseDaoJson(tekstAf(r)));
    if (s.status === "fejl") throw daoFejl(sti, hvad, s.fejlkode, s.fejltekst);
    if (r.status !== 200) {
      // 4xx uden et DAO-svar (fx forkert sti eller afvist adgang): ingen grund
      // til at prøve igen.
      throw new DaoIkkeSvar(sti, `HTTP ${r.status}`);
    }
    const v = tolk(r, s);
    if (v !== null) return v;
    sidste = ugyldigTekst;
  }
  throw new DaoIkkeSvar(sti, sidste);
}

function laesJson(sti: string, params: Record<string, Param>, hvad: Hvad): Promise<OkSvar> {
  return laes(sti, params, hvad, true, (_r, s) => (s.status === "ok" ? s : null), "ugyldigt svar (ingen status)");
}

function laesPdf(sti: string, params: Record<string, Param>, hvad: Hvad): Promise<Uint8Array> {
  return laes(sti, params, hvad, false, (r) => (erPdf(r) ? r.bytes : null), "svaret var hverken PDF eller en fejl");
}

// Skrivekald: ÉT forsøg. Netværk/timeout/5xx/ugyldigt svar -> FragtUkendtUdfald
// (DAO kan have udført kaldet). FEJL -> DaoFejl. 4xx uden DAO-svar (forkert
// sti/adgang) -> FragtFejl: kaldet nåede ikke DAO's logik.
async function skriv(sti: string, params: Record<string, Param>, hvad: Hvad) {
  const k = konfig();
  const url = byggUrl(k, sti, params);
  let r: RaaSvar;
  try {
    r = await hent(url, sti, SKRIV_TIMEOUT_MS);
  } catch (err) {
    throw new FragtUkendtUdfald(err instanceof Error ? err.message : ren(`DAO ${sti}: netværksfejl`));
  }
  if (r.status >= 500 || r.status === 408 || r.status === 429) {
    throw new FragtUkendtUdfald(ren(`DAO ${sti}: HTTP ${r.status}`));
  }
  const s = tolkSvar(parseDaoJson(tekstAf(r)));
  if (s.status === "fejl") throw daoFejl(sti, hvad, s.fejlkode, s.fejltekst);
  if (r.status !== 200) {
    throw new FragtFejl(FEJL_STANDARD[hvad], ren(`DAO ${sti}: HTTP ${r.status} uden DAO-svar`));
  }
  if (s.status !== "ok") throw new FragtUkendtUdfald(ren(`DAO ${sti}: ugyldigt svar (ingen status)`));
  return s;
}

// ------------------------------------------------------------ adresser

// DAO vil have mobil som tal. Danske numre sendes som 8 cifre.
// TODO(DAO): med eller uden 45 foran? (pickup-endpoints vil have 45).
export function daoMobil(t: string | null | undefined): string | null {
  const tal = (t ?? "").replace(/[\s().-]/g, "");
  const m = /^(?:\+45|0045)?(\d{8})$/.exec(tal);
  return m ? m[1] : null;
}

function navnFelt(navn: string): string {
  return navn.replace(/\s+/g, " ").trim().slice(0, MAKS_FELT);
}

function adresseFelt(a: Adresse, hvem: "afsender" | "modtager"): { adresse: string; postnr: string } {
  const adresse = (a.adresse ?? "").replace(/\s+/g, " ").trim();
  const postnr = (a.postnummer ?? "").trim();
  if (!adresse || !/^\d{4}$/.test(postnr)) {
    throw new FragtFejl(hvem === "afsender" ? "Udfyld din adresse, før du sender pakken." : "Modtagerens adresse mangler.");
  }
  // Afkort aldrig en adresse (pakken kunne havne forkert) - bed om en kortere.
  if (adresse.length > MAKS_FELT) {
    throw new FragtFejl(
      hvem === "afsender"
        ? `Din adresse er for lang til fragtfirmaet (højst ${MAKS_FELT} tegn). Forkort den, fx "Vesterbrogade 10, 2. th".`
        : `Modtagerens adresse er for lang til fragtfirmaet (højst ${MAKS_FELT} tegn).`,
    );
  }
  return { adresse, postnr };
}

// ------------------------------------------------------------ label

async function hentLabelPdf(stregkode: string): Promise<Uint8Array> {
  if (!gyldigStregkode(stregkode)) throw new FragtFejl("Forsendelsen findes ikke hos fragtfirmaet.");
  const k = konfig();
  const pdf = await laesPdf("/HentLabel.php", { stregkode, papir: k.papir }, "label");
  if (pdf.byteLength > 5 * 1024 * 1024) throw new DaoIkkeSvar("/HentLabel.php", "labelen er for stor");
  return pdf;
}

// ------------------------------------------------------------ oprettelse

// Fejl fra opret():
//   FragtFejl          validering før kaldet, DAO afviste ordren (FEJL), eller
//                      PDF og labelfri kode mangler, og pakken er annulleret
//                      igen. Intet aktivt er oprettet hos DAO.
//   FragtUkendtUdfald  timeout/netværk/5xx/ugyldigt svar på ordren: vi ved
//                      ikke, om DAO har oprettet den (DAO kan ikke slå op på
//                      reference). Er stregkoden kendt, står den i
//                      foraeldreloesId, så serveren kan annullere den.
async function opret(input: ForsendelseInput, retur: boolean): Promise<OprettetForsendelse> {
  // 1. Validering før ethvert kald.
  const levering = retur ? "pakkeshop" : (input.levering ?? "pakkeshop");
  const vaegt = Math.max(1, Math.round(input.vaegtGram ?? MAKS_GRAM[input.pakkestoerrelse]));
  if (vaegt > PAKKESHOP_MAKS_GRAM) throw new FragtFejl("Pakken er for tung til at blive sendt.");
  if (levering === "doer" && vaegt > DOER_MAKS_GRAM) {
    throw new FragtFejl("Levering til døren kan kun bruges op til 5 kg.");
  }
  if (levering === "pakkeshop" && !retur && !input.pakkeshopId) {
    throw new FragtFejl("Køberen har ikke valgt en pakkeshop.");
  }
  if (input.pakkeshopId && !/^[A-Za-z0-9_-]{1,50}$/.test(input.pakkeshopId)) {
    throw new FragtFejl("Pakkeshoppen findes ikke længere. Køberen skal vælge en anden.");
  }
  const mod = adresseFelt(input.modtager, "modtager");
  const afs = adresseFelt(input.afsender, "afsender");
  const modMobil = daoMobil(input.modtager.telefon);
  const modEmail = (input.modtager.email ?? "").trim() || null;
  // DAO sender SMS/mail til modtageren (pakken er klar). Mindst én skal med.
  if (!modMobil && !modEmail) throw new FragtFejl("Modtagerens e-mail eller mobilnummer mangler.");
  const k = konfig();

  const params: Record<string, Param> = {
    navn: navnFelt(input.modtager.navn),
    adresse: mod.adresse,
    postnr: mod.postnr,
    mobil: modMobil,
    email: modEmail ? modEmail.slice(0, 60) : null,
    afsender: navnFelt(input.afsender.navn),
    afsender_adresse: afs.adresse,
    afsender_postnr: afs.postnr,
    afs_mobil: daoMobil(input.afsender.telefon),
    afs_email: input.afsender.email ? input.afsender.email.trim().slice(0, 60) : null,
    vaegt,
    // TODO(DAO): mål (l, h, b i cm) - dokumentationen siger intet om, de er
    // krævet. Sendes ikke, før Allan har svaret.
    reference: input.reference.slice(0, 60),
    test: k.test ? 1 : null,
  };
  let sti: string;
  if (levering === "doer") {
    // Shop2Home: indlevering i pakkeshop, levering med daoHOME.
    sti = "/DAODirekte/ShoptildirekteLeveringsordre.php";
  } else {
    // Shop2Shop (c2c). Retur: shopid 0 = DAO vælger shoppen nærmest
    // modtageren (sælgeren). idkrav sendes ikke (standard: udleveringskode).
    sti = "/DAOPakkeshop/c2cindleveringsordre.php";
    params.shopid = retur ? "0" : input.pakkeshopId;
  }

  // 2. Opret (ét forsøg).
  const svar = await skriv(sti, params, "opret");
  const r = svar.resultat ?? svar.rod;
  const stregkodeRaa = felt(r, "stregkode", "barcode") ?? felt(svar.rod, "stregkode", "barcode");
  const stregkode = typeof stregkodeRaa === "number" ? String(stregkodeRaa) : stregkodeRaa;
  if (!gyldigStregkode(stregkode)) {
    // OK uden (gyldig) stregkode: vi ved ikke, hvad DAO har oprettet.
    throw new FragtUkendtUdfald(ren(`DAO ${sti}: OK uden gyldig stregkode (reference ${input.reference})`));
  }
  const labelfri = renLabelfriKode(
    felt(r, "labellesskode", "labelless_code", "labellessCode", "labelfrikode") ??
      felt(svar.rod, "labellesskode", "labelless_code"),
  );

  // 3. PDF-label (læsekald med genforsøg). Uden PDF virker den labelfri kode
  // stadig - så gemmes forsendelsen, og PDF'en hentes, når sælgeren beder om
  // den. Uden både PDF og kode kan sælgeren intet bruge: pakken annulleres
  // igen hos DAO.
  let label: Label | null = null;
  try {
    label = { type: "pdf", data: await hentLabelPdf(stregkode) };
  } catch (err) {
    if (!labelfri) {
      try {
        await annuller(stregkode);
      } catch {
        throw new FragtUkendtUdfald(
          ren(`DAO ${sti}: pakken ${stregkode} blev oprettet, men hverken label eller labelfri kode kunne hentes, og annulleringen fejlede`),
          { foraeldreloesId: stregkode },
        );
      }
      throw new FragtFejl(FEJL_STANDARD.label, ren(`DAO: ingen label til ${stregkode} (${err instanceof Error ? err.message : "ukendt"}) - annulleret igen`));
    }
    await logDriftFejl({
      kilde: "server",
      hvor: "DAO: label-PDF",
      fejl: ren(`PDF til ${stregkode} kunne ikke hentes (${err instanceof Error ? err.message : "ukendt"}). Den labelfri kode virker; PDF'en hentes igen, når sælgeren beder om den.`),
    });
  }

  return {
    forsendelsesId: stregkode,
    sporingsnummer: stregkode,
    label,
    qrKode: labelfri,
    // DAO's svar har ingen pris - den kommer fra aftalen (fragt_kostpriser).
    prisOere: null,
    produkt: levering === "doer" ? DAO_SHOP2HOME : DAO_SHOP2SHOP,
  };
}

// ------------------------------------------------------------ annullering

// AnnullerePakke. FEJL (fx efter indlevering) -> FragtFejl: labelen bliver
// stående som aktiv i BidHamr. Adapteren kaster ALDRIG FragtAnnulleringIkkeMulig:
// en DAO-label er kun 'annulleret' i BidHamr, når DAO har bekræftet det -
// det bygger forsendelse_claim's lempede labelgrænse på.
async function annuller(stregkode: string): Promise<void> {
  if (!gyldigStregkode(stregkode)) throw new FragtFejl("Forsendelsen findes ikke hos fragtfirmaet.");
  try {
    await skriv("/AnnullerePakke.php", { stregkode }, "annuller");
  } catch (err) {
    // Annullering er ikke en oprettelse: et udeblevet svar er en almindelig
    // fejl (serveren ruller tilbage til 'oprettet' og markerer staff).
    if (err instanceof FragtUkendtUdfald) throw new Error(err.message);
    throw err;
  }
}

// ------------------------------------------------------------ pakkeshops

async function soeg(q: PakkeshopSoegning): Promise<Pakkeshop[]> {
  const opslag = slaaPostnummerOp(q.postnummer);
  if (!opslag) throw new FragtFejl("Ukendt postnummer.");
  const antal = Math.min(Math.max(q.antal ?? 10, 1), 20);
  const params = { postnr: opslag.postnummer, adresse: q.adresse ? q.adresse.slice(0, 100) : null, antal };
  try {
    const r = await laesJson("/DAOPakkeshop/FindPakkeshop.php", params, "pakkeshop");
    return pakkeshopsFraResultat(r.resultat).slice(0, antal);
  } catch (err) {
    // Adressen kunne ikke bruges: prøv én gang kun med postnummeret.
    if (err instanceof DaoFejl && params.adresse) {
      const r = await laesJson("/DAOPakkeshop/FindPakkeshop.php", { ...params, adresse: null }, "pakkeshop");
      return pakkeshopsFraResultat(r.resultat).slice(0, antal);
    }
    throw err;
  }
}

// ------------------------------------------------------------ sporing

async function sporing(stregkode: string): Promise<Sporingshaendelse[]> {
  if (!gyldigStregkode(stregkode)) return [];
  const r = await laesJson("/TrackNTrace_v2.php", { stregkode, sprog: "DA" }, "sporing");
  // Ukendte koder ignoreres her - feedet registrerer dem (fragt_ukendte_koder).
  return sporingFraResultat(stregkode, r.resultat).haendelser;
}

// Ét kald: alle nye hændelser på ALLE vores pakker siden tokenet. Start med
// token "0". Læsekald (samme token giver samme svar), så det må genforsøges.
async function feed(token: string): Promise<SporingsFeed> {
  if (!/^\d{1,20}$/.test(token)) throw new Error("DAO Track & Trace: ugyldigt token");
  const r = await laesJson("/TrackNTrace_v2.php", { token, sprog: "DA" }, "sporing");
  const f = feedFraSvar(r.rod, r.resultat);
  return { nyToken: f.nyToken, haendelser: f.haendelser, ukendte: f.ukendte };
}

// ------------------------------------------------------------ efterlysning

// createclaim.php?type=bortkommet. Ingen billeder, ingen status og intet
// sags-id i svaret. pris: TODO(DAO) - enhed og betydning (varens værdi i hele
// kroner?) skal bekræftes af Allan; vi sender buddet i hele kroner.
async function efterlysning(stregkode: string, opts: { reference: string; vaerdiOere: number }): Promise<void> {
  if (!gyldigStregkode(stregkode)) throw new FragtFejl("Forsendelsen findes ikke hos fragtfirmaet.");
  const kr = Math.max(0, Math.round(opts.vaerdiOere / 100));
  await skriv(
    "/createclaim.php",
    { type: "bortkommet", stregkode, referencenr: opts.reference.slice(0, 60), pris: kr },
    "efterlysning",
  );
}

// ------------------------------------------------------------ adapter

export const daoFirma: Fragtfirma = {
  navn: "dao",
  visningsnavn: "DAO",
  // Slået fra, til returkoden er set på en rigtig pakke (daoKoder.ts).
  returErIkkeAfhentet: DAO_RETUR_ER_IKKE_AFHENTET,
  genforsoegOpretterNy: true,
  erSatOp: () => laesKonfig() !== null,

  // Købers pris kommer fra databasen (fragt_pakkestoerrelser) - DAO har intet
  // pris-endpoint.
  async beregnPris() {
    throw new FragtFejl("Fragtprisen står på auktionen.", "beregnPris bruges ikke for DAO");
  },

  opretForsendelse: (input) => opret(input, false),
  // Retur i sager: Shop2Shop med køberen som afsender og sælgeren som
  // modtager (shopid 0 = DAO vælger shoppen nærmest sælgeren). returordre.php
  // leverer til DAO-kundens egen adresse og passer ikke til private sælgere.
  opretReturforsendelse: (input) => opret(input, true),
  annullerForsendelse: annuller,
  hentSporing: sporing,
  hentSporingFeed: feed,
  opretEfterlysning: efterlysning,

  async hentLabel(forsendelsesId) {
    return { type: "pdf", data: await hentLabelPdf(forsendelsesId) };
  },

  // DAO har ingen webhook - kun polling (feedet i fragt-cron'en).
  async fortolkWebhook() {
    return { ok: false, status: 404, fejl: "DAO har ingen webhook" };
  },

  soegPakkeshops: soeg,

  // DAO kan ikke slå én shop op på id: søg nær køberen og find id'et.
  async hentPakkeshop(id, naer) {
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(id)) return null;
    const liste = await soeg({ ...naer, antal: 20 });
    return liste.find((p) => p.id === id) ?? null;
  },
};

// Kun til test.
export const _test = { byggUrl, laesKonfig, ren };
