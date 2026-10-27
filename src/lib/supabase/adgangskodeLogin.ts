import "server-only";

import { createClient as lavKlient, type AuthError, type Session, type User } from "@supabase/supabase-js";
import type { createClient } from "@/lib/supabase/server";
import { hemmeligNoegle } from "@/lib/supabase/noeglerServer";

// Adgangskode-login fra serveren UDEN CAPTCHA - kun til staff-login på
// admin-hosten (src/lib/adgang.ts). Supabase Auth springer CAPTCHA over, når
// kaldet bærer den hemmelige nøgle (service role); sessionen er en almindelig
// brugersession, som derefter lægges i brugerens cookies med setSession.
// Admin-login har egne lofter (admin_login_ip, admin_login_email_ip) og kræver
// to-trins-login bagefter. Se docs/SIKKERHED-AUTH.md.
//
// Brug ALDRIG dette til almindelige brugeres login - de skal igennem
// CAPTCHA (logInd i src/app/actions/auth.ts sender captchaToken).

type SsrKlient = Awaited<ReturnType<typeof createClient>>;

export async function logIndUdenCaptcha(
  supabase: SsrKlient,
  email: string,
  password: string,
): Promise<{ data: { user: User | null; session: Session | null }; error: AuthError | null }> {
  const tmp = lavKlient(process.env.NEXT_PUBLIC_SUPABASE_URL!, hemmeligNoegle(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await tmp.auth.signInWithPassword({ email, password });
  if (error || !data.session) return { data: { user: null, session: null }, error };
  const sat = await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  if (sat.error || !sat.data.session) return { data: { user: null, session: null }, error: sat.error };
  return { data: { user: sat.data.user ?? data.user, session: sat.data.session }, error: null };
}
