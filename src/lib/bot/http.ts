import "server-only";

import type { NextRequest } from "next/server";
import type { GraenseNavn } from "@/lib/rateLimit";

// Fælles svar for BidHamr-bottens endpoints (/api/bot og /api/app/bot).

export function botStreamSvar(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

// Hjemmesiden: Origin SKAL være sat og være vores egen vært (cookie-session -
// browseren sender altid Origin ved fetch med POST). Samme regel som
// /api/offentlig.
export function egenOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const vaert = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return !!vaert && new URL(origin).host === vaert;
  } catch {
    return false;
  }
}

// "Kontakt en rigtig medarbejder" (/api/bot/medarbejder og
// /api/app/bot/medarbejder): ud over bot_medarbejder_ip (pr. IP /64, tjekkes
// først) de samme lofter som kontaktformularen - pr. e-mail, pr. bruger og
// globalt.
export function medarbejderGraenser(brugerId: string | null, email: string | null): [GraenseNavn, string][] {
  const g: [GraenseNavn, string][] = [["kontakt_alle", "alle"]];
  if (email) g.push(["kontakt_email", email.toLowerCase()]);
  if (brugerId) g.push(["kontakt_bruger", brugerId]);
  return g;
}
