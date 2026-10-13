// DAO's hændelseskoder (Track & Trace V2, feltet `haendelse`) -> BidHamrs
// normaliserede sporingstyper (types.ts). Ren tabel uden netværk og uden
// server-only, så den kan testes direkte (tests/fragt/daoKoder.test.ts).
//
// ============================================================================
// TODO(DAO): KODERNE ER IKKE KENDT ENDNU.
// ============================================================================
// DAO's dokumentation (https://api.dao.as/docs/v1/, version 132) trykker ikke
// kodelisten. Den hentes med GET /TrackNTraceKoder.php?kundeid&kode, når Filip
// har nøglerne, og giver to lister: `direkte` (daoHOME) og `pakkeshop`
// (daoSHOP). Samme kode kan betyde noget forskelligt i de to lister.
//
// Sådan udfyldes tabellen (se docs/DAO-API.md, "Hændelseskoder"):
//   1. Kald TrackNTraceKoder.php (kun læsning, gratis) og gem svaret som
//      fixture i src/lib/fragt/__fixtures__/dao/.
//   2. Send 2-3 rigtige pakker og én, der ikke hentes, og se, hvilke koder der
//      kommer i hvilken rækkefølge (fragt_ukendte_koder i databasen viser alle
//      koder, vi har set, men ikke kender).
//   3. Tilføj koderne herunder med `liste`, når de afhænger af listen.
//
// SIKKER STANDARD: en kode, der ikke står her, ændrer ALDRIG status. Den
// gemmes kun i fragt_ukendte_koder, og drift får en advarsel første gang.
// Vi gætter aldrig "leveret" eller "returneret" - de styrer beskeder til
// køberen, den automatiske frigivelse efter 14 dage og ikke-afhentet-flowet.
// ============================================================================
import type { SporingsType } from "@/lib/fragt/types";

export type DaoListe = "pakkeshop" | "direkte";

type Regel = {
  type: SporingsType;
  // Mangler = gælder for begge lister.
  liste?: DaoListe;
  // Hvor vi ved det fra (dokumentation, Allan hos DAO, rigtig pakke …).
  kilde: string;
};

// Kode -> regler. Første regel, der passer på listen, vinder.
export const DAO_KODER: Readonly<Record<string, readonly Regel[]>> = {
  // Eneste eksempler i dokumentationen. "i_transit" sætter også
  // afleveret_kl (pakken er hos DAO), men flytter ingen penge og sender kun
  // sælgeren "Pakken er indleveret", hvis han ikke har markeret den sendt.
  "10": [{ type: "i_transit", kilde: "Dokumentationens eksempel: \"Pakke modtaget på fordelingscenter\" / \"Pakke ankommet\" - bekræft listen" }],
  "11": [{ type: "i_transit", kilde: "Dokumentationens eksempel: \"Pakken har forladt DAO terminal\" - bekræft listen" }],
  // TODO(DAO): indleveret i pakkeshop        -> "afleveret"
  // TODO(DAO): klar til afhentning i shop    -> "klar_til_afhentning" (liste: "pakkeshop")
  // TODO(DAO): udleveret/leveret             -> "leveret" (begge lister - tjek hver for sig)
  // TODO(DAO): ikke afhentet, retur afsender -> "returneret" (se DAO_RETUR_ER_IKKE_AFHENTET)
  // TODO(DAO): skadet/fejl/adresse ukendt    -> "fejl"
};

// Ikke-afhentet-flowet (ROADMAP fase 2, src/lib/betaling/ikkeAfhentet.ts):
// true = DAO's "returneret" på en udgående pakke, der aldrig er leveret,
// betyder sikkert, at køberen ikke hentede pakken. Så annulleres handlen
// automatisk, og køberen refunderes minus gebyrer og fragt begge veje.
//
// SLÅET FRA, indtil returkoden er set på en RIGTIG pakke, der ikke blev hentet
// (docs/DAO-API.md, "Sådan kan vi teste", trin 4). Indtil da bliver en
// returneret DAO-pakke kun en markering til staff, som selv trykker "Ikke
// afhentet" i admin. Ændres kun her - med en test, der viser koden.
export const DAO_RETUR_ER_IKKE_AFHENTET = false;

// Normaliserer en kode fra DAO ("10", 10, " 010 ") til en nøgle i tabellen.
// null = ikke en kode (tom, tekst, for lang).
export function normaliserKode(kode: unknown): string | null {
  if (typeof kode !== "string" && typeof kode !== "number") return null;
  const t = String(kode).trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  return String(Number(t));
}

// DAO's pakketype ("Home", "Shop", "Direkte" …) -> listen. null = ukendt.
export function listeFraPakketype(v: unknown): DaoListe | null {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!t) return null;
  if (t.startsWith("home") || t.startsWith("direkte") || t === "dir") return "direkte";
  if (t.startsWith("shop") || t.startsWith("pakkeshop")) return "pakkeshop";
  return null;
}

// Kode (+ liste, hvis kendt) -> sporingstype. null = ukendt: ingen hændelse,
// ingen statusændring. Med ukendt liste bruges kun regler uden liste.
export function daoKodeTilType(kode: unknown, liste: DaoListe | null): SporingsType | null {
  const k = normaliserKode(kode);
  if (k === null) return null;
  const regler = DAO_KODER[k];
  if (!regler) return null;
  for (const r of regler) {
    if (!r.liste || r.liste === liste) return r.type;
  }
  return null;
}
