// Faktura fra firma til køber (Filip, 27. okt. 2026 - ROADMAP-BESLUTNINGER
// "Faktura fra firma til køber - klar til afsendelse"). Firmaet udsteder og
// sender; BidHamr laver kun kladden. Databasen bygger indholdet
// (public.firma_faktura_byg, 20261102330000_firma_fakturaer.sql) og låser det
// ved afsendelsen. Denne fil har typerne, samme momsberegning (til test og
// kontrol), tekster og CSV-eksporten. Ingen server-only: bruges også i
// klienten (Send-knappen).
//
// INTET SENDES AUTOMATISK. Den eneste vej til 'sendt' er firmaets eget tryk
// på "Send" (sendFirmaFaktura i src/app/actions/firmaFaktura.ts ->
// public.firma_faktura_send, der kræver firmaets indloggede bruger).

export type Momsordning = "moms" | "brugtmoms";

// Beløb i øre. enhedspris_oere og beloeb_oere er inkl. moms (buddet).
// Ved almindelig moms har linjen også enhedspris og beløb ekskl. moms
// (netto_oere), momssats og momsbeløb (momsbekendtgørelsen § 58, stk. 1).
// Ældre øjebliksbilleder (før 20261102390000) mangler
// enhedspris_ekskl_moms_oere og moms_sats.
export type FirmaFakturaLinje = {
  tekst: string;
  antal: number;
  enhedspris_oere: number;
  beloeb_oere: number;
  enhedspris_ekskl_moms_oere?: number | null;
  netto_oere: number | null;
  moms_sats?: number | null;
  moms_oere: number | null;
};

export type FirmaFakturaPart = {
  navn?: string | null;
  firmanavn?: string | null;
  cvr: string | null;
  adresse: string | null;
  postnummer: string | null;
  by: string | null;
  email: string | null;
  telefon?: string | null;
  logo_url?: string | null;
  // Stien i avatar-bucketten, fastholdt i øjebliksbilledet (20261102390000).
  logo_sti?: string | null;
};

export type ManglerKode =
  | "ikke_betalt"
  | "refunderet"
  | "beloeb"
  | "koeber_navn"
  | "koeber_adresse"
  | "koeber_postnummer"
  | "koeber_by"
  | "koeber_email";

export type FirmaFakturaData = {
  id: string;
  type: "faktura" | "kreditnota";
  status: "kladde" | "sendt";
  trade_id: string;
  fakturanummer: string | null;
  nummer?: number | null;
  udstedt_dato: string | null;
  sendt_kl: string | null;
  krediterer: { id: string; fakturanummer: string | null; udstedt_dato: string | null } | null;
  saelger: FirmaFakturaPart & { firmanavn: string; cvr: string };
  koeber: FirmaFakturaPart & { navn: string | null };
  linjer: FirmaFakturaLinje[];
  // Varens stand (stand_normaliser), fx "ny_med_maerke".
  vare_stand?: string | null;
  momsordning: Momsordning;
  moms_sats: number | null;
  beloeb_ekskl_moms_oere: number | null;
  moms_oere: number | null;
  total_oere: number;
  brugtmoms_tekst: string | null;
  brugtmoms_forklaring?: string | null;
  leveringsdato: string | null;
  betalingstekst: string;
  mangler: ManglerKode[];
};

export type FirmaFakturaRaekke = {
  id: string;
  type: "faktura" | "kreditnota";
  status: "kladde" | "sendt";
  trade_id: string;
  krediterer_id: string | null;
  kreditnota_id: string | null;
  kreditnota_status: "kladde" | "sendt" | null;
  // Sat, når kreditnotaen til fakturaen er sendt.
  krediteret_kl: string | null;
  // Den nye faktura på handlen efter kreditnotaen (hvis lavet).
  ny_faktura_id: string | null;
  // Vis "Lav ny faktura" (krediteret, ingen ny endnu, handlen ikke refunderet).
  kan_lave_ny: boolean;
  momsordning_fra_standard: boolean;
  // Firmaet har sat en modtager-e-mail, der afviger fra købers.
  email_afviger: boolean;
  fakturanummer: string | null;
  nummer: number | null;
  sendt_kl: string | null;
  mail_sendt_kl: string | null;
  mail_fejl: string | null;
  oprettet_kl: string;
  data: FirmaFakturaData | null;
};

export type FirmaFakturaIndstillinger = {
  praefiks: string;
  naeste_nummer: number;
  cifre: number;
  naeste_fakturanummer: string;
  momsordning: Momsordning;
  betalingstekst: string;
  svar_email: string | null;
  vis_logo: boolean;
  nummer_laast: boolean;
  // Lukket firmakonto: kan se og eksportere, men ikke sende eller rette.
  kun_laes: boolean;
};

export type FirmaFakturaListe = { indstillinger: FirmaFakturaIndstillinger; fakturaer: FirmaFakturaRaekke[] };

// Lovens ordlyd: momssystemdirektivets art. 226, nr. 14 / momsbekendtgørelsen
// § 58. Samme tekst som public.firma_faktura_byg (20261102390000).
export const BRUGTMOMS_FAKTURA_TEKST = "Fortjenstmargenordning – brugte genstande";
export const BRUGTMOMS_FORKLARING =
  "Varen sælges efter brugtmomsordningen. Momsen står ikke på fakturaen og kan ikke trækkes fra.";
export const MOMS_SATS = 25;

// Brugtmoms gælder kun brugte varer købt uden moms. Advarsel (blokerer ikke),
// når varen er ny.
export function erNyVare(stand: string | null | undefined): boolean {
  const s = (stand ?? "").trim().toLowerCase();
  return s === "ny_med_maerke" || s === "ny" || s === "ny med mærke" || s === "ny med maerke";
}

// Den aktuelle faktura på en handel: den ikke-krediterede, ellers den nyeste.
export function aktuelFaktura(fakturaer: FirmaFakturaRaekke[], tradeId: string): FirmaFakturaRaekke | undefined {
  const paaHandel = fakturaer.filter((f) => f.trade_id === tradeId && f.type === "faktura");
  return (
    paaHandel.find((f) => !f.krediteret_kl) ??
    [...paaHandel].sort((a, b) => (a.oprettet_kl < b.oprettet_kl ? 1 : -1))[0]
  );
}

// ---------------------------------------------------------------------------
// Beregning (samme som databasen: netto = round(inkl * 4/5), halv væk fra 0)
// ---------------------------------------------------------------------------
function rundHalvVaekFraNul(x: number): number {
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return r === 0 ? 0 : r; // aldrig -0
}

export function nettoAfInkl(inklOere: number): number {
  // Heltal * 4 / 5: præcist i double for alle realistiske beløb.
  return rundHalvVaekFraNul((inklOere * 4) / 5);
}

export type Beregning = {
  beloeb_ekskl_moms_oere: number | null;
  moms_oere: number | null;
  total_oere: number;
  moms_sats: number | null;
  brugtmoms_tekst: string | null;
};

// Linjebeløb er inkl. moms (buddet). Almindelig moms: netto og moms pr.
// linje, summeret. Brugtmoms: ingen moms vises.
export function beregnFaktura(linjerInkl: number[], momsordning: Momsordning): Beregning {
  const total = linjerInkl.reduce((s, b) => s + b, 0);
  if (momsordning === "brugtmoms") {
    return { beloeb_ekskl_moms_oere: null, moms_oere: null, total_oere: total, moms_sats: null, brugtmoms_tekst: BRUGTMOMS_FAKTURA_TEKST };
  }
  const netto = linjerInkl.reduce((s, b) => s + nettoAfInkl(b), 0);
  return { beloeb_ekskl_moms_oere: netto, moms_oere: total - netto, total_oere: total, moms_sats: MOMS_SATS, brugtmoms_tekst: null };
}

export type LinjeBeregning = {
  enhedspris_ekskl_moms_oere: number | null;
  netto_oere: number | null;
  moms_sats: number | null;
  moms_oere: number | null;
  beloeb_oere: number;
};

// Én linje (beløb inkl. moms, antal). Almindelig moms: beløb ekskl. moms =
// round(inkl * 4/5), moms = resten, enhedspris ekskl. moms = netto / antal.
// Brugtmoms: kun beløbet.
export function beregnLinje(beloebInklOere: number, antal: number, momsordning: Momsordning): LinjeBeregning {
  if (momsordning === "brugtmoms") {
    return { enhedspris_ekskl_moms_oere: null, netto_oere: null, moms_sats: null, moms_oere: null, beloeb_oere: beloebInklOere };
  }
  const netto = nettoAfInkl(beloebInklOere);
  const n = Math.max(1, Math.trunc(antal) || 1);
  return {
    enhedspris_ekskl_moms_oere: rundHalvVaekFraNul(netto / n),
    netto_oere: netto,
    moms_sats: MOMS_SATS,
    moms_oere: beloebInklOere - netto,
    beloeb_oere: beloebInklOere,
  };
}

// Enhedspris ekskl. moms til visning - også for ældre øjebliksbilleder.
export function enhedsprisEksklMoms(l: FirmaFakturaLinje): number | null {
  if (l.enhedspris_ekskl_moms_oere !== undefined && l.enhedspris_ekskl_moms_oere !== null) return Number(l.enhedspris_ekskl_moms_oere);
  if (l.netto_oere === null || l.netto_oere === undefined) return null;
  return rundHalvVaekFraNul(Number(l.netto_oere) / Math.max(1, Number(l.antal) || 1));
}

// Kontrol: stemmer databasens tal med samme regel? (Bruges før PDF/mail.)
// Både pr. linje og i alt.
export function fakturaTalStemmer(d: FirmaFakturaData): boolean {
  const b = beregnFaktura(
    d.linjer.map((l) => Number(l.beloeb_oere)),
    d.momsordning,
  );
  const linjerOk = d.linjer.every((l) => {
    const f = beregnLinje(Number(l.beloeb_oere), Number(l.antal), d.momsordning);
    const tal = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v));
    return (
      tal(l.netto_oere) === f.netto_oere &&
      tal(l.moms_oere) === f.moms_oere &&
      (l.enhedspris_ekskl_moms_oere === undefined || tal(l.enhedspris_ekskl_moms_oere) === f.enhedspris_ekskl_moms_oere)
    );
  });
  return (
    linjerOk &&
    b.total_oere === Number(d.total_oere) &&
    (b.moms_oere ?? null) === (d.moms_oere === null ? null : Number(d.moms_oere)) &&
    (b.beloeb_ekskl_moms_oere ?? null) === (d.beloeb_ekskl_moms_oere === null ? null : Number(d.beloeb_ekskl_moms_oere))
  );
}

// Næste nummer som tekst - som public.firma_faktura_nummer_tekst.
export function fakturanummerTekst(praefiks: string, nummer: number, cifre: number): string {
  const n = String(nummer);
  return `${praefiks}${n.length >= cifre ? n : n.padStart(cifre, "0")}`;
}

// ---------------------------------------------------------------------------
// Formatering
// ---------------------------------------------------------------------------
export function kroner(oere: number): string {
  return `${(oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr.`;
}

export function datoTekst(iso: string | null | undefined): string {
  if (!iso) return "";
  // Rene datoer (YYYY-MM-DD) er allerede dansk dato.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("da-DK", { timeZone: "Europe/Copenhagen", day: "numeric", month: "long", year: "numeric" });
}

export function adresseLinjer(p: FirmaFakturaPart): string[] {
  const by = [p.postnummer, p.by].filter(Boolean).join(" ");
  return [p.adresse, by].filter((x): x is string => !!x && x.trim() !== "");
}

export function dokumentNavn(d: Pick<FirmaFakturaData, "type">): string {
  return d.type === "kreditnota" ? "Kreditnota" : "Faktura";
}

export function pdfFilnavn(d: Pick<FirmaFakturaData, "type" | "fakturanummer" | "id">): string {
  const nr = (d.fakturanummer ?? `kladde-${d.id.slice(0, 8)}`).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${d.type === "kreditnota" ? "Kreditnota" : "Faktura"}-${nr}.pdf`;
}

// ---------------------------------------------------------------------------
// Tekster
// ---------------------------------------------------------------------------
export const MANGLER_TEKST: Record<ManglerKode, string> = {
  ikke_betalt: "Køberen har ikke betalt endnu.",
  refunderet: "Købet er betalt tilbage til køberen eller annulleret. Der skal ikke sendes en faktura.",
  beloeb: "Beløbet mangler.",
  koeber_navn: "Købers navn mangler.",
  koeber_adresse: "Købers adresse (vej og nr.) mangler.",
  koeber_postnummer: "Købers postnummer mangler (4 cifre).",
  koeber_by: "Købers by mangler.",
  koeber_email: "Købers e-mail mangler.",
};

export const FIRMA_FAKTURA_TEKST = {
  titel: "Fakturaer",
  intro:
    "Når køberen har betalt, laver vi en fakturakladde i dit firmas navn. Du ser den igennem og trykker selv \"Send\". Vi sender aldrig en faktura uden dit tryk.",
  seFaktura: "Se din faktura",
  seKreditnota: "Se kreditnota",
  send: "Send",
  sender: "Sender …",
  sendBekraeft: (kredit: boolean) => `Send ${kredit ? "kreditnotaen" : "fakturaen"}?`,
  modtager: "Modtager",
  modtagerMangler: "Ingen e-mail",
  naesteLedige: (nr: string) => `Næste ledige nummer (fx ${nr})`,
  emailAfviger:
    "Du har ændret modtagerens e-mail, så den ikke er købers e-mail på BidHamr. Tjek, at den er rigtig.",
  sendBekraeftForklaring:
    "Det endelige nummer gives, når du trykker Send, og vises bagefter. Når den er sendt, kan den ikke ændres – kun rettes med en kreditnota.",
  sendtSom: (nr: string, email: string) => `Sendt som nr. ${nr} til ${email}.`,
  lavNyFaktura: "Lav ny faktura",
  seNyFaktura: "Se den nye faktura",
  krediteret: "Krediteret",
  kunLaes: "Firmakontoen er lukket. Du kan stadig se og hente dine fakturaer, men ikke sende eller rette dem.",
  momsTitel: "Moms på fakturaen",
  momsAlmindelig: "Almindelig moms (25 %)",
  momsBrugt: "Brugtmoms (fortjenstmargenordning)",
  momsFraStandard: "Følger dit standardvalg, indtil du vælger her.",
  momsKunKladde: "Kan ændres, indtil fakturaen er sendt.",
  brugtmomsNyAdvarsel:
    "Varen er angivet som ny. Brugtmoms gælder kun brugte varer, som du har købt uden moms. Spørg din revisor, hvis du er i tvivl.",
  sendJa: "Ja, send",
  fortryd: "Fortryd",
  sendt: (dato: string) => `Sendt ${dato}`,
  downloadPdf: "Download PDF",
  lavKreditnota: "Lav kreditnota",
  kreditnotaKladde: "Kreditnota (kladde)",
  kladde: "Kladde",
  ikkeBetalt: "Fakturakladden laves, når køberen har betalt.",
  mailFejl: "Fakturaen er udstedt, men mailen kunne ikke sendes. Prøv igen, eller download PDF'en og send den selv.",
  sendMailIgen: "Send mailen igen",
  mailSendtIgen: "Mailen er sendt igen.",
  spaerret: "Fakturaen kan ikke sendes endnu:",
  udfyldForklaring:
    "Tilføj de manglende oplysninger herunder. Tomme felter bruger oplysningerne fra købet.",
  liste: "Alle fakturaer",
  listeTom: "Du har ingen fakturaer endnu.",
  eksportTitel: "Hent fakturaer til dit regnskab",
  eksportForklaring: "Hent alle sendte fakturaer og kreditnotaer i en periode som CSV-fil eller som PDF-filer samlet i en ZIP-fil.",
  eksportCsv: "Hent CSV-fil",
  eksportZip: "Hent PDF'er (ZIP)",
  indstillinger: "Indstillinger for fakturaer",
  gemt: "Gemt.",
  fejl: "Det lykkedes ikke. Prøv igen om lidt.",
  nummer: "Fakturanummer",
  naesteNummer: (nr: string) => `Næste ledige nummer er ${nr}`,
} as const;

// ---------------------------------------------------------------------------
// CSV til regnskab (dansk Excel: semikolon, decimalkomma, UTF-8 med BOM)
// ---------------------------------------------------------------------------
function celle(v: string): string {
  let t = v.replace(/[\r\n]+/g, " ").trim();
  if (/^[=+\-@\t]/.test(t)) t = `'${t}`;
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function talKomma(oere: number | null): string {
  if (oere === null || oere === undefined) return "";
  return (Number(oere) / 100).toFixed(2).replace(".", ",");
}

export function firmaFakturaCsv(raekker: FirmaFakturaData[]): string {
  const hoved = [
    "Nummer",
    "Type",
    "Udstedt",
    "Krediterer",
    "Køber",
    "Købers firma",
    "Købers CVR",
    "Adresse",
    "Postnummer",
    "By",
    "E-mail",
    "Vare",
    "Leveringsdato",
    "Momsordning",
    "Beløb ekskl. moms (kr.)",
    "Moms (kr.)",
    "Total (kr.)",
    "Handels-id",
  ];
  const linjer = raekker.map((d) =>
    [
      d.fakturanummer ?? "",
      d.type === "kreditnota" ? "Kreditnota" : "Faktura",
      d.udstedt_dato ?? "",
      d.krediterer?.fakturanummer ?? "",
      d.koeber.navn ?? "",
      d.koeber.firmanavn ?? "",
      d.koeber.cvr ?? "",
      d.koeber.adresse ?? "",
      d.koeber.postnummer ?? "",
      d.koeber.by ?? "",
      d.koeber.email ?? "",
      d.linjer.map((l) => l.tekst).join(", "),
      d.leveringsdato ?? "",
      d.momsordning === "brugtmoms" ? "Brugtmoms" : "Moms 25 %",
      talKomma(d.beloeb_ekskl_moms_oere),
      talKomma(d.moms_oere),
      talKomma(d.total_oere),
      d.trade_id,
    ]
      .map((v) => celle(String(v)))
      .join(";"),
  );
  return `﻿${[hoved.map(celle).join(";"), ...linjer].join("\r\n")}\r\n`;
}

// Værdier fra formularer: tomt = null.
export function renTekst(v: unknown, maks: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.slice(0, maks);
}

export const PRAEFIKS = /^[A-Za-z0-9ÆØÅæøå/_.-]{0,12}$/;
export const EMAIL_FAKTURA = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;

// Props til FirmaFakturaKnapper ud fra en række i fakturalisten (samme på
// Fakturaer, Salg og den enkelte handel).
export function fakturaKnapperProps(f: FirmaFakturaRaekke, naesteNummer: string, kunLaes: boolean) {
  return {
    id: f.id,
    type: f.type,
    status: f.status,
    fakturanummer: f.fakturanummer,
    naesteNummer,
    koeberEmail: f.data?.koeber.email ?? null,
    mangler: (f.data?.mangler ?? []).map((k) => MANGLER_TEKST[k] ?? k),
    sendtKl: f.sendt_kl,
    mailFejl: f.mail_fejl,
    mailSendtKl: f.mail_sendt_kl,
    kreditnotaId: f.kreditnota_id,
    tradeId: f.trade_id,
    krediteretKl: f.krediteret_kl,
    nyFakturaId: f.ny_faktura_id,
    kanLaveNy: f.kan_lave_ny,
    emailAfviger: f.email_afviger,
    kunLaes,
  };
}
