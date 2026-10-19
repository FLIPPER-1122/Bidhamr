import { createBrowserClient } from "@supabase/ssr";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { erAdminVaertKlient, supabaseCookieOptions } from "@/lib/adminVaert";

// På admin-hosten bruger browser-klienten admin-sessionens cookie
// (src/lib/adminVaert.ts) - ellers Supabases standard som før.
export function createClient() {
  const cookieOptions = supabaseCookieOptions(erAdminVaertKlient());
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    offentligNoegle(),
    cookieOptions ? { cookieOptions } : undefined,
  );
}
