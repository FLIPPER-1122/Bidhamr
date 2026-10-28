import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import {
  adresseLinjer,
  datoTekst,
  dokumentNavn,
  kroner,
  type FirmaFakturaData,
} from "@/lib/erhverv/firmaFaktura";

// PDF af en faktura/kreditnota fra firma til køber. Laves KUN ud fra
// øjebliksbilledet (data) - en sendt faktura ser altid ens ud. Kladder får
// vandmærket "KLADDE" og intet nummer.
//
// Indholdet følger momsbekendtgørelsens § 58, stk. 1 (fuld faktura) - se
// docs/FIRMA-FAKTURA.md: udstedelsesdato, fortløbende nummer, sælgers CVR,
// navn og adresse, købers navn og adresse, mængde og art af varen,
// leveringsdato, beløb ekskl. moms, momssats og momsbeløb - eller ved
// brugtmoms teksten "Brugtmoms – særordning for brugte varer" (§ 58, stk. 1,
// nr. 14) og ingen moms.

const SKRIFT_MAPPE = path.join(process.cwd(), "src", "lib", "pdf", "skrifter");
let skrifter: Promise<[Uint8Array, Uint8Array]> | null = null;

function hentSkrifter() {
  skrifter ??= Promise.all([
    readFile(path.join(SKRIFT_MAPPE, "Inter-Regular.ttf")),
    readFile(path.join(SKRIFT_MAPPE, "Inter-SemiBold.ttf")),
  ]).then(
    ([r, b]) => [new Uint8Array(r), new Uint8Array(b)] as [Uint8Array, Uint8Array],
    (e: unknown) => {
      skrifter = null;
      throw e;
    },
  );
  return skrifter;
}

const B = 595.28;
const H = 841.89;
const M = 50;
const TEKST = rgb(0.1, 0.1, 0.1);
const DAEMPET = rgb(0.33, 0.33, 0.33);
const KANT = rgb(0.85, 0.85, 0.85);
const FLADE = rgb(0.96, 0.97, 0.96);

const UDEN_FEATURES: Record<string, boolean> = Object.fromEntries(
  ["liga", "kern", "calt", "clig", "rlig"].map((k) => [k, false]),
);

// Logo: kun billeder fra BidHamrs egen offentlige avatar-bucket (ingen
// vilkårlige URL'er), PNG/JPEG, højst 2 MB, 5 sekunder.
export async function hentLogo(url: string | null | undefined): Promise<{ bytes: Uint8Array; type: "png" | "jpg" } | null> {
  if (!url) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base || !url.startsWith(`${base}/storage/v1/object/public/avatarer/`)) return null;
  try {
    const svar = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!svar.ok) return null;
    const buf = new Uint8Array(await svar.arrayBuffer());
    if (buf.byteLength > 2 * 1024 * 1024) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { bytes: buf, type: "png" };
    if (buf[0] === 0xff && buf[1] === 0xd8) return { bytes: buf, type: "jpg" };
    return null;
  } catch {
    return null;
  }
}

function ombryd(tekst: string, font: PDFFont, str: number, bredde: number): string[] {
  const ud: string[] = [];
  for (const afsnit of tekst.split(/\r?\n/)) {
    let linje = "";
    for (const ord of afsnit.split(/\s+/).filter(Boolean)) {
      const proeve = linje ? `${linje} ${ord}` : ord;
      if (font.widthOfTextAtSize(proeve, str) <= bredde) {
        linje = proeve;
      } else {
        if (linje) ud.push(linje);
        // Meget lange ord deles.
        let rest = ord;
        while (font.widthOfTextAtSize(rest, str) > bredde && rest.length > 1) {
          let n = rest.length;
          while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), str) > bredde) n--;
          ud.push(rest.slice(0, n));
          rest = rest.slice(n);
        }
        linje = rest;
      }
    }
    ud.push(linje);
  }
  return ud;
}

// Tegn, som skrifttypen ikke har, fjernes (pdf-lib kaster ellers).
function renset(font: PDFFont, t: string): string {
  const tegn = new Set(font.getCharacterSet());
  return Array.from(t.normalize("NFC"))
    .map((c) => (tegn.has(c.codePointAt(0)!) ? c : c === "\t" ? " " : "?"))
    .join("");
}

export async function lavFirmaFakturaPdf(
  d: FirmaFakturaData,
  logo?: { bytes: Uint8Array; type: "png" | "jpg" } | null,
): Promise<Uint8Array> {
  const [regular, fed] = await hentSkrifter();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const R = await doc.embedFont(regular, { subset: true, features: UDEN_FEATURES });
  const F = await doc.embedFont(fed, { subset: true, features: UDEN_FEATURES });
  const kladde = d.status !== "sendt";
  const titel = dokumentNavn(d);
  doc.setTitle(`${titel} ${d.fakturanummer ?? "(kladde)"} - ${d.saelger.firmanavn}`);
  doc.setAuthor(d.saelger.firmanavn);
  doc.setCreator("BidHamr");
  doc.setProducer("BidHamr");

  let side: PDFPage = doc.addPage([B, H]);
  let y = H - M;

  const skriv = (t: string, x: number, yy: number, o: { font?: PDFFont; str?: number; farve?: ReturnType<typeof rgb> } = {}) => {
    const font = o.font ?? R;
    side.drawText(renset(font, t), { x, y: yy, size: o.str ?? 10, font, color: o.farve ?? TEKST });
  };
  const hoejre = (t: string, xHoejre: number, yy: number, o: { font?: PDFFont; str?: number; farve?: ReturnType<typeof rgb> } = {}) => {
    const font = o.font ?? R;
    const s = renset(font, t);
    skriv(s, xHoejre - font.widthOfTextAtSize(s, o.str ?? 10), yy, o);
  };
  const nySideHvis = (behov: number) => {
    if (y - behov < M + 40) {
      side = doc.addPage([B, H]);
      y = H - M;
      if (kladde) vandmaerke(side);
    }
  };
  const vandmaerke = (s: PDFPage) => {
    s.drawText("KLADDE", { x: 130, y: 300, size: 110, font: F, color: rgb(0.88, 0.88, 0.88), rotate: degrees(35), opacity: 0.6 });
  };
  if (kladde) vandmaerke(side);

  // --- Top: logo/firmanavn til venstre, dokumenttype og nummer til højre ---
  let logoBillede: PDFImage | null = null;
  if (logo) {
    try {
      logoBillede = logo.type === "png" ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
    } catch {
      logoBillede = null;
    }
  }
  let venstreY = y;
  if (logoBillede) {
    const maksH = 48;
    const maksB = 160;
    const skala = Math.min(maksH / logoBillede.height, maksB / logoBillede.width, 1);
    const lh = logoBillede.height * skala;
    side.drawImage(logoBillede, { x: M, y: y - lh, width: logoBillede.width * skala, height: lh });
    venstreY = y - lh - 14;
  }
  for (const l of ombryd(d.saelger.firmanavn, F, 15, 260)) {
    skriv(l, M, venstreY - 12, { font: F, str: 15 });
    venstreY -= 19;
  }
  const saelgerLinjer = [
    ...adresseLinjer(d.saelger),
    `CVR-nr. ${d.saelger.cvr}`,
    d.saelger.email ?? "",
    d.saelger.telefon ? `Tlf. ${d.saelger.telefon}` : "",
  ].filter(Boolean);
  venstreY -= 2;
  for (const l of saelgerLinjer) {
    skriv(l, M, venstreY - 10, { str: 9.5, farve: DAEMPET });
    venstreY -= 13;
  }

  const xH = B - M;
  let hY = y - 20;
  hoejre(titel.toUpperCase(), xH, hY, { font: F, str: 22 });
  hY -= 26;
  const felt = (label: string, vaerdi: string) => {
    hoejre(`${label}: ${vaerdi}`, xH, hY, { str: 10 });
    hY -= 14;
  };
  felt(`${titel}nr.`, d.fakturanummer ?? "Gives ved afsendelse");
  felt("Fakturadato", d.udstedt_dato ? datoTekst(d.udstedt_dato) : "Dato for afsendelse");
  if (d.leveringsdato) felt("Leveringsdato", datoTekst(d.leveringsdato));
  if (d.type === "kreditnota" && d.krediterer) {
    felt("Krediterer faktura", `${d.krediterer.fakturanummer ?? ""}${d.krediterer.udstedt_dato ? ` af ${datoTekst(d.krediterer.udstedt_dato)}` : ""}`);
  }

  y = Math.min(venstreY, hY) - 22;

  // --- Køber ---
  skriv("Køber", M, y, { font: F, str: 10.5 });
  y -= 15;
  const koeberLinjer = [
    d.koeber.firmanavn ?? "",
    d.koeber.navn ?? "",
    d.koeber.cvr ? `CVR-nr. ${d.koeber.cvr}` : "",
    ...adresseLinjer(d.koeber),
    d.koeber.email ?? "",
  ].filter(Boolean);
  for (const l of koeberLinjer) {
    for (const ll of ombryd(l, R, 10, 300)) {
      skriv(ll, M, y, { str: 10 });
      y -= 13.5;
    }
  }
  y -= 18;

  // --- Linjer ---
  const kol = { tekst: M + 8, antal: M + 300, pris: M + 400, beloeb: xH - 8 };
  side.drawRectangle({ x: M, y: y - 6, width: B - 2 * M, height: 22, color: FLADE });
  skriv("Beskrivelse", kol.tekst, y, { font: F, str: 9.5 });
  hoejre("Antal", kol.antal + 30, y, { font: F, str: 9.5 });
  hoejre("Pris", kol.pris + 50, y, { font: F, str: 9.5 });
  hoejre("Beløb", kol.beloeb, y, { font: F, str: 9.5 });
  y -= 24;
  const inklTekst = d.momsordning === "moms" ? " inkl. moms" : "";
  for (const l of d.linjer) {
    const tekstLinjer = ombryd(l.tekst, R, 10, 280);
    nySideHvis(tekstLinjer.length * 13 + 10);
    hoejre(String(l.antal), kol.antal + 30, y, { str: 10 });
    hoejre(kroner(l.enhedspris_oere), kol.pris + 50, y, { str: 10 });
    hoejre(kroner(l.beloeb_oere), kol.beloeb, y, { str: 10 });
    for (const t of tekstLinjer) {
      skriv(t, kol.tekst, y, { str: 10 });
      y -= 13;
    }
    y -= 6;
    side.drawLine({ start: { x: M, y: y + 4 }, end: { x: xH, y: y + 4 }, thickness: 0.5, color: KANT });
    y -= 6;
  }
  if (inklTekst) {
    skriv("Priserne er inkl. moms.", kol.tekst, y, { str: 8.5, farve: DAEMPET });
    y -= 14;
  }

  // --- Totaler ---
  nySideHvis(90);
  y -= 6;
  const total = (label: string, v: string, fedt = false) => {
    hoejre(label, kol.pris + 50, y, { font: fedt ? F : R, str: fedt ? 11.5 : 10 });
    hoejre(v, kol.beloeb, y, { font: fedt ? F : R, str: fedt ? 11.5 : 10 });
    y -= fedt ? 18 : 15;
  };
  if (d.momsordning === "moms") {
    total("Beløb ekskl. moms", kroner(Number(d.beloeb_ekskl_moms_oere ?? 0)));
    total(`Moms ${d.moms_sats ?? 25} %`, kroner(Number(d.moms_oere ?? 0)));
    total(d.type === "kreditnota" ? "Krediteret i alt" : "I alt", kroner(Number(d.total_oere)), true);
  } else {
    total(d.type === "kreditnota" ? "Krediteret i alt" : "I alt", kroner(Number(d.total_oere)), true);
    y -= 4;
    skriv(d.brugtmoms_tekst ?? "Brugtmoms – særordning for brugte varer", M, y, { font: F, str: 10 });
    y -= 15;
  }

  y -= 14;
  nySideHvis(40);
  skriv(
    d.type === "kreditnota"
      ? `Kreditnotaen krediterer faktura nr. ${d.krediterer?.fakturanummer ?? ""} fuldt ud.`
      : d.betalingstekst,
    M,
    y,
    { str: 10 },
  );
  y -= 14;

  // --- Bund på alle sider ---
  const fod = `${dokumentNavn(d)} udstedt af ${d.saelger.firmanavn}, CVR-nr. ${d.saelger.cvr}. Lavet med BidHamr (bidhamr.dk) - BidHamr er ikke part i handlen.`;
  const sider = doc.getPages();
  sider.forEach((s, i) => {
    const linjer = ombryd(fod, R, 7.5, B - 2 * M - 60);
    let fy = M - 10 + (linjer.length - 1) * 10;
    for (const l of linjer) {
      s.drawText(renset(R, l), { x: M, y: fy, size: 7.5, font: R, color: DAEMPET });
      fy -= 10;
    }
    const sTekst = `Side ${i + 1} af ${sider.length}`;
    s.drawText(sTekst, { x: B - M - R.widthOfTextAtSize(sTekst, 7.5), y: M - 10, size: 7.5, font: R, color: DAEMPET });
  });

  return doc.save();
}
