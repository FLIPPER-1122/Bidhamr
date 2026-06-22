import { createClient } from "@supabase/supabase-js";

// Bruger service-role-nøglen og omgår derfor RLS. Må KUN importeres i
// server-only kode uden bruger-session (fx webhooks) – aldrig i klient-kode.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
