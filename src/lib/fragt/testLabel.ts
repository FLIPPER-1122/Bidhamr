import "server-only";

// En simpel PDF-label til testfragtfirmaet - håndskrevet PDF (ingen tunge
// biblioteker). QR-koden laves med `qrcode-generator` (lille, ingen
// afhængigheder, MIT) og tegnes som sorte firkanter direkte i PDF'en.
//
// Format: 10 x 15 cm (som en almindelig pakkelabel).
import qrcode from "qrcode-generator";
import type { Adresse, Pakkestoerrelse } from "@/lib/fragt/types";
import { PAKKESTOERRELSE_NAVN } from "@/lib/fragt/types";

const BREDDE = 283; // 10 cm i punkter
const HOEJDE = 425; // 15 cm

// PDF-strenge i WinAnsi (latin1 dækker æøå). Andre tegn bliver "?".
function pdfTekst(s: string): string {
  let ud = "";
  for (const tegn of s) {
    const kode = tegn.codePointAt(0) ?? 63;
    const c = kode <= 0xff ? tegn : "?";
    ud += c === "(" || c === ")" || c === "\\" ? `\\${c}` : c;
  }
  return `(${ud})`;
}

function linje(
  x: number,
  y: number,
  tekst: string,
  str: number,
  fed = false,
): string {
  return `BT /${fed ? "F2" : "F1"} ${str} Tf ${x} ${y} Td ${pdfTekst(tekst.slice(0, 60))} Tj ET\n`;
}

function qrFirkanter(data: string, x: number, y: number, stoerrelse: number): string {
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  const n = qr.getModuleCount();
  const celle = stoerrelse / n;
  let ud = "0 0 0 rg\n";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        const px = x + c * celle;
        const py = y + stoerrelse - (r + 1) * celle;
        ud += `${px.toFixed(2)} ${py.toFixed(2)} ${celle.toFixed(2)} ${celle.toFixed(2)} re\n`;
      }
    }
  }
  return ud + "f\n";
}

function adresseLinjer(a: Adresse): string[] {
  const postBy = [a.postnummer, a.by].filter(Boolean).join(" ");
  return [a.navn, a.adresse ?? "", postBy].filter((l) => l.trim().length > 0);
}

export function lavTestLabelPdf(input: {
  sporingsnummer: string;
  qrData: string;
  afsender: Adresse;
  modtager: Adresse;
  pakkestoerrelse: Pakkestoerrelse;
  titel: string;
  retur: boolean;
}): Uint8Array {
  let indhold = "";
  // Ramme
  indhold += "0 0 0 RG 1 w 8 8 267 409 re S\n";
  indhold += linje(18, 392, "BidHamr TESTFRAGT", 14, true);
  indhold += linje(18, 378, "Testlabel - kan ikke bruges til en rigtig pakke", 8);
  indhold += linje(18, 352, input.retur ? "RETURPAKKE" : "PAKKE", 10, true);
  indhold += linje(18, 330, input.sporingsnummer, 18, true);
  indhold += linje(18, 312, `Størrelse: ${PAKKESTOERRELSE_NAVN[input.pakkestoerrelse]}`, 10);

  let y = 286;
  indhold += linje(18, y, "Til:", 9, true);
  for (const l of adresseLinjer(input.modtager)) {
    y -= 14;
    indhold += linje(18, y, l, 11);
  }
  y -= 24;
  indhold += linje(18, y, "Fra:", 9, true);
  for (const l of adresseLinjer(input.afsender)) {
    y -= 12;
    indhold += linje(18, y, l, 9);
  }

  // Mindst 4 moduler hvid kant om QR-koden (rammen ligger ved 8 pt).
  indhold += qrFirkanter(input.qrData, 24, 26, 100);
  indhold += linje(140, 120, "Vis QR-koden i", 9);
  indhold += linje(140, 108, "pakkeshoppen", 9);
  indhold += linje(140, 60, input.titel, 8);

  const objekter = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${BREDDE} ${HOEJDE}] ` +
      "/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(indhold, "latin1")} >>\nstream\n${indhold}endstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objekter.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objekter.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objekter.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
