import { createBrowserClient } from "@supabase/ssr";
import { offentligNoegle } from "@/lib/supabase/noegler";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    offentligNoegle(),
  );
}
