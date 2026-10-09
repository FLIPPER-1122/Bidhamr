// Oplysninger til firmaets egen faktura på varen (Filip, 9. okt. 2026 -
// "Faktura på varen ved firmasalg"). Firmaet sender selv fakturaen fra sit
// eget regnskabsprogram; BidHamr giver kun oplysningerne. Data kommer fra
// firma_faktura_salg (20261014020000) - kun firmaet selv (og chef/sælger).
//
// Ingen server-only: typerne, momsberegningen og kopiteksten bruges også i
// klienten (Kopiér-knappen).

export type FakturaFirma = { firmanavn: string; cvr: string; brugtmoms: boolean };

export type FakturaSalg = {
  trade_id: string;
  solgt_kl: string;
  betalt_kl: string;
  refunderet_kl: string | null;
  titel: string | null;
  stand: string | null;
  pris_oere: number;
  afhentning: boolean;
  levering: "doer" | "pakkeshop" | null;
  koeber_navn: string | null;
  koeber_navn_mitid: boolean;
  koeber_email: string | null;
  adresse: string | null;
  postnummer: string | null;
  by: string | null;
};

export type FakturaData = { firma: FakturaFirma; salg: FakturaSalg[] };

export const FAKTURA_TEKST = {
  titel: "Oplysninger til din faktura",
  forklaring:
    "Du sender selv fakturaen på varen til køberen fra dit eget regnskabsprogram. Her er de oplysninger, du skal bruge.",
  ikkeBetalt: "Oplysningerne til fakturaen vises her, når køberen har betalt.",
  koeber: "Køber",
  navnMitid: "Navnet er bekræftet med MitID.",
  adresse: "Adresse",
  ingenAdresse: "Køberen har ikke oplyst adresse",
  email: "E-mail",
  vare: "Vare",
  pris: "Pris inkl. moms",
  moms: "Heraf moms (25 %)",
  brugtmoms: "Brugtmoms: momsen skal ikke stå på fakturaen.",
  dato: "Dato for salget",
  handelsId: "Handels-id",
  refunderet: "Købet er betalt tilbage til køberen. Har du sendt en faktura, skal du lave en kreditnota.",
  kopier: "Kopiér oplysningerne",
  kopieret: "Kopieret",
  kopierFejl: "Kunne ikke kopiere. Markér teksten, og kopiér den selv.",
  eksportTitel: "Hent alle salg som fil",
  eksportForklaring:
    "Vælg en periode, og hent alle betalte salg som en CSV-fil, som du kan åbne i Excel eller indlæse i dit regnskabsprogram.",
  fra: "Fra og med",
  til: "Til og med",
  eksportKnap: "Hent CSV-fil",
} as const;

// Firmaoplysninger: "Vi bruger brugtmomsordningen".
export const BRUGTMOMS_TEKST = {
  titel: "Moms på dine salg",
  label: "Vi bruger brugtmomsordningen",
  hjaelp:
    "Sæt kun hak, hvis dit firma sælger brugte varer efter brugtmomsordningen. Så viser vi ikke momsen i oplysningerne til din faktura, fordi momsen ikke må stå på fakturaen. Spørg din revisor, hvis du er i tvivl.",
  gemt: "Gemt.",
  fejl: "Det blev ikke gemt. Prøv igen om lidt.",
} as const;

// 25 % moms er 20 % af prisen inkl. moms.
export function momsAfPris(prisOere: number): number {
  return Math.round(prisOere / 5);
}

function kroner(oere: number): string {
  return (oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fakturaDato(iso: string): string {
  return new Date(iso).toLocaleDateString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function adresseLinjer(s: FakturaSalg): string[] | null {
  if (!s.adresse) return null;
  const by = [s.postnummer, s.by].filter(Boolean).join(" ");
  return by ? [s.adresse, by] : [s.adresse];
}

export function varebeskrivelse(s: FakturaSalg): string {
  const titel = s.titel?.trim() || "Vare";
  return s.stand ? `${titel} (stand: ${s.stand})` : titel;
}

// Ren tekst til "Kopiér".
export function fakturaKopiTekst(s: FakturaSalg, firma: FakturaFirma): string {
  const T = FAKTURA_TEKST;
  const adr = adresseLinjer(s);
  const linjer = [
    `${T.koeber}: ${s.koeber_navn ?? ""}`,
    `${T.adresse}: ${adr ? adr.join(", ") : T.ingenAdresse}`,
    `${T.email}: ${s.koeber_email ?? ""}`,
    `${T.vare}: ${varebeskrivelse(s)}`,
    `${T.pris}: ${kroner(s.pris_oere)} kr.`,
  ];
  if (!firma.brugtmoms) linjer.push(`${T.moms}: ${kroner(momsAfPris(s.pris_oere))} kr.`);
  linjer.push(`${T.dato}: ${fakturaDato(s.solgt_kl)}`, `${T.handelsId}: ${s.trade_id}`);
  return linjer.join("\n");
}

// CSV til Excel (dansk): semikolon, decimalkomma, UTF-8 med BOM. Celler,
// der starter med = + - @ (eller tab/CR), får et ' foran, så et regneark
// ikke tolker brugerindhold (fx en titel) som en formel.
function celle(v: string): string {
  let t = v.replace(/\r?\n/g, " ");
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[;"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function isoDato(iso: string): string {
  // YYYY-MM-DD i dansk tid.
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
}

export function fakturaCsv(data: FakturaData): string {
  const brugtmoms = data.firma.brugtmoms;
  const hoved = [
    "Handels-id",
    "Salgsdato",
    "Betalt",
    "Køber",
    "E-mail",
    "Adresse",
    "Postnummer",
    "By",
    "Vare",
    "Stand",
    "Pris inkl. moms (kr.)",
    ...(brugtmoms ? [] : ["Heraf moms (kr.)"]),
    "Betalt tilbage",
  ];
  const raekker = data.salg.map((s) => [
    s.trade_id,
    isoDato(s.solgt_kl),
    isoDato(s.betalt_kl),
    s.koeber_navn ?? "",
    s.koeber_email ?? "",
    s.adresse ?? "",
    s.postnummer ?? "",
    s.by ?? "",
    s.titel ?? "",
    s.stand ?? "",
    kroner(s.pris_oere),
    ...(brugtmoms ? [] : [kroner(momsAfPris(s.pris_oere))]),
    s.refunderet_kl ? isoDato(s.refunderet_kl) : "",
  ]);
  return "﻿" + [hoved, ...raekker].map((r) => r.map(celle).join(";")).join("\r\n") + "\r\n";
}
