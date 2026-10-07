import "server-only";

// Hemmelige Supabase-nøgler - KUN server-kode. Byggeriet fejler, hvis en
// client component importerer denne fil. Se noegler.ts for overgangen til
// Supabases nye nøgler.

// Hemmelig nøgle (secret/service_role). Omgår RLS. KUN server-kode.
// Supabase afviser selv en sb_secret_-nøgle med 401, hvis forespørgslen ligner
// en browser (User-Agent) - men den må slet ikke komme derud.
export function hemmeligNoegle(): string {
  if (typeof window !== "undefined") {
    throw new Error("Den hemmelige Supabase-nøgle må aldrig bruges i browseren.");
  }
  const noegle = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!noegle) {
    throw new Error("SUPABASE_SECRET_KEY (eller SUPABASE_SERVICE_ROLE_KEY) mangler i miljøvariablerne.");
  }
  return noegle;
}

// KUN til den gamle afledning af HMAC-nøgler (rolle-cookien og DSA-links),
// når ROLLE_COOKIE_HEMMELIGHED / DSA_LINK_HEMMELIGHED ikke er sat. Bruger
// den gamle service_role-nøgle først, så værdien er den samme som før
// overgangen (gamle cookies og links virker videre), og først derefter den nye
// secret key. null, hvis ingen findes.
export function afledningsNoegle(): string | null {
  if (typeof window !== "undefined") return null;
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || null;
}
