import { NextRequest, NextResponse } from "next/server";
import { koerBetalingsCron } from "@/lib/betaling/cron";

// Lukker auktioner, opretter handel + betaling (48 timers frist), forsøger
// autobetaling, sender "du vandt"-mails og betalingspåmindelser og overfører
// frigivne beløb til sælgere. Annullerer og refunderer handler, hvor pakken
// ikke er sendt 5 dage efter betalingen. Se src/lib/betaling/cron.ts.
//
// Kaldes hvert 5. minut af pg_cron + pg_net (job 'betalings-cron', se migration
// 20261001020000) og dagligt kl. 03 af Vercel Cron som backup. Ruten er
// idempotent: mails, autobetaling og overførsler claimes atomisk i databasen,
// og alle Stripe-kald har idempotency keys - samtidige kald giver ingen
// dobbelt effekt.
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
