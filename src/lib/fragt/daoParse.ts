// Parsning af DAO's svar (ren kode - intet netværk, ingen server-only), så
// den kan testes mod fixtures (src/lib/fragt/__fixtures__/dao/ og
// tests/fragt/). Netværket ligger i dao.ts.
//
// DAO's dokumentation er ikke helt til at stole på: eksemplerne bruger "pæne"
// anførselstegn (”OK”), nogle feltnavne er stavet forskelligt (longtide,
// jobdaddressno), FindPakkeshop svarer "ERROR" i stedet for "FEJL", og
// pickup-endpoints bruger engelske navne (errorcode, result). Alt læses derfor
// tolerant: feltnavne uden hensyn til store/små bogstaver, tal som tekst eller
// tal, og et svar uden status er "ugyldigt" (aldrig "OK").
import { daoKodeTilType, listeFraPakketype, normaliserKode, type DaoListe } from "@/lib/fragt/daoKoder";
import type { Pakkeshop, Sporingshaendelse, UkendtSporingskode, WebhookHaendelse } from "@/lib/fragt/types";

// ------------------------------------------------------------ sanitering

// kundeid og kode står i URL'en (query) på næsten alle DAO-kald. Hverken URL'en
// eller værdierne må nogensinde logges eller stå i en fejlbesked. saniter()
// bruges på ALLE tekster fra dao.ts, før de forlader modulet:
//   - de konkrete hemmeligheder (fra env) erstattes, hvor de end står,
//   - kundeid=/kode=/client_secret=/password= i en tekst erstattes,
//   - URL'er afkortes til origin + sti (ingen query, ingen hash).
export function saniter(tekst: string, hemmeligheder: readonly (string | null | undefined)[] = []): string {
  let t = String(tekst ?? "");
  for (const h of hemmeligheder) {
    if (typeof h === "string" && h.length >= 3) t = t.split(h).join("[skjult]");
    // Også URL-kodet (fx æ/ø/å eller + i koden).
    if (typeof h === "string" && h.length >= 3) {
      const kodet = encodeURIComponent(h);
      if (kodet !== h) t = t.split(kodet).join("[skjult]");
    }
  }
  t = t.replace(/(^|[?&;\s"'(,])(kundeid|kode|client_id|client_secret|password|apikey)=[^&\s"')]*/gi, "$1$2=[skjult]");
  t = t.replace(/https?:\/\/[^\s"'<>)]+/gi, (u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname;
    } catch {
      return "[url]";
    }
  });
  return t;
}

// ------------------------------------------------------------ JSON og felter

// JSON fra DAO: BOM fjernes, og "pæne" anførselstegn rettes KUN, hvis
// almindelig parsning fejler (et rigtigt svar kan have ” i et shopnavn).
export function parseDaoJson(tekst: string): unknown | null {
  const t = String(tekst ?? "").replace(/^﻿/, "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    try {
      return JSON.parse(t.replace(/[“”„‟″]/g, '"'));
    } catch {
      return null;
    }
  }
}

function erObjekt(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Første felt med et af navnene (store/små bogstaver ligegyldigt).
export function felt(obj: unknown, ...navne: string[]): unknown {
  if (!erObjekt(obj)) return undefined;
  const noegler = Object.keys(obj);
  for (const n of navne) {
    if (n in obj) return obj[n];
    const k = noegler.find((x) => x.toLowerCase() === n.toLowerCase());
    if (k !== undefined) return obj[k];
  }
  return undefined;
}

function tekstFelt(obj: unknown, maks: number, ...navne: string[]): string | null {
  const v = felt(obj, ...navne);
  if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, maks);
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, maks) : null;
}

function talFelt(obj: unknown, ...navne: string[]): number | null {
  const v = felt(obj, ...navne);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type DaoSvar =
  | { status: "ok"; resultat: unknown; rod: Record<string, unknown> }
  | { status: "fejl"; fejlkode: string | null; fejltekst: string | null }
  | { status: "ugyldig" };

// { status: "OK" | "FEJL" | "ERROR", fejlkode, fejltekst, resultat }.
// HTTP-status er 200, også ved fejl - status SKAL læses.
export function tolkSvar(json: unknown): DaoSvar {
  if (!erObjekt(json)) return { status: "ugyldig" };
  const s = felt(json, "status");
  const status = typeof s === "string" ? s.replace(/[“”"]/g, "").trim().toUpperCase() : "";
  if (status === "OK") return { status: "ok", resultat: felt(json, "resultat", "result"), rod: json };
  if (status === "FEJL" || status === "ERROR" || status === "FAILED" || status === "FAIL") {
    const kode = felt(json, "fejlkode", "errorcode", "error_code");
    return {
      status: "fejl",
      fejlkode: typeof kode === "number" || typeof kode === "string" ? String(kode).trim().slice(0, 10) || null : null,
      fejltekst: tekstFelt(json, 200, "fejltekst", "errortext", "error_text", "message"),
    };
  }
  return { status: "ugyldig" };
}

// ------------------------------------------------------------ koder

// GS1-128-stregkode (A20 i dokumentationen; lidt luft).
export function gyldigStregkode(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9]{6,40}$/.test(v);
}

// Labelfri kode, fx "123 456 789". Vises for sælgeren, som den er.
export function renLabelfriKode(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = String(v).replace(/\s+/g, " ").trim();
  if (!/^[A-Za-z0-9 -]{3,40}$/.test(t)) return null;
  return t;
}

// ------------------------------------------------------------ tid

const KBH = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Copenhagen",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// Forskellen (ms) mellem dansk tid og UTC på et tidspunkt.
function kbhOffsetMs(t: number): number {
  const d: Record<string, number> = {};
  for (const p of KBH.formatToParts(new Date(t))) {
    if (p.type !== "literal") d[p.type] = Number(p.value);
  }
  return Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second) - Math.floor(t / 1000) * 1000;
}

// DAO: "YYYY-MM-DD HH:MM:SS" uden tidszone - antaget dansk tid (TODO(DAO):
// bekræft). Med tidszone (Z/+02:00) bruges den. null = kan ikke læses.
export function daoTidTilIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
    const d = Date.parse(s.replace(" ", "T"));
    return Number.isNaN(d) ? null : new Date(d).toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => Number(x ?? 0));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const somUtc = Date.UTC(y, mo - 1, d, h, mi, se);
  // To gennemløb giver det rigtige resultat også omkring sommertid.
  let t = somUtc - kbhOffsetMs(somUtc);
  t = somUtc - kbhOffsetMs(t);
  return new Date(t).toISOString();
}

// ------------------------------------------------------------ pakkeshops

const DAGE: [string, string][] = [
  ["man", "Mandag"],
  ["tir", "Tirsdag"],
  ["ons", "Onsdag"],
  ["tor", "Torsdag"],
  ["fre", "Fredag"],
  ["lor", "Lørdag"],
  ["son", "Søndag"],
];

// { man: "07:30 - 21:00", …, lor, son } -> [{ dag: "Mandag", tider }].
export function aabningstider(obj: unknown): { dag: string; tider: string }[] {
  if (!erObjekt(obj)) return [];
  const ud: { dag: string; tider: string }[] = [];
  for (const [kort, dag] of DAGE) {
    const tider = tekstFelt(obj, 60, kort, kort === "lor" ? "lør" : kort, kort === "son" ? "søn" : kort, dag);
    if (tider) ud.push({ dag, tider });
  }
  return ud;
}

export function tilPakkeshop(p: unknown): Pakkeshop | null {
  const id = tekstFelt(p, 50, "shopId", "shopid", "id");
  const navn = tekstFelt(p, 120, "navn", "name");
  if (!id || !/^[A-Za-z0-9_-]{1,50}$/.test(id) || !navn) return null;
  const postnummer = tekstFelt(p, 10, "postnr", "postnummer", "zipcode") ?? "";
  const km = talFelt(p, "afstand", "distance");
  return {
    id,
    navn,
    adresse: tekstFelt(p, 200, "adresse", "address") ?? "",
    postnummer: /^\d{4}$/.test(postnummer) ? postnummer : postnummer.slice(0, 4),
    by: tekstFelt(p, 80, "bynavn", "by", "city") ?? "",
    lat: talFelt(p, "latitude", "lat"),
    lng: talFelt(p, "longitude", "longtide", "lng"),
    afstandM: km === null ? null : Math.round(km * 1000),
    aabningstider: aabningstider(felt(p, "aabningstider", "åbningstider", "openinghours")),
  };
}

// resultat: { pakkeshops: [...], udgangspunkt, antal } -> nærmeste først.
export function pakkeshopsFraResultat(resultat: unknown): Pakkeshop[] {
  const liste = felt(resultat, "pakkeshops", "shops");
  const raa = Array.isArray(liste) ? liste : Array.isArray(resultat) ? resultat : [];
  const set = new Set<string>();
  return raa
    .slice(0, 100)
    .map(tilPakkeshop)
    .filter((p): p is Pakkeshop => {
      if (!p || set.has(p.id)) return false;
      set.add(p.id);
      return true;
    })
    .sort((a, b) => (a.afstandM ?? Infinity) - (b.afstandM ?? Infinity));
}

// ------------------------------------------------------------ sporing

export type DaoHaendelseResultat =
  | { slags: "kendt"; haendelse: Sporingshaendelse }
  | { slags: "ukendt"; ukendt: UkendtSporingskode }
  | { slags: "ugyldig" };

// Én DAO-hændelse -> normaliseret hændelse. Nøglen er stregkode + kode +
// DAO's tidspunkt (som tekst), så feedet og opslaget på stregkoden giver samme
// nøgle (idempotent i forsendelse_haendelser).
export function tolkHaendelse(
  stregkode: string,
  raa: unknown,
  listeHint: DaoListe | null = null,
): DaoHaendelseResultat {
  const kode = normaliserKode(felt(raa, "haendelse", "hændelse", "event", "kode"));
  const tidTekst = tekstFelt(raa, 40, "tidspunkt", "time", "timestamp");
  const tid = daoTidTilIso(tidTekst);
  if (kode === null || !tidTekst || !tid) return { slags: "ugyldig" };
  // For HOME-pakker står leveringsteksten i "sted", for andre i "beskrivelse".
  const beskrivelse = tekstFelt(raa, 300, "beskrivelse", "description");
  const sted = tekstFelt(raa, 200, "sted", "place");
  const shopid = tekstFelt(raa, 50, "shopid", "shopId");
  const pakketype = tekstFelt(raa, 30, "pakketype", "parceltype");
  const liste = listeFraPakketype(pakketype) ?? listeHint;
  const type = daoKodeTilType(kode, liste);
  if (!type) {
    return {
      slags: "ukendt",
      ukendt: { kode, liste, beskrivelse: (beskrivelse ?? sted)?.slice(0, 200) ?? null, sporingsnummer: stregkode },
    };
  }
  return {
    slags: "kendt",
    haendelse: {
      type,
      tidspunkt: tid,
      noegle: `dao:${stregkode}:${kode}:${tidTekst}`.slice(0, 200),
      beskrivelse: beskrivelse ?? sted,
      raa: { haendelse: kode, beskrivelse, sted, shopid, pakketype, tidspunkt: tidTekst },
    },
  };
}

// Track & Trace V2 med stregkode: resultat { stregkode, haendelser: [...] }.
export function sporingFraResultat(
  stregkode: string,
  resultat: unknown,
): { haendelser: Sporingshaendelse[]; ukendte: UkendtSporingskode[] } {
  const liste = listeFraPakketype(felt(resultat, "pakketype"));
  const raa = felt(resultat, "haendelser", "hændelser", "events");
  const ud = { haendelser: [] as Sporingshaendelse[], ukendte: [] as UkendtSporingskode[] };
  for (const h of Array.isArray(raa) ? raa.slice(0, 200) : []) {
    const r = tolkHaendelse(stregkode, h, liste);
    if (r.slags === "kendt") ud.haendelser.push(r.haendelse);
    else if (r.slags === "ukendt") ud.ukendte.push(r.ukendt);
  }
  return ud;
}

// Track & Trace V2 med token: { token: "<næste>", resultat: [{ stregkode,
// haendelser: [...] }] }. Tokenet kan også stå i resultat (tolerant). Kaster,
// hvis der ikke er et gyldigt nyt token - så gemmes intet, og næste kørsel
// prøver igen med det gamle.
export function feedFraSvar(rod: Record<string, unknown>, resultat: unknown): {
  nyToken: string;
  haendelser: WebhookHaendelse[];
  ukendte: UkendtSporingskode[];
  pakker: number;
} {
  const tok = felt(rod, "token") ?? felt(resultat, "token", "nexttoken");
  const nyToken = typeof tok === "number" ? String(tok) : typeof tok === "string" ? tok.trim() : "";
  if (!/^\d{1,20}$/.test(nyToken)) throw new Error("DAO Track & Trace: svaret har intet gyldigt token");
  const pakker = Array.isArray(resultat)
    ? resultat
    : (() => {
        const l = felt(resultat, "pakker", "resultat", "parcels");
        return Array.isArray(l) ? l : [];
      })();
  const ud = { nyToken, haendelser: [] as WebhookHaendelse[], ukendte: [] as UkendtSporingskode[], pakker: 0 };
  for (const p of pakker.slice(0, 5000)) {
    const stregkode = tekstFelt(p, 40, "stregkode", "barcode");
    if (!gyldigStregkode(stregkode)) continue;
    ud.pakker++;
    const liste = listeFraPakketype(felt(p, "pakketype"));
    const hs = felt(p, "haendelser", "hændelser", "events");
    for (const h of Array.isArray(hs) ? hs.slice(0, 200) : []) {
      const r = tolkHaendelse(stregkode, h, liste);
      if (r.slags === "kendt") ud.haendelser.push({ ...r.haendelse, sporingsnummer: stregkode, forsendelsesId: stregkode });
      else if (r.slags === "ukendt") ud.ukendte.push(r.ukendt);
    }
  }
  return ud;
}
