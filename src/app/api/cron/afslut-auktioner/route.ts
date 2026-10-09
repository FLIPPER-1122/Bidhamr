import { NextRequest, NextResponse } from "next/server";
import { koerBetalingsCron } from "@/lib/betaling/cron";
import { createAdminClient } from "@/lib/supabase/admin";
import { driftFejlSamler, logDriftFejl, renFejltekst } from "@/lib/drift";
import { koerFragtCron } from "@/lib/fragt/server";
import { harCronAdgang } from "@/lib/cronAdgang";
import { koerDac7Cron } from "@/lib/dac7/server";

// Lukker auktioner, opretter handel + betaling (48 timers frist; vinderen
// betaler selv - ingen automatisk betaling), sender "du vandt"-mails og
// betalingspåmindelser og overfører
// frigivne beløb til sælgere. Annullerer og refunderer handler, hvor pakken
// ikke er sendt 5 dage efter betalingen. Se src/lib/betaling/cron.ts.
// Henter derefter sporing for aktive forsendelser (src/lib/fragt/server.ts)
// og kører DAC7-påmindelserne (src/lib/dac7/server.ts).
//
// Kaldes hvert 5. minut af pg_cron + pg_net (job 'betalings-cron', se migration
// 20261001020000) og dagligt kl. 03 af Vercel Cron som backup. Ruten er
// idempotent: mails og overførsler claimes atomisk i databasen,
// og alle Stripe-kald har idempotency keys - samtidige kald giver ingen
// dobbelt effekt.
//
// Hver godkendt kørsel logges i drift_cron_koersler (vises på /admin/drift).
// Afslutningen skrives i finally, så også fejl logges. Afbrydes processen
// (fx timeout), står rækken uden afsluttet_kl. Logger et af betalingstrinnene
// en fejl (logDriftFejl med kilde 'cron' - også når trinnet selv fanger den og
// fortsætter), markeres kørslen som FEJLET (ok = false) med trinnenes fejl
// (Niels F06). Fragtsporingen tæller ikke med (flytter ingen penge).
//
// Livstegn til en EKSTERN overvågning (Niels F06): er HEARTBEAT_URL sat
// (valgfri, fx en healthchecks.io- eller UptimeRobot-heartbeat-adresse),
// pinges den efter hver kørsel - "<url>" ved succes og "<url>/fail" ved fejl
// (healthchecks.io-formatet; UptimeRobot ignorerer fejl-pinget, og så udebliver
// livstegnet). Den eksterne tjeneste alarmerer, hvis der ikke kommer et
// livstegn hvert 5. minut - også hvis Supabase, pg_cron eller Vercel er nede.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const JOB = "betalings-cron";

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

// Kaster aldrig og venter højst 5 sekunder. Kun https.
async function heartbeat(ok: boolean) {
  const url = process.env.HEARTBEAT_URL;
  if (!url) return;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return;
    const sti = ok ? u.toString() : `${u.toString().replace(/\/+$/, "")}/fail`;
    await fetch(sti, { method: "GET", signal: AbortSignal.timeout(5_000), cache: "no-store" });
  } catch (err) {
    console.error("Heartbeat kunne ikke sendes:", renFejltekst(err));
  }
}

async function haandter(req: NextRequest) {
  if (!harCronAdgang(req)) {
    return NextResponse.json({ fejl: "Ingen adgang" }, { status: 401 });
  }
  const logId = await startLog(req.method === "GET" ? "GET" : "POST");
  let ok = false;
  let fejl: string | null = null;
  let resultat: Record<string, unknown> | null = null;
  const trinFejl: string[] = [];
  try {
    const betaling = await driftFejlSamler.run(trinFejl, () => koerBetalingsCron());
    // Fragtsporing (let og begrænset; flytter ingen penge). Fejl her stopper
    // ikke betalings-cron'en og logges i drift_fejl af koerFragtCron selv.
    let fragt: Awaited<ReturnType<typeof koerFragtCron>> | null = null;
    try {
      fragt = await koerFragtCron();
    } catch (err) {
      await logDriftFejl({ kilde: "cron", sti: JOB, hvor: "Fragt-cron", fejl: err });
    }
    // DAC7: anmodninger om skatteoplysninger, påmindelser og spærring
    // (højst én gang i timen i databasen; flytter ingen penge). Fejl her
    // stopper ikke resten og logges i drift_fejl.
    let dac7: Awaited<ReturnType<typeof koerDac7Cron>> | null = null;
    try {
      dac7 = await koerDac7Cron();
    } catch (err) {
      await logDriftFejl({ kilde: "cron", sti: JOB, hvor: "DAC7-cron", fejl: err });
    }
    const r = { ...betaling, fragt, dac7 };
    resultat = kortResultat(r);
    if (trinFejl.length > 0) {
      fejl = `Fejl i ${trinFejl.length} trin: ${[...new Set(trinFejl)].slice(0, 5).join(" | ")}`.slice(0, 1000);
    } else {
      ok = true;
    }
    return NextResponse.json({ ...r, ok, trinFejl: trinFejl.length });
  } catch (err) {
    console.error("Cron-kørsel fejlede:", err);
    fejl = renFejltekst(err);
    await logDriftFejl({ kilde: "cron", sti: JOB, hvor: "Cron-kørsel", fejl: err });
    return NextResponse.json({ fejl: "Cron-kørsel fejlede" }, { status: 500 });
  } finally {
    await slutLog(logId, ok, ok ? null : (fejl ?? "Ukendt fejl"), resultat);
    await heartbeat(ok);
  }
}

// GET til Vercel Cron (sender selv Authorization-headeren), POST til manuel kørsel.
export const GET = haandter;
export const POST = haandter;
