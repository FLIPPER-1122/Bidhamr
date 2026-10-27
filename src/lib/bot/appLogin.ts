import "server-only";

import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appBruger, bearerToken } from "@/lib/appApi";

// Appens login til BidHamr-bot: Bearer-tokenet er VALGFRIT (botten virker
// også uden login efter lancering). Er der en Authorization-header, skal den
// være et gyldigt token - ellers "ikke logget ind" (401), så appen ikke
// tavst falder tilbage til en anonym samtale.
export type AppBotLogin =
  | { ok: true; supabase: SupabaseClient | null; brugerId: string | null }
  | { ok: false };

export async function appBotLogin(req: NextRequest): Promise<AppBotLogin> {
  const harHeader = (req.headers.get("authorization") ?? "").trim() !== "";
  if (!harHeader) return { ok: true, supabase: null, brugerId: null };
  const token = bearerToken(req);
  if (!token) return { ok: false };
  const login = await appBruger(token);
  if (!login) return { ok: false };
  return { ok: true, supabase: login.supabase, brugerId: login.bruger.id };
}
