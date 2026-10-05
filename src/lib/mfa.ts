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
): Promise<boolean> {
  if (!harToTrin(user)) return false;
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return true; // fail closed
  return data.currentLevel !== "aal2";
}
