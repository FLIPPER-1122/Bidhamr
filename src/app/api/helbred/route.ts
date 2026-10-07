import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { klientIp } from "@/lib/rateLimit";

// Sundhedstjek til den eksterne uptime-tjeneste (docs/overvaagning.md):
//   200 {"ok":true}  appen svarer, og databasen svarer inden for tidsfristen
//   503 {"ok":false} databasen svarer ikke (eller fejler)
//   429              for mange kald fra samme IP
// Ingen detaljer, fejltekster eller hemmeligheder i svaret. Offentlig (undtaget
// fra login-kravet i src/lib/supabase/middleware.ts).
//
// Billigt: højst ét databasekald pr. 10 sekunder pr. server-instans (resultatet
// genbruges), og en simpel grænse pr. IP i hukommelsen - ingen databasekald
// for at tælle.
//
// Bruger anon-nøglen (ikke service_role) og kalder helbred_ping(), som kun
// returnerer true (migration 20261008010000_drift_alarmer.sql). Ruten kan
// derfor ikke læse noget, selv hvis den blev misbrugt.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_MS = 10_000;
const GRAENSE = { maks: 30, vindueMs: 60_000 };

// Tidsfrist for databasekaldet. HELBRED_TIMEOUT_MS kan sættes til test
// (fx 1 for at fremprovokere 503); 1-10.000 ms, standard 3.000.
function timeoutMs(): number {
  const n = Number(process.env.HELBRED_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10_000) : 3_000;
}

let senest: { ok: boolean; kl: number } | null = null;
let igang: Promise<boolean> | null = null;
const kald = new Map<string, { start: number; antal: number }>();

function indenForGraense(ip: string, nu: number): boolean {
  if (kald.size > 5_000) {
    for (const [k, v] of kald) if (nu - v.start > GRAENSE.vindueMs) kald.delete(k);
    if (kald.size > 5_000) kald.clear();
  }
  const k = kald.get(ip);
  if (!k || nu - k.start > GRAENSE.vindueMs) {
    kald.set(ip, { start: nu, antal: 1 });
    return true;
  }
  k.antal += 1;
  return k.antal <= GRAENSE.maks;
}

async function databaseSvarer(): Promise<boolean> {
  const ms = timeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const signal = AbortSignal.timeout(ms);
    const forespoergsel = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      offentligNoegle(),
      { auth: { autoRefreshToken: false, persistSession: false } },
    )
      .rpc("helbred_ping")
      .abortSignal(signal)
      .then(({ data, error }) => !error && data === true);
    const frist = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms + 50);
    });
    return await Promise.race([forespoergsel, frist]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function status(): Promise<boolean> {
  const nu = Date.now();
  if (senest && nu - senest.kl < CACHE_MS) return senest.ok;
  if (!igang) {
    igang = databaseSvarer()
      .then((ok) => {
        senest = { ok, kl: Date.now() };
        return ok;
      })
      .finally(() => {
        igang = null;
      });
  }
  return igang;
}

const HEADERE = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex",
};

async function svar(medKrop: boolean) {
  const ip = await klientIp();
  if (!indenForGraense(ip, Date.now())) {
    return new NextResponse(medKrop ? JSON.stringify({ ok: false }) : null, {
      status: 429,
      headers: { ...HEADERE, "Retry-After": "60", "Content-Type": "application/json" },
    });
  }
  const ok = await status();
  return new NextResponse(medKrop ? JSON.stringify({ ok }) : null, {
    status: ok ? 200 : 503,
    headers: { ...HEADERE, "Content-Type": "application/json" },
  });
}

export async function GET() {
  return svar(true);
}

// Nogle uptime-tjenester bruger HEAD.
export async function HEAD() {
  return svar(false);
}
