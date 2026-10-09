import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createClient, type User } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";

// Fælles for appens MitID-endpoints (/api/mitid/app og /api/mitid/app/afslut):
// kun Bearer-token (ingen cookies, ingen CSRF), ingen CORS, fremmed Origin
// afvises - som /api/konto/slet.

export function svar(status: number, krop: Record<string, unknown>) {
  return NextResponse.json(krop, { status, headers: { "Cache-Control": "no-store" } });
}

export function fremmedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const vaert = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host !== vaert;
  } catch {
    return true;
  }
}

export const IKKE_LOGGET_IND = { fejl: "Du er ikke logget ind længere. Log ind igen.", kode: "ikke_logget_ind" };
export const UGYLDIG = { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" };

// Brugeren bag Bearer-tokenet (valideret hos Supabase Auth), eller null.
export async function bearerBruger(req: NextRequest): Promise<User | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth.trim());
  if (!m) return null;
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.getUser(m[1]);
  return error || !data?.user ? null : data.user;
}

// JSON-krop (højst 4 KB), eller null.
export async function jsonKrop(req: NextRequest): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
  try {
    const raa = await req.text();
    if (raa.length > 4096) return null;
    const v = JSON.parse(raa) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
