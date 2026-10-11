import "server-only";

import { createClient } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";

// Supabase-klient med den offentlige nøgle UDEN cookies, til server-kode, der
// ikke har (eller ikke må bruge) brugerens browser-session: appens
// endpoints (/api/konto/*) og "send ny kode" (auth.resend). Sessionen fra fx
// verifyOtp lever kun i hukommelsen, så længe klienten findes.
export function createAnonClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
