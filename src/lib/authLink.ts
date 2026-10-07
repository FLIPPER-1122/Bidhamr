import type { EmailOtpType } from "@supabase/supabase-js";

// Typer af engangslinks (token_hash), som mellemsiden /bekraeft og
// POST /auth/callback accepterer. Se src/app/auth/callback/route.ts.
export const LINK_TYPER = ["recovery", "invite", "magiclink", "signup", "email", "email_change"] as const;

export function erLinkType(v: unknown): v is EmailOtpType {
  return typeof v === "string" && (LINK_TYPER as readonly string[]).includes(v);
}
