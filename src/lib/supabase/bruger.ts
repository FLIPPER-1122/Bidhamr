import "server-only";

// Den indloggede bruger og rollen - hentet højst ÉN gang pr. forespørgsel.
//
// Topbaren (src/components/Header.tsx), layouts, sider og getStaffRole /
// kraevSideRolle (src/lib/adminAuth.ts) spørger alle om det samme. Med
// cache() deles svaret i hele renderingen af én forespørgsel, så der ikke går
// et kald pr. komponent til Supabase (fx gav /admin før 12 kald til min_rolle).
// cache() gælder kun inden for samme forespørgsel - aldrig på tværs af brugere.
// I server actions og route handlers er cache() uden virkning (hvert kald går
// til Supabase), så sikkerheden er den samme dér.
import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// Valideret hos Supabase Auth (getUser - ikke getSession/getClaims), fordi
// sider og actions bruger id'et til opslag med service-role.
export const hentBruger = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
});

// Rollen fra min_rolle() (udleder brugeren af auth.uid() i JWT'en). null, hvis
// ikke logget ind eller kaldet fejler.
export const hentMinRolle = cache(async (): Promise<string | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("min_rolle");
  if (error) return null;
  return typeof data === "string" ? data : null;
});

// Bruger-id'et fra sessionens JWT, tjekket lokalt med projektets offentlige
// nøgle (JWKS, asymmetrisk ES256) - intet netværkskald. Bruges KUN til at
// starte brugerens opslag SAMTIDIG med hentBruger() i stedet for bagefter.
// Giver aldrig adgang alene: siden skal vente på hentBruger() og kræve, at
// id'et er det samme (se samme fil, bekraeftetBruger), før noget vises.
// null, hvis der ingen gyldig session er.
export const sessionBrugerId = cache(async (): Promise<string | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  return typeof sub === "string" ? sub : null;
});

// Den bekræftede bruger, men kun hvis den er den samme som i JWT'en, som
// opslagene blev startet med. Ellers null (behandles som ikke logget ind).
export async function bekraeftetBruger(sessionId: string | null): Promise<User | null> {
  const bruger = await hentBruger();
  if (!bruger || !sessionId || bruger.id !== sessionId) return null;
  return bruger;
}
