import { erTestdatabase } from "@/lib/miljoe";

// Er siden "før lancering", dvs. lukket bag gaten i
// src/lib/supabase/middleware.ts (kun staff, sælgeren på Admin → Erhverv og
// firmakonti på Firma oversigt kommer ind)?
//
// Det er samme regel, som gaten altid har brugt: lukket overalt undtagen på
// testdatabasen (erTestdatabase, fail closed). Testdatabasen kører i
// "efter lancering"-tilstand, så almindelige testbrugere kan bruge siden.
//
// SIMULER_FOER_LANCERING=true i .env.local lukker siden lokalt, så gaten kan
// testes mod testdatabasen. Variablen virker KUN på testdatabasen - i
// produktion er siden altid lukket, uanset hvad den står til.
export function foerLancering(): boolean {
  if (!erTestdatabase()) return true;
  return process.env.SIMULER_FOER_LANCERING === "true";
}
