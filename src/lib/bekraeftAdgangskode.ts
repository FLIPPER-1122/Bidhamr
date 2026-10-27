import "server-only";

import { createClient } from "@supabase/supabase-js";
import { hemmeligNoegle } from "@/lib/supabase/noeglerServer";

// Tjekker en brugers nuværende adgangskode uden at røre brugerens egne
// cookies: en midlertidig klient uden lager logger ind og ud igen med det
// samme (scope "local" lukker kun den midlertidige session).
// Bruges før skift af adgangskode og sletning af konto.
export async function bekraeftAdgangskode(
  email: string | null | undefined,
  adgangskode: string,
): Promise<"ok" | "forkert" | "for_mange" | "fejl"> {
  if (!email || typeof adgangskode !== "string" || adgangskode.length === 0) return "forkert";
  // Den hemmelige nøgle: Supabase Auth springer CAPTCHA over for service
  // role, så tjekket virker også, når CAPTCHA er slået til (docs/SIKKERHED-
  // AUTH.md). Brugeren er allerede logget ind, og kalderne har egne lofter
  // (adgangskode_bruger m.fl.). Sessionen er en almindelig brugersession og
  // logges ud med det samme.
  const klient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    hemmeligNoegle(),
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
