import type { NextRequest } from "next/server";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { APP_IKKE_LOGGET_IND, APP_UGYLDIG, appSvar, fremmedOrigin, laesJsonKrop } from "@/lib/appApi";
import { BOT_LOFT_PR_DOEGN, BOT_MAKS_TEGN, laesBotInput } from "@/lib/bot/konfig";
import { BOT_IKKE_TILGAENGELIG, startBotSvar } from "@/lib/bot/motor";
import { botSynligIAppen } from "@/lib/bot/synlig";
import { botStreamSvar } from "@/lib/bot/http";
import { appBotLogin } from "@/lib/bot/appLogin";

// BidHamr-bot i appen. Samme kerne og regler som hjemmesidens /api/bot
// (src/lib/bot/motor.ts). Dokumentation: docs/APP-ENDPOINTS.md.
//
// Authorization: Bearer <Supabase access token>   (valgfri - uden = ikke logget ind)
//
// GET /api/app/bot
//   200 { ok: true, tilgaengelig: boolean, maksTegn, loftPrDoegn }
//   tilgaengelig = false: vis ikke botten (ingen nøgle, eller før lancering
//   uden adgang til den lukkede app).
//
// POST /api/app/bot  Content-Type: application/json
//   { samtaleId?: uuid, besked: string (højst 1.000 tegn) }
//   200 NDJSON-stream (application/x-ndjson), én JSON pr. linje:
//     { type: "samtale", samtaleId }  { type: "tekst", tekst }
//     { type: "medarbejder" }  { type: "fejl", fejl }  { type: "slut" }
//   400/401/403/404/409/429/500 { fejl, kode }

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });
  const login = await appBotLogin(req);
  if (!login.ok) return appSvar(401, APP_IKKE_LOGGET_IND);
  const tilgaengelig = await botSynligIAppen(login.supabase, login.brugerId);
  return appSvar(200, { ok: true, tilgaengelig, maksTegn: BOT_MAKS_TEGN, loftPrDoegn: BOT_LOFT_PR_DOEGN });
}

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["bot_ip", ip]]))) return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });

  const login = await appBotLogin(req);
  if (!login.ok) return appSvar(401, APP_IKKE_LOGGET_IND);
  if (!(await botSynligIAppen(login.supabase, login.brugerId))) {
    return appSvar(BOT_IKKE_TILGAENGELIG.status, { fejl: BOT_IKKE_TILGAENGELIG.fejl, kode: BOT_IKKE_TILGAENGELIG.kode });
  }

  const k = await laesJsonKrop(req, 8192);
  if ("svar" in k) return k.svar;
  const input = laesBotInput(k.krop);
  if ("fejl" in input) return appSvar(400, input.kode === "ugyldig" ? APP_UGYLDIG : input);

  const start = await startBotSvar({
    supabase: login.supabase,
    brugerId: login.brugerId,
    ip,
    kilde: "app",
    input,
    signal: req.signal,
  });
  if ("fejl" in start) return appSvar(start.status, { fejl: start.fejl, kode: start.kode });
  return botStreamSvar(start.stream);
}
