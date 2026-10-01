import { NextRequest, NextResponse } from "next/server";
import { koerBetalingsCron } from "@/lib/betaling/cron";

// Lukker auktioner, opretter handel + betaling (48 timers frist), forsøger
// autobetaling, sender "du vandt"-mails og betalingspåmindelser og overfører
// frigivne beløb til sælgere. Se src/lib/betaling/cron.ts.
//
// NB: Påmindelser efter 24/40 timer og autobetaling "med det samme" kræver,
// at ruten kaldes ofte (fx hvert 5.-15. minut). Vercel Hobby tillader kun
// daglig cron - se rapporten til Filip.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function harAdgang(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  // Fail closed: uden en konfigureret hemmelighed afvises alt.
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function haandter(req: NextRequest) {
  if (!harAdgang(req)) {
    return NextResponse.json({ fejl: "Ingen adgang" }, { status: 401 });
  }
  try {
    return NextResponse.json(await koerBetalingsCron());
  } catch (err) {
    console.error("Cron-kørsel fejlede:", err);
    return NextResponse.json({ fejl: "Cron-kørsel fejlede" }, { status: 500 });
  }
}

// GET til Vercel Cron (sender selv Authorization-headeren), POST til manuel kørsel.
export const GET = haandter;
export const POST = haandter;
