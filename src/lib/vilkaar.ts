// Version af brugerbetingelserne, som brugeren accepterer ved oprettelse.
// SKAL holdes synkron med public.vilkaar_aktuel_version() i databasen
// (supabase/migrations/20261009050000_vilkaar_accept.sql) - ellers gemmes
// accepten ikke (handle_new_user og accepter_vilkaar godtager kun den
// aktuelle version). Ved en ny version: ret begge steder og VILKAAR_DATO.
//
// Expo-appen: send vilkaar_version i signup-metadata
// (supabase.auth.signUp({ options: { data: { ..., vilkaar_version } } })) og
// vis et påkrævet flueben. Uden den gemmes NULL, og brugeren ser bjælken på
// /konto (eller appens tilsvarende), indtil de accepterer via
// rpc("accepter_vilkaar", { p_version }).
export const VILKAAR_VERSION = "0.1";
export const VILKAAR_DATO = "6. oktober 2026";

// Udkastet er endnu ikke godkendt af advokat (ROADMAP fase 6). Når det er
// godkendt, sættes den til false, og banneret "UDKAST" forsvinder.
export const VILKAAR_ER_UDKAST = true;

export const BETINGELSER_STI = "/betingelser";
export const PRIVATLIV_STI = "/privatliv";

// true, hvis den accepterede version er mindst den aktuelle ("0.1" < "0.2" < "1.0").
// NULL eller en ukendt værdi = ikke accepteret.
export function vilkaarErAccepteret(version: string | null | undefined): boolean {
  if (!version || !/^\d{1,3}\.\d{1,3}$/.test(version)) return false;
  const [a1, a2] = version.split(".").map(Number);
  const [b1, b2] = VILKAAR_VERSION.split(".").map(Number);
  return a1 > b1 || (a1 === b1 && a2 >= b2);
}
