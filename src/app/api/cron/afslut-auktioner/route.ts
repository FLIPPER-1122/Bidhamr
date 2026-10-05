import { NextRequest, NextResponse } from "next/server";
import { koerBetalingsCron } from "@/lib/betaling/cron";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl, renFejltekst } from "@/lib/drift";

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
//
// Hver godkendt kørsel logges i drift_cron_koersler (vises på /admin/drift).
// Afslutningen skrives i finally, så også fejl logges. Afbrydes processen
// (fx timeout), står rækken uden afsluttet_kl.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const JOB = "betalings-cron";

function harAdgang(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  // Fail closed: uden en konfigureret hemmelighed afvises alt.
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

// Kun tal og små objekter med tal (resuméet fra koerBetalingsCron) - aldrig
// tekst, der kunne indeholde persondata.
function kortResultat(r: unknown): Record<string, unknown> | null {
  if (!r || typeof r !== "object") return null;
  const ud: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    if (typeof v === "number") ud[k] = v;
    else if (v && typeof v === "object") {
      const indre: Record<string, number> = {};
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === "number") indre[k2] = v2;
      }
      ud[k] = indre;
    }
  }
  return ud;
}

async function startLog(metode: string): Promise<number | null> {
  try {
    const { data, error } = await createAdminClient()
      .from("drift_cron_koersler")
      .insert({ job: JOB, metode })
      .select("id")
      .single<{ id: number }>();
    if (error) {
      console.error("Cron-log: start kunne ikke gemmes:", error.message);
      return null;
    }
    return data.id;
  } catch (err) {
    console.error("Cron-log: start kastede:", err);
    return null;
  }
}

async function slutLog(
  id: number | null,
  ok: boolean,
  fejl: string | null,
  resultat: Record<string, unknown> | null,
) {
  if (id === null) return;
  try {
    const { error } = await createAdminClient()
      .from("drift_cron_koersler")
      .update({ afsluttet_kl: new Date().toISOString(), ok, fejl, resultat })
      .eq("id", id)
      .is("afsluttet_kl", null);
    if (error) console.error("Cron-log: slut kunne ikke gemmes:", error.message);
  } catch (err) {
    console.error("Cron-log: slut kastede:", err);
  }
}

async function haandter(req: NextRequest) {
  if (!harAdgang(req)) {
    return NextResponse.json({ fejl: "Ingen adgang" }, { status: 401 });
  }
  const logId = await startLog(req.method === "GET" ? "GET" : "POST");
  let ok = false;
  let fejl: string | null = null;
  let resultat: Record<string, unknown> | null = null;
  try {
    const r = await koerBetalingsCron();
    resultat = kortResultat(r);
    ok = true;
    return NextResponse.json(r);
  } catch (err) {
    console.error("Cron-kørsel fejlede:", err);
    fejl = renFejltekst(err);
    await logDriftFejl({ kilde: "cron", sti: JOB, hvor: "Cron-kørsel", fejl: err });
    return NextResponse.json({ fejl: "Cron-kørsel fejlede" }, { status: 500 });
  } finally {
    await slutLog(logId, ok, ok ? null : (fejl ?? "Ukendt fejl"), resultat);
  }
}

// GET til Vercel Cron (sender selv Authorization-headeren), POST til manuel kørsel.
export const GET = haandter;
export const POST = haandter;
