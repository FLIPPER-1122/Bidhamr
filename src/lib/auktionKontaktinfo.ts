// Kontaktoplysninger i en auktions titel og beskrivelse (Filip, 27. okt. 2026).
//
// Telefonnumre, e-mails, links og MobilePay-/bankoplysninger må ikke stå i
// auktionen - køber og sælger skal tale sammen via BidHamr.
//   - Private: alt, som chattens spamfilter stopper (spamGrund), blokeres.
//   - Firmaer (users.konto_type = 'erhverv'): links må gerne stå (fx til
//     firmaets egen hjemmeside). Telefon, e-mail, MobilePay, bank og sociale
//     medier blokeres stadig - kontaktoplysningerne står på firmasiden.
//
// SPEJL af public.auktion_kontaktinfo_grund i
// supabase/migrations/20261102130000_beskrivelse_kontaktinfo.sql. Databasen
// afgør altid (triggeren auctions_zzz_kontaktinfo, fejlkode BHA08); denne
// kopi viser fejlen ved feltet, mens brugeren skriver. Ændres en regel, SKAL
// begge steder rettes (eksemplerne står begge steder:
// tests/enhed/auktionKontaktinfo.test.ts og testblokken i migrationen).
//
// Ingen server-only-import: klientkomponenterne bruger den.

import { spamGrund, type SpamGrund } from "@/lib/tryghed";

export const AUKTION_KONTAKTINFO_KODE = "BHA08";

export type AuktionKontaktFelt = "titel" | "beskrivelse";

// Links, som firmaer må skrive. Fjernes fra teksten, før resten tjekkes. Samme
// mønster som i SQL (Postgres' \M = ordslut).
const TLD = "(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co)";
const STI = "(/[a-z0-9/_.?=&%#+~-]*)?";
const FIRMA_LINK = new RegExp(
  `(https?://|www\\.)[a-z0-9.-]+${STI}|([a-z0-9-]+\\.)+${TLD}(?![\\p{L}\\p{N}_])${STI}`,
  "gu",
);

function normaliser(tekst: string): string {
  return tekst
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[­​-‏⁠-⁤﻿]/g, "");
}

// Grunden (som spamGrund) eller null, hvis teksten må stå i auktionen.
export function auktionKontaktGrund(
  tekst: string | null | undefined,
  erhverv: boolean,
): Exclude<SpamGrund, "gentaget"> | null {
  const t = tekst ?? "";
  if (!t.trim()) return null;
  const grund = spamGrund(t);
  if (grund !== "link" || !erhverv) return grund;
  // Firma: fjern links, og tjek resten (e-mail er allerede tjekket først).
  return spamGrund(normaliser(t).replace(FIRMA_LINK, " "));
}

export function auktionKontaktTekst(felt: AuktionKontaktFelt, erhverv: boolean): string {
  const sted = felt === "titel" ? "titlen" : "beskrivelsen";
  return erhverv
    ? `Skriv ikke telefonnummer, e-mail eller betalingsoplysninger i ${sted}. Jeres kontaktoplysninger står på firmasiden.`
    : `Skriv ikke telefonnummer, e-mail eller links i ${sted}. Køber og sælger skal tale sammen via BidHamr.`;
}

// Fejl fra databasen (BHA08). details er JSON: { felt, grund, erhverv }.
export function auktionKontaktFejl(
  fejl: { code?: string | null; details?: string | null } | null | undefined,
): { felt: AuktionKontaktFelt; tekst: string } | null {
  if (fejl?.code !== AUKTION_KONTAKTINFO_KODE) return null;
  let felt: AuktionKontaktFelt = "beskrivelse";
  let erhverv = false;
  try {
    const d = JSON.parse(fejl.details ?? "{}") as { felt?: string; erhverv?: boolean };
    if (d.felt === "titel") felt = "titel";
    erhverv = d.erhverv === true;
  } catch {
    // standardteksten
  }
  return { felt, tekst: auktionKontaktTekst(felt, erhverv) };
}
