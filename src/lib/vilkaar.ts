// Version af brugerbetingelserne, som brugeren accepterer ved oprettelse.
// SKAL holdes synkron med public.vilkaar_aktuel_version() i databasen
// (supabase/migrations/20261009050000_vilkaar_accept.sql, senest ændret i
// 20261023010000_kunst_forbudt.sql: 0.1 -> 0.2) - ellers gemmes
// accepten ikke (handle_new_user og accepter_vilkaar godtager kun den
// aktuelle version). Ved en ny version: ret begge steder og VILKAAR_DATO.
//
// Expo-appen: send vilkaar_version i signup-metadata
// (supabase.auth.signUp({ options: { data: { ..., vilkaar_version } } })) og
// vis et påkrævet flueben. Uden den gemmes NULL, og brugeren får det
// blokerende vindue (src/components/vilkaar/VilkaarDialog.tsx - eller appens
// tilsvarende), indtil de accepterer via rpc("accepter_vilkaar", { p_version }).
// En ny version kræver ny accept: alle får vinduet igen ("Vi har opdateret
// brugerbetingelserne").
// 0.2 (15. okt. 2026): kunst er en forbudt vare. Alle accepterer igen.
export const VILKAAR_VERSION = "0.2";
export const VILKAAR_DATO = "15. oktober 2026";

// Udkastet er endnu ikke godkendt af advokat (ROADMAP fase 6). Når det er
// godkendt, sættes den til false, og banneret "UDKAST" forsvinder.
export const VILKAAR_ER_UDKAST = true;

export const BETINGELSER_STI = "/betingelser";
export const PRIVATLIV_STI = "/privatliv";

// Databasens fejl, når accepten mangler (vilkaar_kraev,
// 20261017030000_vilkaar_efternavn_chat.sql): bud, maksimum, nye auktioner
// og "tilbud til næste byder". Bruges både på serveren og i klientkomponenter.
export const VILKAAR_FEJLKODE = "BHV02";

export function erVilkaarFejl(code: string | null | undefined, message?: string | null): boolean {
  return code === VILKAAR_FEJLKODE || (message ?? "").includes("vilkaar_mangler");
}

// true, hvis den accepterede version er mindst den aktuelle ("0.1" < "0.2" < "1.0").
// NULL eller en ukendt værdi = ikke accepteret. SKAL give samme svar som
// public.vilkaar_er_accepteret i databasen.
export function vilkaarErAccepteret(version: string | null | undefined): boolean {
  if (!version || !/^\d{1,3}\.\d{1,3}$/.test(version)) return false;
  const [a1, a2] = version.split(".").map(Number);
  const [b1, b2] = VILKAAR_VERSION.split(".").map(Number);
  return a1 > b1 || (a1 === b1 && a2 >= b2);
}
