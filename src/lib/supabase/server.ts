import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { erAdminVaert, supabaseCookieOptions } from "@/lib/adminVaert";

// Er forespørgslen på admin-hosten (ADMIN_VAERT)? Afgør cookienavnet: admin
// har sin egen, host-only session (src/lib/adminVaert.ts). Uden ADMIN_VAERT
// altid false, så hovedsitet er uændret.
export async function paaAdminVaert(): Promise<boolean> {
  return erAdminVaert((await headers()).get("host"));
}

export async function createClient() {
  const cookieStore = await cookies();
  const cookieOptions = supabaseCookieOptions(await paaAdminVaert());

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    offentligNoegle(),
    {
      ...(cookieOptions ? { cookieOptions } : {}),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll kaldt fra en Server Component - kan ignoreres når middleware opdaterer sessionen
          }
        },
      },
    },
  );
}
