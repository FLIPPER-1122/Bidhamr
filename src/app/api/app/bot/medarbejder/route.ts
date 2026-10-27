import type { NextRequest } from "next/server";
import { FOR_MANGE_FORSOEG, klientIpNoegle, tjekGraenser } from "@/lib/rateLimit";
import { APP_IKKE_LOGGET_IND, APP_UGYLDIG, appSvar, fremmedOrigin, laesJsonKrop } from "@/lib/appApi";
import { UUID_RE, laesEmail } from "@/lib/bot/konfig";
import { BOT_IKKE_TILGAENGELIG, overdragTilMedarbejder } from "@/lib/bot/motor";
import { botSynligIAppen } from "@/lib/bot/synlig";
import { appBotLogin } from "@/lib/bot/appLogin";
import { medarbejderGraenser } from "@/lib/bot/http";

// "Kontakt en rigtig medarbejder" fra appens BidHamr-bot. Samme som
// hjemmesidens /api/bot/medarbejder.
//
// POST /api/app/bot/medarbejder  Authorization: Bearer <token> (valgfri)
//   { samtaleId: uuid, email?: string }  - email kræves uden login.
//   200 { ok: true, allerede: boolean }   allerede = var sendt før (dobbelttryk)
//   400/401/403/404/429/500 { fejl, kode }

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });
  // IPv6 pr. /64 (src/lib/ipNoegle.ts).
  const ip = await klientIpNoegle();
  if (!(await tjekGraenser([["bot_medarbejder_ip", ip]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }
  const login = await appBotLogin(req);
  if (!login.ok) return appSvar(401, APP_IKKE_LOGGET_IND);
  if (!(await botSynligIAppen(login.supabase, login.brugerId))) {
    return appSvar(BOT_IKKE_TILGAENGELIG.status, { fejl: BOT_IKKE_TILGAENGELIG.fejl, kode: BOT_IKKE_TILGAENGELIG.kode });
  }

  const k = await laesJsonKrop(req, 2048);
  if ("svar" in k) return k.svar;
  const samtaleId = k.krop.samtaleId;
  if (typeof samtaleId !== "string" || !UUID_RE.test(samtaleId)) return appSvar(400, APP_UGYLDIG);

  const email = login.brugerId ? null : laesEmail(k.krop.email);
  if (!login.brugerId && !email) {
    return appSvar(400, { fejl: "Skriv en gyldig e-mailadresse, så en medarbejder kan svare dig.", kode: "mangler_email" });
  }
  // Samme lofter som kontaktformularen (pr. e-mail, pr. bruger og globalt).
  if (!(await tjekGraenser(medarbejderGraenser(login.brugerId, email ?? login.email)))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }
  const svar = await overdragTilMedarbejder({ samtaleId: samtaleId.toLowerCase(), brugerId: login.brugerId, email, ip });
  if ("fejl" in svar) return appSvar(svar.status, { fejl: svar.fejl, kode: svar.kode });
  return appSvar(200, svar);
}
