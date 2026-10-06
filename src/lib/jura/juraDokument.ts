import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

// Læser udkastene i jura/ (skrevet af indhold-agenten) og laver dem om til en
// enkel struktur, som src/components/jura/JuraSide.tsx viser. Kører kun på
// serveren - intet markdown-bibliotek sendes til browseren.
//
// Markdown-filerne rettes ikke her. Ved visning:
//   - "# UDKAST ..."-linjen, "**Version:** ..."-linjen og alle citatblokke
//     (> "Til Filip og advokaten" / "Til indhold-agenten") fjernes.
//   - [ADVOKAT ...]-noter (også [ADVOKAT/revisor: ...]) fjernes helt.
//   - [TODO ...]-noter vises som en neutral pladsholder.
// Er der efter rensningen stadig "ADVOKAT", "TODO" eller "indhold-agenten" i
// teksten, kastes en fejl, så en intern note aldrig vises ved en fejl.
//
// Understøttet markdown (det, udkastene bruger): # titel, ## afsnit,
// ### underafsnit, afsnit, punktlister (- ), tabeller, **fed** og `kode`.
// `/sti` bliver et link til siden. E-mailadresser bliver mailto-links.

export const PLADSHOLDER = "[udfyldes inden lancering]";
const P = "\u0000P\u0000";

export type Inline =
  | { type: "tekst"; tekst: string }
  | { type: "fed"; indhold: Inline[] }
  | { type: "kode"; tekst: string }
  | { type: "link"; tekst: string; href: string }
  | { type: "pladsholder" };

export type Blok =
  | { type: "afsnit"; nummer: string | null; indhold: Inline[] }
  | { type: "liste"; punkter: Inline[][] }
  | { type: "tabel"; kolonner: Inline[][]; raekker: Inline[][][] }
  | { type: "underoverskrift"; id: string; tekst: string };

export type JuraAfsnit = { id: string; overskrift: string; blokke: Blok[] };
export type JuraDokument = { titel: string; afsnit: JuraAfsnit[] };

function slug(tekst: string): string {
  return tekst
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Fjerner interne noter fra én linje.
function rens(linje: string): string {
  return linje
    .replace(/\s*\[ADVOKAT[^\]]*\]/gi, "")
    .replace(/\[TODO[^\]]*\]/gi, P)
    .replace(new RegExp(`${P}(\\s*${P})+`, "g"), P)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function inline(tekst: string): Inline[] {
  const ud: Inline[] = [];
  const moenster = /\*\*(.+?)\*\*|`([^`]+)`|\u0000P\u0000|([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,})/g;
  let sidst = 0;
  for (const m of tekst.matchAll(moenster)) {
    const i = m.index ?? 0;
    if (i > sidst) ud.push({ type: "tekst", tekst: tekst.slice(sidst, i) });
    if (m[1] !== undefined) ud.push({ type: "fed", indhold: inline(m[1]) });
    else if (m[2] !== undefined) {
      const kode = m[2];
      if (/^\/(?!\/)[a-z0-9\-/]*$/.test(kode)) ud.push({ type: "link", tekst: `bidhamr.dk${kode}`, href: kode });
      else ud.push({ type: "kode", tekst: kode });
    } else if (m[3] !== undefined) ud.push({ type: "link", tekst: m[3], href: `mailto:${m[3]}` });
    else ud.push({ type: "pladsholder" });
    sidst = i + m[0].length;
  }
  if (sidst < tekst.length) ud.push({ type: "tekst", tekst: tekst.slice(sidst) });
  return ud;
}

function celler(linje: string): string[] {
  return linje
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function celle(c: string): Inline[] {
  const r = rens(c);
  return r ? inline(r) : [{ type: "pladsholder" }];
}

export function parseJura(markdown: string): JuraDokument {
  const linjer = markdown.replace(/\r\n?/g, "\n").split("\n");
  let titel = "";
  const afsnit: JuraAfsnit[] = [];
  let aktuelt: JuraAfsnit | null = null;
  let paragraf: string[] = [];
  let liste: Inline[][] | null = null;
  let tabel: string[] | null = null;

  const blokke = () => {
    if (!aktuelt) throw new Error("Tekst før første afsnit (##) i juradokument.");
    return aktuelt.blokke;
  };
  const afslutParagraf = () => {
    if (paragraf.length === 0) return;
    const tekst = rens(paragraf.join(" "));
    paragraf = [];
    if (!tekst) return;
    const nr = /^(\d+\.\d+)\s+/.exec(tekst);
    blokke().push({
      type: "afsnit",
      nummer: nr ? nr[1] : null,
      indhold: inline(nr ? tekst.slice(nr[0].length) : tekst),
    });
  };
  const afslutListe = () => {
    if (liste && liste.length > 0) blokke().push({ type: "liste", punkter: liste });
    liste = null;
  };
  const afslutTabel = () => {
    if (!tabel) return;
    const [hoved, , ...rest] = tabel;
    blokke().push({
      type: "tabel",
      kolonner: celler(hoved).map(celle),
      raekker: rest.map((r) => celler(r).map(celle)),
    });
    tabel = null;
  };
  const afslutAlt = () => {
    afslutParagraf();
    afslutListe();
    afslutTabel();
  };

  for (const raa of linjer) {
    const linje = raa.trimEnd();

    if (/^\s*>/.test(linje)) {
      // Interne noter (citatblokke) vises aldrig.
      afslutAlt();
      continue;
    }
    if (/^# UDKAST/i.test(linje) || /^\*\*Version:\*\*/.test(linje)) continue;
    if (/^#\s+/.test(linje)) {
      titel = linje.replace(/^#\s+/, "").trim();
      continue;
    }
    if (/^##\s+/.test(linje)) {
      if (aktuelt) afslutAlt();
      const overskrift = linje.replace(/^##\s+/, "").trim();
      const nr = /^(\d+)\./.exec(overskrift);
      aktuelt = { id: nr ? `afsnit-${nr[1]}` : slug(overskrift), overskrift, blokke: [] };
      afsnit.push(aktuelt);
      continue;
    }
    if (!aktuelt) continue;
    if (/^###\s+/.test(linje)) {
      afslutAlt();
      const tekst = linje.replace(/^###\s+/, "").trim();
      const nr = /^(\d+)\.(\d+)\s/.exec(tekst);
      const id = nr ? `afsnit-${nr[1]}-${nr[2]}` : `${aktuelt.id}-${slug(tekst)}`;
      blokke().push({ type: "underoverskrift", id, tekst });
      continue;
    }
    if (/^---+$/.test(linje) || linje === "") {
      afslutAlt();
      continue;
    }
    if (/^\|/.test(linje)) {
      afslutParagraf();
      afslutListe();
      tabel = [...(tabel ?? []), linje];
      continue;
    }
    if (/^[-*]\s+/.test(linje)) {
      afslutParagraf();
      afslutTabel();
      const tekst = rens(linje.replace(/^[-*]\s+/, ""));
      if (tekst) (liste ??= []).push(inline(tekst));
      continue;
    }
    afslutListe();
    afslutTabel();
    paragraf.push(linje);
  }
  if (aktuelt) afslutAlt();

  // Et afsnit, der kun bestod af interne noter, vises ikke.
  const synlige = afsnit.filter((a) => a.blokke.length > 0);

  const alTekst = JSON.stringify({ titel, synlige });
  if (/ADVOKAT|TODO|indhold-agenten|noter-til-advokat|Filip|Claude|forsikring|\\u0000/i.test(alTekst)) {
    throw new Error("Juradokumentet indeholder stadig interne noter efter rensning.");
  }
  if (!titel || synlige.length === 0) throw new Error("Juradokumentet er tomt.");
  return { titel, afsnit: synlige };
}

// Faste stier (ikke dynamiske), så Next kan spore filerne til serverbuildet.
const cache = new Map<string, JuraDokument>();

function laes(fil: string, sti: string): JuraDokument {
  const fundet = cache.get(fil);
  if (fundet) return fundet;
  const dok = parseJura(readFileSync(sti, "utf8"));
  cache.set(fil, dok);
  return dok;
}

export function hentBrugerbetingelser(): JuraDokument {
  return laes("betingelser", path.join(process.cwd(), "jura", "brugerbetingelser-udkast.md"));
}

export function hentPrivatlivspolitik(): JuraDokument {
  return laes("privatliv", path.join(process.cwd(), "jura", "privatlivspolitik-udkast.md"));
}
