// To-trins-login (Supabase MFA, TOTP). Delt af proxyen, server actions og sider.
import type { SupabaseClient, User } from "@supabase/supabase-js";

// Siden, hvor man indtaster koden fra sin app efter adgangskoden.
export const TO_TRIN_STI = "/login/to-trin";

export function harToTrin(user: Pick<User, "factors"> | null | undefined): boolean {
  return !!user?.factors?.some((f) => f.status === "verified");
}

// true, når brugeren har slået to-trins-login til, men den aktuelle session
// kun har adgangskoden (aal1). Brugeren skal så indtaste koden, før noget
// andet virker. `user` skal komme fra getUser() (valideret af Supabase).
export async function manglerToTrin(
  supabase: SupabaseClient,
  user: Pick<User, "factors"> | null | undefined,
  // Access token (Bearer) ved kald fra appen uden cookie-session.
  jwt?: string,
): Promise<boolean> {
  if (!harToTrin(user)) return false;
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel(jwt);
  if (error || !data) return true; // fail closed
  return data.currentLevel !== "aal2";
}

// Som supabase.auth.getUser(), men en session, der mangler to-trins-koden
// (aal1 for en bruger med to-trins-login), behandles som "ikke logget ind".
// Bruges i server actions og route handlers: proxyen springer offentlige
// stier over (fx /login), og en server action kan kaldes med POST til en
// hvilken som helst sti - derfor skal handlingen selv tjekke det. Databasen
// håndhæver det kun, når 20261007032000_mfa_database_haandhaevelse er kørt.
export async function getUserMedToTrin(supabase: SupabaseClient) {
  const res = await supabase.auth.getUser();
  const user = res.data.user;
  if (user && (await manglerToTrin(supabase, user))) {
    return { data: { user: null }, error: null } as const;
  }
  return res;
}
