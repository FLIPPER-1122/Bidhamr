import "server-only";

import { renCaptchaToken } from "@/lib/turnstile";

// Serverens eget tjek af et Turnstile-token - kun hvor Supabase Auth ikke selv
// tjekker det (oprettelse af konto: serveren bruger generateLink, som ikke
// har CAPTCHA). Se docs/SIKKERHED-AUTH.md.
//
// TURNSTILE_SECRET_KEY ikke sat: tjekket springes over (som før). Sat: et
// manglende eller ugyldigt token afvises. Cloudflare svarer ikke: afvises
// (fail closed - brugeren kan prøve igen).

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileServerAktiv(): boolean {
  return (process.env.TURNSTILE_SECRET_KEY ?? "").trim().length > 0;
}

export async function tjekTurnstile(token: unknown, ip: string | null): Promise<boolean> {
  const hemmelighed = (process.env.TURNSTILE_SECRET_KEY ?? "").trim();
  if (!hemmelighed) return true;
  const t = renCaptchaToken(token);
  if (!t) return false;
  const krop = new URLSearchParams({ secret: hemmelighed, response: t });
  if (ip && ip !== "ukendt") krop.set("remoteip", ip);
  try {
    const svar = await fetch(SITEVERIFY, {
      method: "POST",
      body: krop,
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!svar.ok) return false;
    const data = (await svar.json()) as { success?: unknown };
    return data.success === true;
  } catch (err) {
    console.error("Turnstile: tjekket fejlede:", err);
    return false;
  }
}
