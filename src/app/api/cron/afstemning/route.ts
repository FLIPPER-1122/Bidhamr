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
// Vagt udefra: CRON_AFSTEMNING_HEALTHCHECK_URL (bør sættes i produktion) pinges,
// når en afstemning er kørt fuldstændigt uden fejl, og "/fail", når et trin
// fejlede (fx en healthchecks.io-check med periode 1 døgn og grace 3 timer).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Afstemningens tidsbudget (180 s minus Stripe-timeout) ligger inden for.
export const maxDuration = 300;

// "<url>/fail" o.l.: endelsen på stien - query-strengen bevares.
function medEndelse(u: URL, endelse: string): string {
  const ny = new URL(u.toString());
  ny.pathname = `${ny.pathname.replace(/\/+$/, "")}/${endelse}`;
  return ny.toString();
}

// ok = fuldstændig kørsel uden fejlede trin -> "<url>"; fejl -> "<url>/fail"
// (healthchecks.io alarmerer med det samme).
async function healthcheck(ok: boolean) {
  const url = process.env.CRON_AFSTEMNING_HEALTHCHECK_URL;
  if (!url) return;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return;
    const sti = ok ? u.toString() : medEndelse(u, "fail");
    await fetch(sti, { method: "GET", signal: AbortSignal.timeout(5_000), cache: "no-store" });
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
    // Kørt helt igennem uden fejl: livstegn. Fejlede trin: fejl-ping og
    // ok: false (fejlene er logget som drift-fejl). Ingen kørsel denne gang
    // (claimet af en tidligere): intet ping.
    const ok = r.fejlede === 0;
    if (r.koert && (!ok || r.ufuldstaendig === 0)) await healthcheck(ok);
    return NextResponse.json({ ...r, ok });
  } catch (err) {
    // koerPengeafstemning kaster ikke - men for en sikkerheds skyld.
    console.error("Pengeafstemning fejlede:", err);
    await logDriftFejl({ kilde: "cron", sti: "pengeafstemning", hvor: "Afstemningsruten", fejl: err });
    await healthcheck(false);
    return NextResponse.json({ fejl: "Afstemningen fejlede" }, { status: 500 });
  }
}

export const GET = haandter;
export const POST = haandter;
