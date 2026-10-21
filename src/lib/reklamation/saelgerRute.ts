import "server-only";

// Fælles for sælgerens ruter /api/reklamation/<id> og /billeder:
// hjemmesiden bruger cookie-login, appen "Authorization: Bearer <token>".
// Klienten kører som brugeren, så databasen (min_reklamationspakke_adgang,
// auth.uid()) afgør adgangen. Grænse: 60 opslag i timen pr. bruger.
import type { NextRequest } from "next/server";
import { createClient as lavKlient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { logDriftFejl } from "@/lib/drift";
import { hentPakkeTilSaelger, type PakkeFiler, type Reklamationspakke } from "@/lib/reklamation/pakke";
import { tekstSvar } from "@/lib/reklamation/zipSvar";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function brugerKlient(req: NextRequest): Promise<{ klient: SupabaseClient; id: string } | null> {
  const auth = (req.headers.get("authorization") ?? "").trim();
  if (auth) {
    const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth);
    if (!m) return null;
    const klient = lavKlient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${m[1]}` } },
    });
    const { data, error } = await klient.auth.getUser(m[1]);
    return error || !data.user ? null : { klient, id: data.user.id };
  }
  const klient = (await createClient()) as unknown as SupabaseClient;
  const { data } = await klient.auth.getUser();
  return data.user ? { klient, id: data.user.id } : null;
}

async function indenForGraense(id: string): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient().rpc("rate_limit_tjek", {
      p_noegle: `reklamation_pakke:${id}`,
      p_maks: 60,
      p_vindue_sek: 60 * 60,
    });
    return error ? true : data !== false;
  } catch {
    return true;
  }
}

// Svar = færdigt fejlsvar, eller pakken.
export async function hentSaelgerPakke(
  req: NextRequest,
  rawId: string,
  hvor: string,
): Promise<Response | { pakke: Reklamationspakke; filer: PakkeFiler; brugerId: string }> {
  const b = await brugerKlient(req);
  if (!b) return tekstSvar(401, "Du er ikke logget ind. Log ind, og prøv igen.");
  if (!UUID.test(rawId)) return tekstSvar(404, "Reklamationen findes ikke.");
  if (!(await indenForGraense(b.id))) return tekstSvar(429, "Du har hentet mange gange på kort tid. Vent lidt, og prøv igen.");
  try {
    const res = await hentPakkeTilSaelger(b.klient, rawId.toLowerCase());
    if (!res) return tekstSvar(404, "Reklamationen findes ikke, eller den er afsluttet.");
    return { ...res, brugerId: b.id };
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor, fejl: err, brugerId: b.id });
    return tekstSvar(500, "Reklamationen kunne ikke hentes. Prøv igen om lidt.");
  }
}
