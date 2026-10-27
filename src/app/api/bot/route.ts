import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { FOR_MANGE_FORSOEG, klientIpNoegle, tjekGraenser } from "@/lib/rateLimit";
import { APP_UGYLDIG, appSvar, laesJsonKrop } from "@/lib/appApi";
import { laesBotInput } from "@/lib/bot/konfig";
import { BOT_IKKE_TILGAENGELIG, startBotSvar } from "@/lib/bot/motor";
import { botSynligPaaHjemmesiden } from "@/lib/bot/synlig";
import { botStreamSvar, egenOrigin } from "@/lib/bot/http";

// BidHamr-bot på hjemmesiden (chatboblen, src/components/bot/BotChat.tsx).
// Cookie-session: Origin skal være vores egen vært, og kroppen skal være
// JSON. Uden login virker botten også (efter lancering), men værktøjerne til
// egne data giver intet. Samme kerne som appens POST /api/app/bot
// (src/lib/bot/motor.ts).
//
// POST /api/bot  { samtaleId?: uuid, besked: string (højst 1.000 tegn) }
//   200 NDJSON-stream (se motor.ts) eller { fejl, kode } med 400/403/404/409/429/500.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!egenOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });
  if (!(await botSynligPaaHjemmesiden())) {
    return appSvar(BOT_IKKE_TILGAENGELIG.status, { fejl: BOT_IKKE_TILGAENGELIG.fejl, kode: BOT_IKKE_TILGAENGELIG.kode });
  }

  // IPv6 pr. /64 (src/lib/ipNoegle.ts).
  const ip = await klientIpNoegle();
  if (!(await tjekGraenser([["bot_ip", ip]]))) return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });

  const k = await laesJsonKrop(req, 8192);
  if ("svar" in k) return k.svar;
  const input = laesBotInput(k.krop);
  if ("fejl" in input) return appSvar(400, input.kode === "ugyldig" ? APP_UGYLDIG : input);

  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);

  const start = await startBotSvar({
    supabase: user ? supabase : null,
    brugerId: user?.id ?? null,
    ip,
    kilde: "web",
    input,
    signal: req.signal,
  });
  if ("fejl" in start) return appSvar(start.status, { fejl: start.fejl, kode: start.kode });
  return botStreamSvar(start.stream);
}
