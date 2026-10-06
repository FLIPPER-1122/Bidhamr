import { NextResponse, type NextRequest } from "next/server";
import { koerDriftAlarm } from "@/lib/driftAlarm";
import { logDriftFejl } from "@/lib/drift";
import { harCronAdgang } from "@/lib/cronAdgang";

// Drift-alarmer (src/lib/driftAlarm.ts). Kaldes hvert 5. minut af pg_cron-
// jobbet 'drift-alarm' (migration 20261008010000_drift_alarmer.sql) med
// samme CRON_SECRET som betalings-cron'en. Idempotent: "højst én mail pr.
// slags pr. 30 min" håndhæves atomisk i databasen.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function haandter(req: NextRequest) {
  if (!harCronAdgang(req)) {
    return NextResponse.json({ fejl: "Ingen adgang" }, { status: 401 });
  }
  try {
    const r = await koerDriftAlarm();
    // Kun status og slags - aldrig modtager eller fejltekst i svaret.
    const svar = { status: r.status, ...("slags" in r ? { slags: r.slags } : {}) };
    return NextResponse.json(svar, { status: r.status === "fejl" ? 500 : 200 });
  } catch (err) {
    console.error("Drift-alarm kastede:", err);
    await logDriftFejl({ kilde: "cron", sti: "drift-alarm", hvor: "Drift-alarm", fejl: err });
    return NextResponse.json({ fejl: "Drift-alarm fejlede" }, { status: 500 });
  }
}

export const GET = haandter;
export const POST = haandter;
