import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";

// Fælles byggesten til appens JSON-endpoints (Bearer-token), som
// /api/handel/app, /api/bud/app, /api/konto/adgangskode, /api/konto/data og
// /api/auktion/app. Samme regler som /api/fragt/app og /api/betaling/app:
//   - kun Bearer-token: cookies bruges ikke (ingen CSRF),
//   - ingen CORS-headere, og en fremmed Origin afvises (appen sender ingen),
//   - brugeren findes ud fra tokenet, aldrig fra kroppen,
//   - svar { ok: true, ... } eller { fejl, kode } med en dansk fejl.

export const APP_UGYLDIG = { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" } as const;
export const APP_IKKE_LOGGET_IND = { fejl: "Du er ikke logget ind længere. Log ind igen.", kode: "ikke_logget_ind" } as const;
export const APP_GENERISK = "Noget gik galt. Prøv igen om lidt.";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function appSvar(status: number, krop: Record<string, unknown>) {
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

// Bearer-tokenet (en JWT) fra Authorization-headeren, eller null.
export function bearerToken(req: NextRequest): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    (req.headers.get("authorization") ?? "").trim(),
  );
  return m ? m[1] : null;
}

async function laesBegraenset(req: NextRequest, maks: number): Promise<string | null> {
  if (!req.body) return "";
  const laeser = req.body.getReader();
  const dele: Uint8Array[] = [];
  let i = 0;
  for (;;) {
    const { done, value } = await laeser.read();
    if (done) break;
    i += value.byteLength;
    if (i > maks) {
      await laeser.cancel().catch(() => {});
      return null;
    }
    dele.push(value);
  }
  const samlet = new Uint8Array(i);
  let pos = 0;
  for (const d of dele) {
    samlet.set(d, pos);
    pos += d.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(samlet);
}

// JSON-kroppen som et objekt (højst maks bytes). Svaret er enten kroppen
// eller et færdigt fejlsvar (400/413).
export async function laesJsonKrop(
  req: NextRequest,
  maks = 4096,
): Promise<{ krop: Record<string, unknown> } | { svar: NextResponse }> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return { svar: appSvar(400, APP_UGYLDIG) };
  }
  const laengde = req.headers.get("content-length");
  if (laengde !== null && !(/^\d{1,7}$/.test(laengde) && Number(laengde) <= maks)) {
    return { svar: appSvar(413, APP_UGYLDIG) };
  }
  try {
    const raa = await laesBegraenset(req, maks);
    if (raa === null) return { svar: appSvar(413, APP_UGYLDIG) };
    const j = JSON.parse(raa || "{}") as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("ikke et objekt");
    return { krop: j as Record<string, unknown> };
  } catch {
    return { svar: appSvar(400, APP_UGYLDIG) };
  }
}

const KLIENT_AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

// Supabase-klient, der kalder databasen SOM brugeren (tokenet i
// Authorization-headeren): RLS og auth.uid() i RPC'erne gælder præcis som
// på hjemmesiden, hvor server actions bruger cookie-sessionen.
export function brugerKlient(token: string): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    auth: KLIENT_AUTH,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

// Validerer tokenet hos Supabase Auth (getUser - ikke kun lokalt), så et
// token fra en udlogget session afvises. null = ikke logget ind.
export async function appBruger(
  token: string,
): Promise<{ bruger: User; supabase: SupabaseClient } | null> {
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), { auth: KLIENT_AUTH });
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) return null;
  return { bruger: data.user, supabase: brugerKlient(token) };
}
