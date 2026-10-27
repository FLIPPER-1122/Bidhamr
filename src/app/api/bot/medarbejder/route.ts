import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { APP_UGYLDIG, appSvar, laesJsonKrop } from "@/lib/appApi";
import { UUID_RE, laesEmail } from "@/lib/bot/konfig";
import { BOT_IKKE_TILGAENGELIG, overdragTilMedarbejder } from "@/lib/bot/motor";
import { botSynligPaaHjemmesiden } from "@/lib/bot/synlig";
import { egenOrigin } from "@/lib/bot/http";

// "Kontakt en rigtig medarbejder" i chatboblen: samtalen sendes som en
// henvendelse til /admin/kontakt. Medarbejderen svarer i Beskeder ("Fra
// BidHamr") eller på mail, hvis brugeren ikke er logget ind.
//
// POST /api/bot/medarbejder  { samtaleId: uuid, email?: string (kræves uden login) }
//   200 { ok: true, allerede: boolean } eller { fejl, kode }.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!egenOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });
  if (!(await botSynligPaaHjemmesiden())) {
    return appSvar(BOT_IKKE_TILGAENGELIG.status, { fejl: BOT_IKKE_TILGAENGELIG.fejl, kode: BOT_IKKE_TILGAENGELIG.kode });
  }
  const ip = await klientIp();
  if (!(await tjekGraenser([["bot_medarbejder_ip", ip]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const k = await laesJsonKrop(req, 2048);
  if ("svar" in k) return k.svar;
  const samtaleId = k.krop.samtaleId;
  if (typeof samtaleId !== "string" || !UUID_RE.test(samtaleId)) return appSvar(400, APP_UGYLDIG);

  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);

  const email = user ? null : laesEmail(k.krop.email);
  if (!user && !email) {
    return appSvar(400, { fejl: "Skriv en gyldig e-mailadresse, så en medarbejder kan svare dig.", kode: "mangler_email" });
  }
  const svar = await overdragTilMedarbejder({ samtaleId: samtaleId.toLowerCase(), brugerId: user?.id ?? null, email });
  if ("fejl" in svar) return appSvar(svar.status, { fejl: svar.fejl, kode: svar.kode });
  return appSvar(200, svar);
}
