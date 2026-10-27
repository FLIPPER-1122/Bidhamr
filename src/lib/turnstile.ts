// Cloudflare Turnstile (CAPTCHA) foran Supabase Auth - se docs/SIKKERHED-AUTH.md.
//
// Slået til, når NEXT_PUBLIC_TURNSTILE_SITE_KEY er sat. Er den ikke sat, vises
// intet felt, og der sendes intet captchaToken (alt er som før).
//
// Tokenet sendes med til Supabase Auth (signInWithPassword og
// resetPasswordForEmail: options.captchaToken), som selv tjekker det hos
// Cloudflare, når "CAPTCHA protection" er slået til i Supabase. Oprettelse af
// konto går ikke gennem Supabase Auth's signup (serveren bruger
// generateLink), så dér tjekker serveren selv tokenet med
// TURNSTILE_SECRET_KEY (src/lib/turnstileServer.ts). Et token kan kun bruges
// én gang - efter et forsøg skal feltet nulstilles.
//
// NEXT_PUBLIC_-variablen skal stå bogstaveligt, så Next.js bygger den ind.

export const TURNSTILE_SITE_KEY: string = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "").trim();

export function turnstileAktiv(): boolean {
  return TURNSTILE_SITE_KEY.length > 0;
}

// Cloudflare: tokens er højst 2048 tegn.
export function renCaptchaToken(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= 2048 ? t : undefined;
}

// Supabase svarer med koden captcha_failed (eller en tekst om captcha), når
// tokenet mangler, er brugt eller ugyldigt.
export function erCaptchaFejl(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "captcha_failed" || /captcha/i.test(err.message ?? "");
}

export const CAPTCHA_FEJL = "Vi kunne ikke bekræfte, at du ikke er en robot. Vent på tjekket over knappen, og prøv igen.";
export const CAPTCHA_MANGLER = "Vent et øjeblik, mens vi tjekker, at du ikke er en robot – prøv så igen.";
