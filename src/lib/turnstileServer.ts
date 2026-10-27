import "server-only";

import { renCaptchaToken } from "@/lib/turnstile";
import { logDriftFejl } from "@/lib/drift";

// Serverens eget tjek af et Turnstile-token - kun hvor Supabase Auth ikke selv
// tjekker det (oprettelse af konto: serveren bruger generateLink, som ikke
// har CAPTCHA). Se docs/SIKKERHED-AUTH.md.
//
// Nøglerne:
//   ingen sat:                  tjekket springes over (som før).
//   begge sat:                  manglende/ugyldigt token afvises.
//   kun NEXT_PUBLIC_TURNSTILE_SITE_KEY: feltet vises, men serveren kan ikke
//                               tjekke - afvises (fail closed) + drift-advarsel.
//   kun TURNSTILE_SECRET_KEY:   intet felt, så intet token - afvises som
//                               "manglende token" + drift-advarsel.
// Cloudflare svarer ikke: afvises (fail closed - brugeren kan prøve igen).
//
// Et godkendt token skal desuden komme fra en af vores værter (hostname i
// Cloudflares svar) og - når kalderen angiver det - fra den rigtige formular
// (action, fx "opret"). Ellers kunne et token løst på en fremmed side, der
// bruger samme site-nøgle, eller på en anden formular, genbruges her.

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Faste værter (samme som widgetens domæner i Cloudflare). Flere kan
// tilføjes med TURNSTILE_VAERTER (kommasepareret), fx appens værter.
const FASTE_VAERTER = ["bidhamr.dk", "www.bidhamr.dk", "test.bidhamr.dk"];

// Cloudflares testnøgler (docs/SIKKERHED-AUTH.md) svarer med faste værdier
// (fx værten example.com) - vært og action tjekkes kun med rigtige nøgler.
const TESTHEMMELIGHED = /^[123]x0{31}AA$/;

function siteNoegle(): string {
  return (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "").trim();
}

function hemmelighed(): string {
  return (process.env.TURNSTILE_SECRET_KEY ?? "").trim();
}

export function turnstileServerAktiv(): boolean {
  return hemmelighed().length > 0;
}

export function tilladteTurnstileVaerter(): Set<string> {
  const v = new Set(FASTE_VAERTER);
  try {
    const site = process.env.NEXT_PUBLIC_SITE_URL;
    if (site) v.add(new URL(site).hostname.toLowerCase());
  } catch {
    // Ugyldig NEXT_PUBLIC_SITE_URL - de faste værter gælder stadig.
  }
  for (const ekstra of (process.env.TURNSTILE_VAERTER ?? "").split(",")) {
    const h = ekstra.trim().toLowerCase();
    if (h) v.add(h);
  }
  if (process.env.NODE_ENV !== "production") {
    v.add("localhost");
    v.add("127.0.0.1");
  }
  return v;
}

let advaretOm: string | null = null;

async function driftAdvarsel(besked: string): Promise<void> {
  console.error(`Turnstile: ${besked}`);
  // Én gang pr. proces og slags (logDriftFejl samler desuden dubletter).
  if (advaretOm === besked) return;
  advaretOm = besked;
  await logDriftFejl({ kilde: "server", sti: "turnstile", hvor: "Turnstile-opsætning", fejl: besked });
}

export async function tjekTurnstile(token: unknown, ip: string | null, handling?: string): Promise<boolean> {
  const site = siteNoegle();
  const secret = hemmelighed();
  if (!secret) {
    if (!site) return true;
    await driftAdvarsel(
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY er sat, men TURNSTILE_SECRET_KEY mangler - oprettelse af konto afvises, til begge nøgler er sat.",
    );
    return false;
  }
  if (!site) {
    await driftAdvarsel(
      "TURNSTILE_SECRET_KEY er sat, men NEXT_PUBLIC_TURNSTILE_SITE_KEY mangler - hjemmesiden viser intet CAPTCHA-felt, så oprettelse af konto afvises.",
    );
  }

  const t = renCaptchaToken(token);
  if (!t) return false;
  const krop = new URLSearchParams({ secret, response: t });
  if (ip && ip !== "ukendt") krop.set("remoteip", ip);
  try {
    const svar = await fetch(SITEVERIFY, {
      method: "POST",
      body: krop,
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!svar.ok) return false;
    const data = (await svar.json()) as { success?: unknown; hostname?: unknown; action?: unknown };
    if (data.success !== true) return false;

    // Testnøglerne svarer med faste værdier for vært og action.
    if (TESTHEMMELIGHED.test(secret)) return true;
    const vaert = typeof data.hostname === "string" ? data.hostname.toLowerCase() : "";
    if (!tilladteTurnstileVaerter().has(vaert)) {
      console.error("Turnstile: token fra en vært, der ikke er vores:", vaert || "(ingen)");
      return false;
    }
    if (handling !== undefined && data.action !== handling) {
      console.error("Turnstile: token fra en anden formular:", typeof data.action === "string" ? data.action : "(ingen)");
      return false;
    }
    return true;
  } catch (err) {
    console.error("Turnstile: tjekket fejlede:", err);
    return false;
  }
}
