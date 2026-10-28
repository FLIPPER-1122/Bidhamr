import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import {
  DINE_DATA_AFSNIT,
  DINE_DATA_FELTER,
  DINE_DATA_PDF as T,
  DINE_DATA_UNDERAFSNIT,
} from "@/lib/tekster/dineData";

// "Download dine data" som PDF (GDPR art. 15). Indholdet er PRÆCIS det, som
// mine_data() returnerer til JSON-filen (samme RPC, samme adgangskontrol og
// rate limit - se src/app/(app)/konto/data/route.ts). Her sættes det kun op,
// så et menneske kan læse det: danske overskrifter, tabeller, datoer i dansk
// tid og beløb i kr. Der hentes ingen data andre steder fra.
//
// Følsomme felter: databasen sender aldrig CPR/TIN i klar tekst (dac7.cpr er
// en forklarende tekst, MitID-id står slet ikke i udtrækket). Som ekstra værn
// vises felter med "krypteret"/"hash"/"token" i navnet aldrig, og et CPR-/TIN-
// felt med tal i vises som "Oplyst (vises ikke her)".

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

// ---------------------------------------------------------------------------
// Skrifttype (Inter, SIL Open Font License - se skrifter/Inter-OFL.txt).
// Filerne kommer med på Vercel via outputFileTracingIncludes i next.config.ts.
// ---------------------------------------------------------------------------
const SKRIFT_MAPPE = path.join(process.cwd(), "src", "lib", "pdf", "skrifter");
let skrifter: Promise<[Uint8Array, Uint8Array]> | null = null;

export function hentSkrifter() {
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

// ---------------------------------------------------------------------------
// Layout (A4, punkter). Farver fra DESIGN.md.
// ---------------------------------------------------------------------------
export const SIDE_B = 595.28;
export const SIDE_H = 841.89;
export const MARGEN = 48;
export const TOP = SIDE_H - 60;
export const BUND = 54;
export const BREDDE = SIDE_B - 2 * MARGEN;

function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
export const F = {
  groen: hex("#1e5e4a"),
  groenLys: hex("#e8f2ee"),
  tekst: hex("#1a1a1a"),
  daempet: hex("#555555"),
  kant: hex("#dddddd"),
  stribe: hex("#f6f7f5"),
};

// OpenType-features (kerning, ligaturer, mærkeplacering osv.) slået fra:
// fontkits tekstformning er ellers ~15 gange langsommere (1 ms pr. linje), og
// et stort udtræk (tusindvis af beskeder) skal kunne laves på få sekunder.
// Dansk tekst har ikke brug for dem; bredderne passer så også præcist med
// ombrydningen, der måler ord for ord.
export const UDEN_FEATURES: Record<string, boolean> = Object.fromEntries(
  ["rvrn", "ltra", "ltrm", "frac", "numr", "dnom", "ccmp", "locl", "rlig", "mark", "mkmk", "clig", "rclt", "curs", "liga", "kern", "calt"].map(
    (k) => [k, false],
  ),
);

const TABEL_STR = 8.5;
const TABEL_LH = 11.5;
const CELLE_PAD_Y = 3.5;
const CELLE_PAD_X = 5;

// ---------------------------------------------------------------------------
// Formatering af værdier
// ---------------------------------------------------------------------------
const TZ = "Europe/Copenhagen";
const TID = new Intl.DateTimeFormat("da-DK", {
  timeZone: TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const LANG_DATO = new Intl.DateTimeFormat("da-DK", {
  timeZone: TZ,
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const ISO_TID = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const ISO_DATO = /^(\d{4})-(\d{2})-(\d{2})$/;

function dele(fmt: Intl.DateTimeFormat, d: Date) {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return p;
}

export function datoTid(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = dele(TID, d);
  // Hårdt mellemrum efter "kl.", så en smal kolonne brydes før "kl.".
  return `${p.day}.${p.month}.${p.year} ${T.kl} ${p.hour}.${p.minute}`;
}

function langDato(d: Date): string {
  const p = dele(LANG_DATO, d);
  return `${p.day}. ${p.month} ${p.year} ${T.kl} ${p.hour}.${p.minute}`;
}

function kr(beloeb: number): string {
  const decimaler = Number.isInteger(beloeb) ? 0 : 2;
  return `${beloeb.toLocaleString("da-DK", { minimumFractionDigits: decimaler, maximumFractionDigits: 2 })} kr.`;
}

// Hele kroner (resten af beløbene er i øre og hedder *_oere).
const KRONER = new Set(["beloeb", "startpris", "nuvaerende_bud", "maksimum", "forrige", "maanedspris"]);
// Koder fra databasen ("afgjort_koeber" -> "Afgjort køber").
const KODER = new Set([
  "status",
  "type",
  "din_rolle",
  "stand",
  "grund",
  "synlighed",
  "konto_type",
  "abonnement_status",
  "stripe_abonnement_status",
  "pauset_aarsag",
  "kategori",
  "emne",
]);
// Interne referencer (id'er). Står kun i JSON-filen.
const SKJUL_ALTID = new Set(["id", "bruger_id", "pakke_id", "oprettet_af", "henvendelse_id", "naeste_pakke_id"]);
const SKJUL_NOEGLE = /krypteret|hash|secret|token|password|adgangskode/i;
const FOELSOM_NOEGLE = /(^|_)(cpr|tin)(_|$)/i;

// "saelger" -> "sælger", "foelger" -> "følger", "aar" -> "år".
function daniser(s: string): string {
  return s.replace(/aa/g, "å").replace(/ae/g, "æ").replace(/oe/g, "ø").replace(/Aa/g, "Å").replace(/Ae/g, "Æ").replace(/Oe/g, "Ø");
}

function stortForbogstav(s: string): string {
  return s ? s[0].toLocaleUpperCase("da-DK") + s.slice(1) : s;
}

function etiket(noegle: string): string {
  return DINE_DATA_FELTER[noegle] ?? stortForbogstav(daniser(noegle.replace(/_kl$/, "").replace(/_/g, " ")));
}

function erObj(v: Json | undefined): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function erPrimitiv(v: Json | undefined): boolean {
  return v === null || v === undefined || typeof v !== "object";
}

function erTom(v: Json | undefined): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (erObj(v)) return Object.values(v).every(erTom);
  return false;
}

type Opslag = { auktion: Map<string, string>; handel: Map<string, string> };

function fmt(noegle: string, v: Json | undefined, ctx: Opslag): string {
  if (v === null || v === undefined || v === "") return T.tom;
  if (FOELSOM_NOEGLE.test(noegle) && typeof v !== "boolean" && /\d{4,}/.test(String(v))) return T.skjultNummer;
  if (typeof v === "boolean") return v ? T.ja : T.nej;
  if (typeof v === "number") {
    if (noegle.endsWith("_oere")) return kr(v / 100);
    if (KRONER.has(noegle)) return kr(v);
    if (noegle === "stjerner") return `${v} af 5`;
    if (noegle === "aar") return String(v);
    return v.toLocaleString("da-DK", { maximumFractionDigits: 2 });
  }
  if (typeof v === "string") {
    if (noegle === "handel_id") return ctx.handel.get(v) ?? v;
    if (noegle === "auktion_id") return ctx.auktion.get(v) ?? v;
    if (ISO_TID.test(v)) return datoTid(v);
    const d = ISO_DATO.exec(v);
    if (d) return `${d[3]}.${d[2]}.${d[1]}`;
    if (KODER.has(noegle) && /^[a-z0-9_æøå]+$/.test(v)) return stortForbogstav(daniser(v.replace(/_/g, " ")));
    return v;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return T.tom;
    return v.map((x) => (erObj(x) ? objTekst(x, ctx) : fmt(noegle, x, ctx))).join("\n");
  }
  return objTekst(v, ctx);
}

function objTekst(o: Obj, ctx: Opslag): string {
  return synlige(o)
    .map((k) => `${etiket(k)}: ${fmt(k, o[k], ctx)}`)
    .join("\n");
}

function synlige(o: Obj): string[] {
  return Object.keys(o).filter(
    (k) =>
      !SKJUL_ALTID.has(k) &&
      !SKJUL_NOEGLE.test(k) &&
      !(k === "auktion_id" && (o.auktion || o.vare || o.titel)) &&
      !(k === "skjult_af_bidhamr" && "synlighed" in o),
  );
}

// Rækkefølgen af felter i kort og felt-lister. Ellers rækkefølgen i
// DINE_DATA_FELTER (jsonb sorterer nøglerne efter længde).
const ORDEN: Record<string, string[]> = {
  profil: ["navn", "fornavn", "efternavn", "email", "telefon", "adresse", "profilbillede", "oprettet"],
  handler: [
    "vare",
    "din_rolle",
    "modpart_fornavn",
    "beloeb",
    "status",
    "oprettet",
    "afhentning",
    "sendt_kl",
    "sporingsnummer",
    "modtaget_kl",
    "auktion_id",
    "betaling",
  ],
  "handler.betaling": [
    "bud_oere",
    "koebergebyr_oere",
    "saelgergebyr_oere",
    "fragt_oere",
    "bidhamr_beskyttelse_oere",
    "total_oere",
    "udbetaling_oere",
    "status",
    "betalt_kl",
    "frigivet_kl",
    "overfoert_kl",
    "refunderet_oere",
    "refunderet_kl",
  ],
  auktioner: ["titel", "status", "kategori", "maerke", "stand", "beskrivelse", "startpris", "nuvaerende_bud", "antal_bud"],
  sager: ["type", "status", "handel_id", "oprettet_af_dig", "beskrivelse", "afgoerelse", "oprettet_kl", "afgjort_kl"],
  anker: ["handel_id", "status", "begrundelse", "afgoerelse", "indgivet_kl", "behandlet_kl"],
  mitid: ["verificeret_kl", "note"],
};
const FELT_INDEKS = new Map(Object.keys(DINE_DATA_FELTER).map((k, i) => [k, i]));

function sorter(sti: string, noegler: string[]): string[] {
  const egen = ORDEN[sti] ?? [];
  const plads = (k: string) => {
    const i = egen.indexOf(k);
    if (i >= 0) return i;
    return 1000 + (FELT_INDEKS.get(k) ?? 5000);
  };
  return [...noegler].sort((a, b) => plads(a) - plads(b) || a.localeCompare(b));
}

// Tabeller: kolonner og relative bredder. Har en række felter, som ikke står
// her (fx et nyt felt fra databasen), vises listen som kort i stedet, så
// intet forsvinder.
type TabelOps = { kolonner: Array<readonly [string, number]>; udelad?: string[] };
const TABELLER: Record<string, TabelOps> = {
  bud: { kolonner: [["tidspunkt", 2], ["auktion", 4], ["beloeb", 1.5], ["bidhamr_beskyttelse", 1.6]] },
  notifikationer: {
    kolonner: [["tidspunkt", 1.7], ["titel", 2.4], ["tekst", 5], ["laest_kl", 1.7]],
    udelad: ["type"],
  },
  enheder: { kolonner: [["enhed", 4], ["foerst_set", 2], ["sidst_set", 2]] },
  favoritter: { kolonner: [["auktion", 5], ["tilfoejet_kl", 2]] },
  gemte_auktioner: { kolonner: [["auktion", 5], ["tilfoejet_kl", 2]] },
  saelgere_du_foelger: { kolonner: [["saelger_fornavn", 4], ["siden", 2]] },
  blokerede_brugere: { kolonner: [["bruger", 4], ["siden", 2]] },
  notifikationsindstillinger: { kolonner: [["type", 4], ["klokke", 1], ["mail", 1], ["push", 1]] },
  advarsler: { kolonner: [["tidspunkt", 1.6], ["begrundelse", 6]] },
  paamindelser: { kolonner: [["tidspunkt", 1.6], ["grund", 2], ["begrundelse", 5]] },
  bedoemmelser_givet: {
    kolonner: [["tidspunkt", 1.7], ["til_fornavn", 1.3], ["auktion", 2.5], ["stjerner", 1], ["kommentar", 3], ["synlighed", 1.4]],
  },
  bedoemmelser_modtaget: {
    kolonner: [["tidspunkt", 1.7], ["fra_fornavn", 1.3], ["auktion", 2.5], ["stjerner", 1], ["kommentar", 3], ["synlighed", 1.4]],
  },
  dine_svar_paa_bedoemmelser: {
    kolonner: [["oprettet", 1.7], ["auktion", 2.2], ["svar", 4], ["rettet_kl", 1.6], ["slettet_kl", 1.6], ["skjult", 1]],
  },
  spoergsmaal_du_har_stillet: {
    kolonner: [["stillet_kl", 1.7], ["auktion_id", 2.2], ["spoergsmaal", 3.5], ["svar", 3.5], ["besvaret_kl", 1.7]],
  },
  rapporter_om_auktioner: {
    kolonner: [["tidspunkt", 1.7], ["auktion_id", 2.4], ["kategori", 1.8], ["beskrivelse", 4], ["status", 1.3]],
  },
  rapporter_om_brugere: {
    kolonner: [["tidspunkt", 1.7], ["handel_id", 2.4], ["kategori", 1.8], ["beskrivelse", 4], ["status", 1.3]],
  },
  "mitid.verificeringer": {
    kolonner: [["verificeret_kl", 2], ["juridisk_navn", 3], ["foedselsdato", 1.6], ["status", 1.4], ["nulstillet_kl", 2]],
  },
  "mine_maksimumbud.maksimum": {
    kolonner: [["auktion", 4], ["maksimum", 1.5], ["bidhamr_beskyttelse", 1.6], ["oprettet", 2], ["opdateret", 2]],
  },
  "mine_maksimumbud.aendringer": {
    kolonner: [
      ["tidspunkt", 2],
      ["auktion_id", 3.5],
      ["forrige", 1.5],
      ["maksimum", 1.5],
      ["forrige_bidhamr_beskyttelse", 1.7],
      ["bidhamr_beskyttelse", 1.7],
    ],
  },
  "firmakonto.regninger": {
    kolonner: [
      ["nummer", 2.2],
      ["type", 1.6],
      ["periode_fra", 1.5],
      ["periode_til", 1.5],
      ["beloeb_oere", 1.6],
      ["status", 1.3],
      ["betalt_kl", 2],
      ["oprettet", 2],
    ],
  },
  "firmakonto.pakkeskift": {
    kolonner: [["oprettet", 2], ["type", 1.6], ["fra", 1.2], ["til", 1.2], ["status", 1.6], ["gaelder_fra", 1.6], ["behandlet", 2]],
  },
  "samtaler_med_bidhamr.beskeder": { kolonner: [["sendt_kl", 1.7], ["fra", 1.2], ["tekst", 6]] },
};

// Titlen på et kort (én post i en liste).
const TITEL_NOEGLER = ["vare", "titel", "emne", "nummer", "navn", "firmanavn", "auktion", "type"];
const DATO_NOEGLER = ["oprettet_kl", "oprettet", "tidspunkt", "indgivet_kl", "aabnet_kl", "sendt", "anmodet_kl", "indberettet_kl"];

// ---------------------------------------------------------------------------
// Skriveren: holder styr på side og position og laver nye sider efter behov.
// ---------------------------------------------------------------------------
export type Celle = { tekst: string; fed?: boolean; farve?: RGB };

export class Skriver {
  side!: PDFPage;
  y = 0;
  readonly indhold: Array<{ titel: string; side: number }> = [];
  private readonly bredder = new Map<string, number>();

  constructor(
    readonly doc: PDFDocument,
    readonly r: PDFFont,
    readonly b: PDFFont,
    private readonly tegnsaet: Set<number>,
  ) {}

  nySide() {
    this.side = this.doc.addPage([SIDE_B, SIDE_H]);
    this.y = TOP;
  }

  plads(h: number) {
    if (this.y - h < BUND) this.nySide();
  }

  // Fjerner styretegn og tegn, skrifttypen ikke har (fx emoji), så pdf-lib
  // aldrig fejler på brugerens tekst.
  ren(tekst: string): string {
    let ud = "";
    // NFC: "å" skrevet som a + ring bliver ét tegn (skrifttypen bruges uden
    // OpenType-features, se UDEN_FEATURES).
    for (const c of tekst.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ")) {
      const cp = c.codePointAt(0)!;
      if (cp === 10) ud += "\n";
      else if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || cp === 0xad || (cp >= 0x200b && cp <= 0x200f)) continue;
      else ud += this.tegnsaet.has(cp) ? c : "?";
    }
    return ud;
  }

  private bredde(tekst: string, font: PDFFont, str: number): number {
    const noegle = (font === this.b ? "b" : "r") + tekst;
    let w = this.bredder.get(noegle);
    if (w === undefined) {
      if (this.bredder.size > 50_000) this.bredder.clear();
      w = font.widthOfTextAtSize(tekst, 100) / 100;
      this.bredder.set(noegle, w);
    }
    return w * str;
  }

  ombryd(tekst: string, font: PDFFont, str: number, maks: number): string[] {
    const ud: string[] = [];
    const mellem = this.bredde(" ", font, str);
    maks -= 1; // lidt luft (kerning)
    for (const afsnit of this.ren(tekst).split("\n")) {
      let linje = "";
      let lb = 0;
      for (const ord of afsnit.split(" ")) {
        if (!ord) continue;
        const ob = this.bredde(ord, font, str);
        if (ob > maks) {
          // Meget lange ord (fx links) deles tegn for tegn.
          if (linje) ud.push(linje);
          let del = "";
          let db = 0;
          for (const c of ord) {
            const cb = this.bredde(c, font, str);
            if (db + cb > maks && del) {
              ud.push(del);
              del = "";
              db = 0;
            }
            del += c;
            db += cb;
          }
          linje = del;
          lb = db;
        } else if (!linje) {
          linje = ord;
          lb = ob;
        } else if (lb + mellem + ob <= maks) {
          linje += " " + ord;
          lb += mellem + ob;
        } else {
          ud.push(linje);
          linje = ord;
          lb = ob;
        }
      }
      ud.push(linje);
    }
    return ud;
  }

  private tegn(tekst: string, x: number, grundlinje: number, font: PDFFont, str: number, farve: RGB) {
    if (tekst) this.side.drawText(tekst, { x, y: grundlinje, size: str, font, color: farve });
  }

  afsnit(tekst: string, o: { str?: number; fed?: boolean; farve?: RGB; efter?: number; x?: number; bredde?: number } = {}) {
    const str = o.str ?? 10;
    const lh = str * 1.45;
    const font = o.fed ? this.b : this.r;
    const x = o.x ?? MARGEN;
    for (const linje of this.ombryd(tekst, font, str, o.bredde ?? BREDDE)) {
      this.plads(lh);
      this.tegn(linje, x, this.y - lh * 0.75, font, str, o.farve ?? F.tekst);
      this.y -= lh;
    }
    this.y -= o.efter ?? 6;
  }

  overskrift(titel: string) {
    this.plads(110); // aldrig en overskrift alene nederst på en side
    if (this.y < TOP) this.y -= 14;
    this.indhold.push({ titel, side: this.doc.getPageCount() });
    this.tegn(this.ren(titel), MARGEN, this.y - 16, this.b, 16, F.groen);
    this.y -= 24;
    this.side.drawLine({
      start: { x: MARGEN, y: this.y },
      end: { x: SIDE_B - MARGEN, y: this.y },
      thickness: 1,
      color: F.groen,
    });
    this.y -= 10;
  }

  underoverskrift(titel: string, str = 11) {
    this.plads(60);
    this.y -= 4;
    this.afsnit(titel, { str, fed: true, efter: 3 });
  }

  // Tabel med ombrudte celler. Rækker, der ikke kan være på siden, fortsætter
  // på næste side (med kolonneoverskrifterne gentaget).
  tabel(hoved: string[] | null, vaegte: number[], raekker: Celle[][]) {
    // Hver kolonne får mindst plads til sit længste ord (højst ORD_MAKS, så
    // et langt link ikke tager hele bredden). Resten fordeles efter vægt.
    const ORD_MAKS = 110;
    const minB = vaegte.map((_, j) => {
      let m = 0;
      const maal = (tekst: string, font: PDFFont) => {
        for (const ord of tekst.split(/[ \n]/)) {
          if (ord.length > 40) return void (m = ORD_MAKS);
          if (ord) m = Math.max(m, this.bredde(ord, font, TABEL_STR));
        }
      };
      if (hoved) maal(hoved[j] ?? "", this.b);
      for (const r of raekker) {
        if (m >= ORD_MAKS) break;
        if (r[j]) maal(r[j].tekst, r[j].fed ? this.b : this.r);
      }
      return Math.min(m, ORD_MAKS) + 2 * CELLE_PAD_X + 2;
    });
    const sum = vaegte.reduce((a, b) => a + b, 0);
    const minSum = minB.reduce((a, b) => a + b, 0);
    const bredder =
      minSum >= BREDDE
        ? minB.map((m) => (BREDDE * m) / minSum)
        : minB.map((m, j) => m + ((BREDDE - minSum) * vaegte[j]) / sum);
    const xs: number[] = [];
    let x = MARGEN;
    for (const w of bredder) {
      xs.push(x);
      x += w;
    }
    const tekstB = bredder.map((w) => w - 2 * CELLE_PAD_X);

    const hovedLinjer = hoved ? hoved.map((h, j) => this.ombryd(h, this.b, TABEL_STR, tekstB[j])) : [];
    const hovedH = hoved ? Math.max(...hovedLinjer.map((l) => l.length)) * TABEL_LH + 2 * CELLE_PAD_Y : 0;
    const tegnHoved = () => {
      if (!hoved) return;
      this.side.drawRectangle({ x: MARGEN, y: this.y - hovedH, width: BREDDE, height: hovedH, color: F.groenLys });
      hovedLinjer.forEach((linjer, j) =>
        linjer.forEach((l, i) =>
          this.tegn(l, xs[j] + CELLE_PAD_X, this.y - CELLE_PAD_Y - i * TABEL_LH - TABEL_LH * 0.75, this.b, TABEL_STR, F.groen),
        ),
      );
      this.y -= hovedH;
    };
    const nySideMedHoved = () => {
      this.nySide();
      tegnHoved();
    };

    this.plads(hovedH + 2 * TABEL_LH + 2 * CELLE_PAD_Y);
    tegnHoved();

    const maksPrSide = Math.floor((TOP - BUND - hovedH - 2 * CELLE_PAD_Y) / TABEL_LH);
    raekker.forEach((raekke, ri) => {
      const linjer = raekke.map((c, j) => this.ombryd(c.tekst, c.fed ? this.b : this.r, TABEL_STR, tekstB[j]));
      const n = Math.max(1, ...linjer.map((l) => l.length));
      // Små rækker deles ikke over to sider.
      if (n <= maksPrSide && this.y - (n * TABEL_LH + 2 * CELLE_PAD_Y) < BUND) nySideMedHoved();
      let start = 0;
      while (start < n) {
        const ledige = Math.floor((this.y - BUND - 2 * CELLE_PAD_Y) / TABEL_LH);
        if (ledige < 1) {
          nySideMedHoved();
          continue;
        }
        const k = Math.min(ledige, n - start);
        const h = k * TABEL_LH + 2 * CELLE_PAD_Y;
        if (ri % 2 === 1) {
          this.side.drawRectangle({ x: MARGEN, y: this.y - h, width: BREDDE, height: h, color: F.stribe });
        }
        linjer.forEach((cl, j) => {
          const c = raekke[j];
          for (let i = start; i < start + k && i < cl.length; i++) {
            this.tegn(
              cl[i],
              xs[j] + CELLE_PAD_X,
              this.y - CELLE_PAD_Y - (i - start) * TABEL_LH - TABEL_LH * 0.75,
              c.fed ? this.b : this.r,
              TABEL_STR,
              c.farve ?? F.tekst,
            );
          }
        });
        this.y -= h;
        this.side.drawLine({
          start: { x: MARGEN, y: this.y },
          end: { x: SIDE_B - MARGEN, y: this.y },
          thickness: 0.5,
          color: F.kant,
        });
        start += k;
        if (start < n) nySideMedHoved();
      }
    });
    this.y -= 8;
  }

  felter(raekker: Array<[string, string]>) {
    if (!raekker.length) return;
    this.tabel(
      null,
      [1.15, 2.6],
      raekker.map(([e, v]) => [{ tekst: e, fed: true, farve: F.daempet }, { tekst: v }]),
    );
  }
}

// ---------------------------------------------------------------------------
// Afsnittene
// ---------------------------------------------------------------------------
function tegnVaerdi(s: Skriver, sti: string, v: Json, ctx: Opslag) {
  if (erTom(v)) {
    s.afsnit(T.ingen, { farve: F.daempet, str: 9.5 });
    return;
  }
  if (Array.isArray(v)) {
    if (sti === "beskeder_i_handler") return tegnBeskeder(s, v, ctx);
    if (v.every(erObj)) return tegnListe(s, sti, v as Obj[], ctx);
    return s.felter(v.map((x, i) => [`${T.nr} ${i + 1}`, erObj(x) ? objTekst(x, ctx) : fmt(sti, x, ctx)]));
  }
  if (erObj(v)) return tegnObjekt(s, sti, v, ctx);
  const sidste = sti.split(".").pop() ?? sti;
  s.felter([[etiket(sidste), fmt(sidste, v, ctx)]]);
}

function erFladt(o: Obj): boolean {
  return Object.values(o).every((x) => erPrimitiv(x) || (Array.isArray(x) && x.every(erPrimitiv)));
}

function tegnObjekt(s: Skriver, sti: string, o: Obj, ctx: Opslag, udenom?: string) {
  const raekker: Array<[string, string]> = [];
  const under: string[] = [];
  for (const k of sorter(sti, synlige(o))) {
    if (k === udenom) continue;
    const v = o[k];
    const delsti = `${sti}.${k}`;
    if (DINE_DATA_UNDERAFSNIT[delsti] || (Array.isArray(v) && v.length > 0 && v.some(erObj))) {
      under.push(k);
    } else if (erObj(v)) {
      if (erFladt(v)) {
        // Fx "Gemt kort: Mærke". Beløb i betaling osv. bevarer feltnavnet.
        for (const uk of sorter(delsti, synlige(v))) raekker.push([`${etiket(k)}: ${etiket(uk)}`, fmt(uk, v[uk], ctx)]);
      } else {
        under.push(k);
      }
    } else {
      raekker.push([etiket(k), fmt(k, v, ctx)]);
    }
  }
  s.felter(raekker);
  for (const k of under) {
    const delsti = `${sti}.${k}`;
    s.underoverskrift(DINE_DATA_UNDERAFSNIT[delsti] ?? etiket(k), 10.5);
    tegnVaerdi(s, delsti, o[k], ctx);
  }
}

function tabelPasser(ops: TabelOps, poster: Obj[]): boolean {
  const kendte = new Set([...ops.kolonner.map(([k]) => k), ...(ops.udelad ?? [])]);
  return poster.every((p) => synlige(p).every((k) => kendte.has(k) && (erPrimitiv(p[k]) || (Array.isArray(p[k]) && (p[k] as Json[]).every(erPrimitiv)))));
}

function tegnListe(s: Skriver, sti: string, poster: Obj[], ctx: Opslag) {
  const sidste = sti.split(".").pop() ?? sti;
  let ops: TabelOps | undefined = TABELLER[sti];
  if (ops && !tabelPasser(ops, poster)) ops = undefined;
  if (!ops && !TABELLER[sti]) {
    // Ukendt liste: tabel, hvis den er lille og flad, ellers kort.
    const noegler = sorter(sti, [...new Set(poster.flatMap(synlige))]);
    const flad = poster.every((p) => synlige(p).every((k) => erPrimitiv(p[k])));
    if (flad && noegler.length > 0 && noegler.length <= 6) {
      ops = {
        kolonner: noegler.map(
          (k) => [k, Math.min(5, Math.max(1, ...poster.map((p) => fmt(k, p[k], ctx).length / 12)))] as const,
        ),
      };
    }
  }
  if (ops) {
    const kolonner = ops.kolonner;
    const kvartal = sidste === "kvartaler";
    s.tabel(
      [...(kvartal ? [T.kvartal] : []), ...kolonner.map(([k]) => etiket(k))],
      [...(kvartal ? [1] : []), ...kolonner.map(([, w]) => w)],
      poster.map((p, i) => [
        ...(kvartal ? [{ tekst: `${i + 1}.` }] : []),
        ...kolonner.map(([k]) => ({ tekst: fmt(k, p[k], ctx) })),
      ]),
    );
    return;
  }
  poster.forEach((p, i) => {
    const tNoegle = TITEL_NOEGLER.find((k) => typeof p[k] === "string" && p[k]);
    const dNoegle = DATO_NOEGLER.find((k) => typeof p[k] === "string" && p[k]);
    let titel = tNoegle ? fmt(tNoegle, p[tNoegle], ctx) : `${T.nr} ${i + 1}`;
    if (sti === "handler" && typeof p.din_rolle === "string") titel += ` (${p.din_rolle})`;
    if (dNoegle && dNoegle !== tNoegle) titel += ` · ${fmt(dNoegle, p[dNoegle], ctx)}`;
    s.underoverskrift(titel, 10);
    tegnObjekt(s, sti, p, ctx, tNoegle);
  });
}

// Beskeder samles pr. handel med varens navn som overskrift.
function tegnBeskeder(s: Skriver, beskeder: Json[], ctx: Opslag) {
  const kendte = new Set(["handel_id", "fra", "tekst", "sendt_kl"]);
  const poster = beskeder.filter(erObj);
  if (poster.length !== beskeder.length || !poster.every((p) => synlige(p).every((k) => kendte.has(k) && erPrimitiv(p[k])))) {
    return tegnListe(s, "beskeder_i_handler.liste", poster, ctx);
  }
  const grupper = new Map<string, Obj[]>();
  for (const p of poster) {
    const id = String(p.handel_id ?? "");
    const g = grupper.get(id);
    if (g) g.push(p);
    else grupper.set(id, [p]);
  }
  for (const [id, g] of grupper) {
    s.underoverskrift(`${T.handel}: ${id ? (ctx.handel.get(id) ?? id) : T.tom}`, 10);
    s.tabel(
      [etiket("sendt_kl"), etiket("fra"), etiket("tekst")],
      [1.7, 1.2, 6],
      g.map((p) => [{ tekst: fmt("sendt_kl", p.sendt_kl, ctx) }, { tekst: fmt("fra", p.fra, ctx) }, { tekst: fmt("tekst", p.tekst, ctx) }]),
    );
  }
}

function lavOpslag(data: Obj): Opslag {
  const auktion = new Map<string, string>();
  const handel = new Map<string, string>();
  const liste = (v: Json | undefined) => (Array.isArray(v) ? v.filter(erObj) : []);
  for (const a of liste(data.auktioner)) if (typeof a.id === "string" && typeof a.titel === "string") auktion.set(a.id, a.titel);
  const mb = erObj(data.mine_maksimumbud) ? data.mine_maksimumbud : {};
  for (const k of [data.bud, data.favoritter, data.gemte_auktioner, mb.maksimum]) {
    for (const x of liste(k)) {
      if (typeof x.auktion_id === "string" && typeof x.auktion === "string") auktion.set(x.auktion_id, x.auktion);
    }
  }
  for (const h of liste(data.handler)) {
    if (typeof h.id !== "string") continue;
    const vare = typeof h.vare === "string" && h.vare ? h.vare : T.tom;
    if (typeof h.auction_id === "string" || typeof h.auktion_id === "string") {
      const aid = String(h.auktion_id ?? h.auction_id);
      if (vare !== T.tom && !auktion.has(aid)) auktion.set(aid, vare);
    }
    handel.set(h.id, typeof h.oprettet === "string" ? `${vare} (${fmt("oprettet", h.oprettet, { auktion, handel })})` : vare);
  }
  return { auktion, handel };
}

// ---------------------------------------------------------------------------
// Selve PDF'en
// ---------------------------------------------------------------------------
export async function lavMineDataPdf(raa: unknown): Promise<Uint8Array> {
  const data: Obj = erObj(raa as Json) ? (raa as Obj) : {};
  const [rBytes, bBytes] = await hentSkrifter();

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const r = await doc.embedFont(rBytes, { subset: true, features: UDEN_FEATURES });
  const b = await doc.embedFont(bBytes, { subset: true, features: UDEN_FEATURES });
  const tegnsaet = new Set(r.getCharacterSet());
  const s = new Skriver(doc, r, b, tegnsaet);
  const ctx = lavOpslag(data);

  const profil = erObj(data.profil) ? data.profil : {};
  const om = erObj(data.om_udtraekket) ? data.om_udtraekket : {};
  const navn =
    (typeof profil.navn === "string" && profil.navn.trim()) ||
    [profil.fornavn, profil.efternavn].filter((x) => typeof x === "string" && x.trim()).join(" ") ||
    T.tom;
  const email = typeof profil.email === "string" && profil.email ? profil.email : T.tom;
  const dannetD = typeof om.dannet_kl === "string" ? new Date(om.dannet_kl) : new Date();
  const dannet = Number.isNaN(dannetD.getTime()) ? new Date() : dannetD;

  doc.setTitle(T.titel);
  doc.setAuthor("BidHamr ApS");
  doc.setCreator("BidHamr");
  doc.setProducer("BidHamr");
  doc.setLanguage("da-DK");
  doc.setCreationDate(dannet);
  doc.setModificationDate(dannet);

  // --- Forside ---
  s.nySide();
  s.y = SIDE_H - 72;
  s.afsnit("BidHamr", { str: 13, fed: true, farve: F.groen, efter: 22 });
  s.afsnit(T.titel, { str: 28, fed: true, efter: 18 });
  s.side.drawLine({ start: { x: MARGEN, y: s.y }, end: { x: SIDE_B - MARGEN, y: s.y }, thickness: 1.5, color: F.groen });
  s.y -= 18;
  for (const [e, v] of [
    [T.navn, navn],
    [T.email, email],
    [T.dannet, langDato(dannet)],
  ] as const) {
    s.afsnit(e, { str: 9, farve: F.daempet, efter: 0 });
    s.afsnit(v, { str: 13, fed: true, efter: 10 });
  }
  s.y -= 4;
  s.afsnit(T.afsender, { str: 9.5, farve: F.daempet, efter: 22 });
  s.afsnit(T.om, { str: 12, fed: true, efter: 4 });
  if (typeof om.forklaring === "string" && om.forklaring) s.afsnit(om.forklaring, { str: 9.5, efter: 4 });
  s.afsnit(T.omPdf, { str: 9.5, efter: 18 });
  s.afsnit(T.indhold, { str: 12, fed: true, efter: 4 });
  const forside = s.side;
  const indholdY = s.y;

  // --- Afsnittene ---
  s.nySide();
  const tomme: string[] = [];
  const kendte = new Set(DINE_DATA_AFSNIT.map(([k]) => k));
  const afsnit: Array<readonly [string, string]> = [
    ...DINE_DATA_AFSNIT.filter(([k]) => k in data),
    ...Object.keys(data)
      .filter((k) => !kendte.has(k) && k !== "om_udtraekket" && !SKJUL_NOEGLE.test(k))
      .sort()
      .map((k) => [k, etiket(k)] as const),
  ];
  for (const [noegle, titel] of afsnit) {
    const v = data[noegle];
    if (erTom(v)) {
      tomme.push(titel);
      continue;
    }
    s.overskrift(titel);
    try {
      tegnVaerdi(s, noegle, v, ctx);
    } catch (e) {
      // Ét afsnit må ikke vælte hele PDF'en - det står under alle
      // omstændigheder i JSON-filen.
      console.error(`[mine-data-pdf] afsnit ${noegle} fejlede`, e);
      s.afsnit(T.afsnitFejl, { farve: F.daempet, str: 9.5 });
    }
  }
  if (tomme.length) {
    s.overskrift(T.tommeAfsnit);
    s.afsnit(T.tommeForklaring, { str: 9.5, efter: 4 });
    s.afsnit(tomme.join(", ") + ".", { str: 9.5, farve: F.daempet });
  }

  // --- Indholdsfortegnelse på forsiden (sidetal kendes først nu) ---
  const lh = 14;
  const pladsPrKolonne = Math.max(1, Math.floor((indholdY - BUND) / lh));
  const kolonner = Math.min(3, Math.ceil(s.indhold.length / pladsPrKolonne));
  const kolB = BREDDE / Math.max(1, kolonner);
  s.indhold.slice(0, pladsPrKolonne * 3).forEach((p, i) => {
    const kol = Math.floor(i / pladsPrKolonne);
    const y = indholdY - (i % pladsPrKolonne) * lh - lh * 0.75;
    const x = MARGEN + kol * kolB;
    const nr = String(p.side);
    const nrB = r.widthOfTextAtSize(nr, 9.5);
    const titel = s.ombryd(p.titel, r, 9.5, kolB - nrB - 24)[0] ?? "";
    forside.drawText(titel, { x, y, size: 9.5, font: r, color: F.tekst });
    forside.drawText(nr, { x: x + kolB - 12 - nrB, y, size: 9.5, font: r, color: F.daempet });
  });

  // --- Sidehoved og -fod ---
  const sider = doc.getPages();
  const hovedTekst = s.ren(`${T.titel} · ${navn}`);
  sider.forEach((side, i) => {
    if (i > 0) {
      side.drawText(s.ombryd(hovedTekst, r, 8, BREDDE)[0] ?? "", { x: MARGEN, y: SIDE_H - 34, size: 8, font: r, color: F.daempet });
      side.drawLine({
        start: { x: MARGEN, y: SIDE_H - 40 },
        end: { x: SIDE_B - MARGEN, y: SIDE_H - 40 },
        thickness: 0.5,
        color: F.kant,
      });
    }
    side.drawLine({ start: { x: MARGEN, y: 40 }, end: { x: SIDE_B - MARGEN, y: 40 }, thickness: 0.5, color: F.kant });
    side.drawText(T.afsender, { x: MARGEN, y: 28, size: 8, font: r, color: F.daempet });
    const nr = T.side(i + 1, sider.length);
    side.drawText(nr, { x: SIDE_B - MARGEN - r.widthOfTextAtSize(nr, 8), y: 28, size: 8, font: r, color: F.daempet });
  });

  return doc.save();
}
