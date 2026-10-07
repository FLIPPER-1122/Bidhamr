import "server-only";

import { createClient } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";

// Tjekker en brugers nuværende adgangskode uden at røre brugerens egne
// cookies: en midlertidig klient uden lager logger ind og ud igen med det
// samme (scope "local" lukker kun den midlertidige session).
// Bruges før skift af adgangskode og sletning af konto.
export async function bekraeftAdgangskode(
  email: string | null | undefined,
  adgangskode: string,
): Promise<"ok" | "forkert" | "for_mange" | "fejl"> {
  if (!email || typeof adgangskode !== "string" || adgangskode.length === 0) return "forkert";
  const klient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    offentligNoegle(),
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
  const { data, error } = await klient.auth.signInWithPassword({ email, password: adgangskode });
  if (error) {
    if (error.code === "invalid_credentials") return "forkert";
    if (error.status === 429) return "for_mange";
    console.error("bekraeftAdgangskode fejlede:", error.code, error.message);
    return "fejl";
  }
  if (data.session) await klient.auth.signOut({ scope: "local" });
  return "ok";
}
