// Fælles login-tjek til server actions, route handlers og sider.
import type { SupabaseClient } from "@supabase/supabase-js";

// Den indloggede bruger, valideret hos Supabase (getUser, ikke getSession).
// Bruges i server actions og route handlers: proxyen springer offentlige
// stier over (fx /login), og en server action kan kaldes med POST til en
// hvilken som helst sti - derfor skal handlingen selv tjekke login.
// To-trins-login er fjernet (Filip, 7. oktober 2026), så et almindeligt
// login er nok.
export async function hentLoggetIndBruger(supabase: SupabaseClient) {
  return supabase.auth.getUser();
}
