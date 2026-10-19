import { createBrowserClient } from "@supabase/ssr";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { erAdminVaertKlient, supabaseCookieOptions } from "@/lib/adminVaert";

// På admin-hosten bruger browser-klienten admin-sessionens cookie
// (src/lib/adminVaert.ts) - ellers Supabases standard som før. Serveren
// afgør det og skriver <meta name="bh-admin-cookie"> i root-layoutet, så
// browser og server altid vælger samme cookie.
export function createClient() {
  const cookieOptions = supabaseCookieOptions(erAdminVaertKlient());
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    offentligNoegle(),
    cookieOptions ? { cookieOptions } : undefined,
  );
}
