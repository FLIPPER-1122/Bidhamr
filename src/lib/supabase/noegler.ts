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

// Den hemmelige nøgle og afledningsnøglen ligger i noeglerServer.ts
// (import "server-only"), så de aldrig kan importeres i browser-kode.
