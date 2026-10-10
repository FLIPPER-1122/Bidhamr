import { erTestdatabase } from "@/lib/miljoe";

// Er siden "før lancering", dvs. lukket bag gaten i
// src/lib/supabase/middleware.ts (kun staff, sælgeren på Admin → Erhverv og
// firmakonti på Firma oversigt kommer ind, og besøgende uden login ser
// /coming-soon)?
//
// Testdatabasen kører altid i "efter lancering"-tilstand, så almindelige
// testbrugere (og besøgende uden login) kan bruge siden lokalt.
// SIMULER_FOER_LANCERING=true i .env.local lukker siden lokalt, så gaten kan
// testes mod testdatabasen. Den virker KUN på testdatabasen.
//
// LANCERINGSKONTAKTEN: I produktion er siden lukket, indtil Filip sætter
// LANCERET=1 i Vercel (Production) og deployer igen. Variablen er bevidst
// ikke NEXT_PUBLIC_ - den læses kun på serveren (proxyen og server-
// komponenter) og kan ikke ses eller ændres fra browseren. Fail closed: alt
// andet end præcis "1" eller "true" (tom, "0", "ja", stavefejl) holder siden
// lukket. Se HUSKELISTE.md under "Lancering".
export function foerLancering(): boolean {
  if (erTestdatabase()) return process.env.SIMULER_FOER_LANCERING === "true";
  return !lanceringskontaktSlaaetTil();
}

function lanceringskontaktSlaaetTil(): boolean {
  const v = process.env.LANCERET?.trim();
  return v === "1" || v === "true";
}
