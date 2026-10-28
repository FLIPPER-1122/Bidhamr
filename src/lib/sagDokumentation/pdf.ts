import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFImage } from "pdf-lib";
import { BREDDE, BUND, F, MARGEN, SIDE_B, SIDE_H, Skriver, UDEN_FEATURES, hentSkrifter } from "@/lib/pdf/mineDataPdf";
import { FIRMA } from "@/lib/firmaoplysninger";
import { tid, type DokBillede, type DokBlok, type Dokument } from "@/lib/sagDokumentation/indhold";

// Tegner "Dokumentation til sælger/politiet" (modellen fra indhold.ts) som
// PDF med pdf-lib - samme skrifttype og layout som "Download dine data"
// (src/lib/pdf/mineDataPdf.ts). Billederne indlejres, så PDF'en kan læses
// uden login. PDF'en gemmes ikke - route'en streamer den direkte.
// Skrift og logo kommer med på Vercel via outputFileTracingIncludes i
// next.config.ts ("/admin/sager/**").

const LOGO = path.join(process.cwd(), "public", "brand", "bidhamr-logo-mail.png");
let logo: Promise<Uint8Array> | null = null;
function hentLogo() {
  logo ??= readFile(LOGO).then(
    (b) => new Uint8Array(b),
    (e: unknown) => {
      logo = null;
      throw e;
    },
  );
  return logo;
}

const KOLONNER = 2;
const MELLEMRUM = 12;
const MAKS_BILLED_H = 260;

async function indlejr(doc: PDFDocument, b: DokBillede): Promise<PDFImage | null> {
  if (!b.bytes || !b.format) return null;
  try {
    return b.format === "png" ? await doc.embedPng(b.bytes) : await doc.embedJpg(b.bytes);
  } catch (e) {
    console.error("[sag-dokumentation] billede kunne ikke indlejres:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function tegnBilleder(s: Skriver, billeder: DokBillede[]) {
  const kolB = (BREDDE - MELLEMRUM * (KOLONNER - 1)) / KOLONNER;
  for (let i = 0; i < billeder.length; i += KOLONNER) {
    const raekke = billeder.slice(i, i + KOLONNER);
    const indlejrede = await Promise.all(raekke.map((b) => indlejr(s.doc, b)));
    const maal = indlejrede.map((img) => {
      if (!img) return { w: kolB, h: 40 };
      const skala = Math.min(kolB / img.width, MAKS_BILLED_H / img.height, 1);
      return { w: img.width * skala, h: img.height * skala };
    });
    const tekstH = 24;
    const h = Math.max(...maal.map((m) => m.h)) + tekstH;
    s.plads(h + 6);
    const top = s.y;
    raekke.forEach((b, j) => {
      const x = MARGEN + j * (kolB + MELLEMRUM);
      const img = indlejrede[j];
      const m = maal[j];
      if (img) {
        s.side.drawImage(img, { x, y: top - m.h, width: m.w, height: m.h });
      } else {
        s.side.drawRectangle({ x, y: top - m.h, width: kolB, height: m.h, color: F.stribe, borderColor: F.kant, borderWidth: 0.5 });
        s.side.drawText(s.ombryd("Billedet kan ikke vises", s.r, 8.5, kolB - 10)[0] ?? "", {
          x: x + 5,
          y: top - m.h / 2 - 3,
          size: 8.5,
          font: s.r,
          color: F.daempet,
        });
      }
      const linjer = s.ombryd(`${b.tekst}${b.tid ? ` · ${tid(b.tid)}` : ""}`, s.r, 8, kolB);
      linjer.slice(0, 2).forEach((l, k) => {
        s.side.drawText(l, { x, y: top - m.h - 10 - k * 10, size: 8, font: s.r, color: F.daempet });
      });
    });
    s.y = top - h - 6;
  }
}

async function tegnBlok(s: Skriver, b: DokBlok) {
  switch (b.slags) {
    case "felter":
      s.felter(b.raekker);
      return;
    case "tekst":
      s.afsnit(b.tekst, { str: b.daempet ? 9 : 10, farve: b.daempet ? F.daempet : F.tekst, efter: 6 });
      return;
    case "underoverskrift":
      s.underoverskrift(b.tekst, 10.5);
      return;
    case "tabel":
      s.tabel(b.hoved, b.vaegte, b.raekker.map((r) => r.map((tekst) => ({ tekst }))));
      return;
    case "billeder":
      await tegnBilleder(s, b.billeder);
      return;
  }
}

export async function lavDokumentationPdf(dok: Dokument): Promise<Uint8Array> {
  const [[rBytes, bBytes], logoBytes] = await Promise.all([hentSkrifter(), hentLogo()]);
  const dannet = new Date(dok.dannetKl);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const r = await doc.embedFont(rBytes, { subset: true, features: UDEN_FEATURES });
  const b = await doc.embedFont(bBytes, { subset: true, features: UDEN_FEATURES });
  const s = new Skriver(doc, r, b, new Set(r.getCharacterSet()));
  const logoImg = await doc.embedPng(logoBytes);

  doc.setTitle(dok.titel);
  doc.setAuthor(FIRMA.navn);
  doc.setCreator("BidHamr");
  doc.setProducer("BidHamr");
  doc.setLanguage("da-DK");
  doc.setCreationDate(dannet);
  doc.setModificationDate(dannet);

  // --- Forside ---
  s.nySide();
  const logoH = 34;
  const logoW = (logoImg.width / logoImg.height) * logoH;
  s.side.drawImage(logoImg, { x: MARGEN, y: SIDE_H - 56 - logoH, width: logoW, height: logoH });
  s.y = SIDE_H - 56 - logoH - 24;
  s.afsnit(dok.titel, { str: 24, fed: true, efter: 12 });
  if (dok.udgave === "politi") {
    s.afsnit("FORTROLIGT – indeholder personoplysninger. Kun til politiet.", { str: 10, fed: true, farve: F.groen, efter: 10 });
  }
  s.side.drawLine({ start: { x: MARGEN, y: s.y }, end: { x: SIDE_B - MARGEN, y: s.y }, thickness: 1.5, color: F.groen });
  s.y -= 14;
  s.felter(dok.forside);
  for (const t of dok.indledning) s.afsnit(t, { str: 9.5, efter: 6 });

  // --- Afsnittene ---
  for (const a of dok.afsnit) {
    s.overskrift(a.titel);
    for (const [i, blok] of a.blokke.entries()) {
      // En overskrift over billeder står aldrig alene nederst på en side.
      if (blok.slags === "underoverskrift" && a.blokke[i + 1]?.slags === "billeder") s.plads(MAKS_BILLED_H + 70);
      await tegnBlok(s, blok);
    }
  }

  // --- Afslutning ---
  s.overskrift(dok.udgave === "politi" ? "Yderligere oplysninger og kontakt" : "Kontakt");
  for (const t of dok.afslutning) s.afsnit(t, { str: 10, efter: 6 });

  // --- Sidehoved og -fod ---
  const sider = doc.getPages();
  const hoved = s.ren(`${dok.titel} · lavet ${tid(dok.dannetKl)}`);
  const fod = s.ren(`${FIRMA.navn} · CVR ${FIRMA.cvr} · ${FIRMA.email}`);
  sider.forEach((side, i) => {
    if (i > 0) {
      side.drawText(s.ombryd(hoved, r, 8, BREDDE)[0] ?? "", { x: MARGEN, y: SIDE_H - 34, size: 8, font: r, color: F.daempet });
      side.drawLine({ start: { x: MARGEN, y: SIDE_H - 40 }, end: { x: SIDE_B - MARGEN, y: SIDE_H - 40 }, thickness: 0.5, color: F.kant });
    }
    side.drawLine({ start: { x: MARGEN, y: BUND - 14 }, end: { x: SIDE_B - MARGEN, y: BUND - 14 }, thickness: 0.5, color: F.kant });
    side.drawText(fod, { x: MARGEN, y: BUND - 26, size: 8, font: r, color: F.daempet });
    const nr = `Side ${i + 1} af ${sider.length}`;
    side.drawText(nr, { x: SIDE_B - MARGEN - r.widthOfTextAtSize(nr, 8), y: BUND - 26, size: 8, font: r, color: F.daempet });
  });

  return doc.save();
}
