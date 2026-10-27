import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { appSvar, fremmedOrigin, laesJsonKrop } from "@/lib/appApi";
import { sendNulstillingsmail } from "@/lib/adgangskodeSkift";

// "Glemt adgangskode" fra appen. Samme kode som /glemt-adgangskode på
// hjemmesiden (src/lib/adgangskodeSkift.ts): samme grænser (nulstil_ip,
// nulstil_email) og samme svar, uanset om e-mailen findes. Mailens link går
// til hjemmesiden (/auth/callback -> /reset-password), hvor brugeren vælger
// den nye adgangskode. Ingen login (man har glemt sin adgangskode).
// Dokumentation: docs/APP-ENDPOINTS.md.
//
// POST /api/konto/glemt
//   Content-Type: application/json
//   { email, captchaToken? }                captchaToken: se docs/SIKKERHED-AUTH.md
//   200 { ok: true }                       altid ved en gyldig e-mail
//   400 { fejl, kode: "ugyldig" | "email" | "captcha" }
//   403 { fejl, kode: "ikke_tilladt" }    fremmed Origin
//   429 { fejl, kode: "for_mange" }
//   503 { fejl, kode: "ikke_tilgaengelig" } grænserne kunne ikke tjekkes (fail closed)

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["konto_app_ip", ip]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const k = await laesJsonKrop(req, 1024);
  if ("svar" in k) return k.svar;

  try {
    // Ingen session og ingen cookies: kun den offentlige nøgle.
    const klient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    // captchaToken: Turnstile-token fra appen, når CAPTCHA er slået til i
    // Supabase (docs/SIKKERHED-AUTH.md).
    const r = await sendNulstillingsmail(klient, k.krop.email, ip, k.krop.captchaToken);
    if ("fejl" in r) {
      const status = r.kode === "email" || r.kode === "captcha" ? 400 : r.kode === "for_mange" ? 429 : 503;
      return appSvar(status, { fejl: r.fejl, kode: r.kode });
    }
    return appSvar(200, { ok: true });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/konto/glemt", fejl: err });
    // Samme svar som en gennemført afsendelse (afslører intet).
    return appSvar(200, { ok: true });
  }
}
