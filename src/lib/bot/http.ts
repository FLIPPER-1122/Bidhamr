import "server-only";

import type { NextRequest } from "next/server";

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
