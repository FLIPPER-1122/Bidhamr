// Det ENESTE sted i hjemmesiden, der læser Supabases API-nøgler fra miljøet.
// Alle andre filer henter nøglerne herfra.
//
// Overgang til Supabases nye nøgler (okt. 2026), uden nedetid:
// - Offentlig nøgle: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (sb_publishable_…),
//   ellers den gamle NEXT_PUBLIC_SUPABASE_ANON_KEY (JWT).
// - Hemmelig nøgle: SUPABASE_SECRET_KEY (sb_secret_…), ellers den gamle
//   SUPABASE_SERVICE_ROLE_KEY (JWT).
// Begge slags virker samtidig hos Supabase, så de nye kan sættes i Vercel,
// og de gamle kan slås fra senere (Settings → API Keys), når intet bruger dem.
//
// NEXT_PUBLIC_-variablerne skal stå bogstaveligt (process.env.NEXT_PUBLIC_…),
// ellers bygger Next.js dem ikke ind i browser-koden.

// Offentlig nøgle (publishable/anon). Må gerne bruges i browseren - RLS
// gælder som for anon.
export function offentligNoegle(): string {
  const noegle =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!noegle) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (eller NEXT_PUBLIC_SUPABASE_ANON_KEY) mangler i miljøvariablerne.",
    );
  }
  return noegle;
}

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
