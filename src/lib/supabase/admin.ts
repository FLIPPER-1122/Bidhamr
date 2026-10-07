import "server-only";

import { createClient } from "@supabase/supabase-js";
import { hemmeligNoegle } from "@/lib/supabase/noegler";

// Bruger den hemmelige nøgle (sb_secret_… eller den gamle service_role, se
// src/lib/supabase/noegler.ts) og omgår derfor RLS. Må KUN importeres i
// server-only kode uden bruger-session (fx webhooks) – aldrig i klient-kode.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    hemmeligNoegle(),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
