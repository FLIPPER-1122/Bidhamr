import { NextRequest, NextResponse } from "next/server";
import { harCronAdgang } from "@/lib/cronAdgang";
import { logDriftFejl, renFejltekst } from "@/lib/drift";
import { koerPengeafstemning } from "@/lib/betaling/afstemning";

// Den daglige fulde pengeafstemning med Stripe (src/lib/betaling/afstemning.ts).
// Egen rute (ikke betalings-cron'en), fordi den kan tage op til 3 minutter,
// og pg_net giver op efter 60 s på betalings-cron'en. Kaldes hver time af
// pg_cron-jobbet 'pengeafstemning' (kald_pengeafstemning, timeout 300 s -
// 20261019020000_pengeafstemning.sql); databasen sørger for, at den kun
// kører én gang pr. 20 timer (og igen efter 2 timer, hvis den fejlede eller
// ikke nåede alle trin). Et kald uden noget at gøre svarer med det samme.
//
// Samme adgang som de andre cron-ruter (Authorization: Bearer CRON_SECRET).
// Flytter ingen penge. Kørslen logges i penge_afstemning_koersler; fejl giver
// drift-alarm (drift_fejl). Svaret indeholder kun tal.
//
// Valgfri vagt udefra: CRON_AFSTEMNING_HEALTHCHECK_URL pinges, når en
// afstemning er kørt fuldstændigt (fx en healthchecks.io-check med periode
// 1 døgn og grace 3 timer).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Afstemningens tidsbudget (180 s minus Stripe-timeout) ligger inden for.
export const maxDuration = 300;

async function healthcheck() {
  const url = process.env.CRON_AFSTEMNING_HEALTHCHECK_URL;
  if (!url) return;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return;
    await fetch(u.toString(), { method: "GET", signal: AbortSignal.timeout(5_000), cache: "no-store" });
  } catch (err) {
    console.error("Healthcheck (afstemning) kunne ikke sendes:", renFejltekst(err));
  }
}

async function haandter(req: NextRequest) {
  const startKl = Date.now();
  if (!harCronAdgang(req)) {
    return NextResponse.json({ fejl: "Ingen adgang" }, { status: 401 });
  }
  try {
    const r = await koerPengeafstemning({ startKl });
    if (r.koert && r.ufuldstaendig === 0) await healthcheck();
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    // koerPengeafstemning kaster ikke - men for en sikkerheds skyld.
    console.error("Pengeafstemning fejlede:", err);
    await logDriftFejl({ kilde: "cron", sti: "pengeafstemning", hvor: "Afstemningsruten", fejl: err });
    return NextResponse.json({ fejl: "Afstemningen fejlede" }, { status: 500 });
  }
}

export const GET = haandter;
export const POST = haandter;
