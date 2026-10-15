import { createHash } from "node:crypto";

// Den månedlige konkurrence - de rene regler (samme som databasen,
// supabase/migrations/20261023020000_badge_konkurrence.sql). Kun til server
// og tests (node:crypto).
//
// Seedet laves af databasen i samme transaktion som trækningen
// (konkurrence_nyt_seed: 32 kryptografisk tilfældige bytes) og gemmes på
// trækningen. Lodtrækningen kan efterregnes af enhver ud fra den fastfrosne
// liste og det gemte seed:
//   liste_hash = SHA-256("YYYY-MM" + for hver deltager sorteret efter
//                bruger-id: "\n<bruger_id>:<antal_lod>")
//   vinderlod  = (SHA-256(seed || liste_hash) som 256-bit heltal) mod N + 1
// Deltagerne har lod-intervaller i samme rækkefølge (første deltager 1..a,
// næste a+1..a+b osv.). Hvert lod har samme chance.

export const POPULAER_SAELGER_GRAENSE = 50;

export const GRUNDE_NY_VINDER = ["svarer_ikke", "opfylder_ikke"] as const;
export type GrundNyVinder = (typeof GRUNDE_NY_VINDER)[number];

const MAANED = /^(\d{4})-(0[1-9]|1[0-2])$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function erMaaned(v: unknown): v is string {
  return typeof v === "string" && MAANED.test(v);
}

// Måneden i dansk tid ('YYYY-MM').
export function denneMaaned(nu = new Date()): string {
  return nu.toLocaleDateString("en-CA", { timeZone: "Europe/Copenhagen" }).slice(0, 7);
}

export function forrigeMaaned(maaned: string): string {
  const [aar, md] = maaned.split("-").map(Number);
  return md === 1 ? `${aar - 1}-12` : `${aar}-${String(md - 1).padStart(2, "0")}`;
}

export type LodRaekke = { bruger_id: string; antal_lod: number };

export function listeHash(maaned: string, liste: LodRaekke[]): string {
  const sorteret = [...liste].sort((a, b) => (a.bruger_id < b.bruger_id ? -1 : a.bruger_id > b.bruger_id ? 1 : 0));
  const tekst = maaned + sorteret.map((r) => `\n${r.bruger_id.toLowerCase()}:${r.antal_lod}`).join("");
  return createHash("sha256").update(tekst, "utf8").digest("hex");
}

export function lodNr(seed: string, hash: string, antalLod: number): number {
  if (!HEX64.test(seed) || !HEX64.test(hash) || !Number.isInteger(antalLod) || antalLod < 1) {
    throw new Error("Ugyldigt seed, hash eller antal lod");
  }
  const h = createHash("sha256").update(Buffer.concat([Buffer.from(seed, "hex"), Buffer.from(hash, "hex")])).digest("hex");
  return Number(BigInt(`0x${h}`) % BigInt(antalLod)) + 1;
}

// Hvem har vinderloddet? Intervaller tildeles i bruger-id-rækkefølge.
export function vinderAf(liste: LodRaekke[], lod: number): string | null {
  const sorteret = [...liste].sort((a, b) => (a.bruger_id < b.bruger_id ? -1 : a.bruger_id > b.bruger_id ? 1 : 0));
  let til = 0;
  for (const r of sorteret) {
    til += r.antal_lod;
    if (lod <= til) return r.bruger_id;
  }
  return null;
}

// CSV (semikolon + BOM, så Excel på dansk åbner den rigtigt). Kun de
// nødvendige felter. Felter, der starter med = + - @, får et ' foran
// (CSV-injection i regneark).
export type CsvRaekke = {
  bruger_id: string;
  navn: string | null;
  antal_lod: number;
  foerste_lod: number | null;
  sidste_lod: number | null;
};

function felt(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  const sikker = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n\r]/.test(sikker) ? `"${sikker.replace(/"/g, '""')}"` : sikker;
}

export function konkurrenceCsv(maaned: string, raekker: CsvRaekke[], fastfrosset: boolean): string {
  const hoved = fastfrosset
    ? ["Måned", "Bruger-id", "Navn", "Antal lod", "Første lod", "Sidste lod"]
    : ["Måned", "Bruger-id", "Navn", "Antal lod"];
  const linjer = raekker.map((r) =>
    fastfrosset
      ? [maaned, r.bruger_id, r.navn ?? "", r.antal_lod, r.foerste_lod, r.sidste_lod]
      : [maaned, r.bruger_id, r.navn ?? "", r.antal_lod],
  );
  return "﻿" + [hoved, ...linjer].map((l) => l.map(felt).join(";")).join("\r\n") + "\r\n";
}
