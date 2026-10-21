import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { APP_IKKE_LOGGET_IND, UUID_RE, appBruger, appSvar, bearerToken } from "@/lib/appApi";
import { tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { signeretDokumentationsLink } from "@/lib/betaling/ekstraFragt";

// Sælgerens link til fragtfirmaets faktura på en ekstraregning (ekstra fragt
// ved for lille pakkestørrelse, 20261029020000_ekstra_fragt.sql).
//
// GET /api/ekstra-fragt/<regning-id>/dokumentation
//   Hjemmesiden: cookie-login. Appen: Authorization: Bearer <token>.
//   200 { ok: true, url }   signeret link, gyldigt i 10 minutter
//   401 ikke_logget_ind · 404 ikke_fundet · 429 for_mange · 500 fejl
// Kun sælgeren på regningen (databasen afgør det ud fra auth.uid():
// min_ekstra_fragt_dokumentation). Filen ligger i en privat bucket.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function bruger(req: NextRequest): Promise<{ klient: SupabaseClient; id: string } | null> {
  const token = bearerToken(req);
  if (req.headers.get("authorization")) {
    if (!token) return null;
    const b = await appBruger(token);
    return b ? { klient: b.supabase, id: b.bruger.id } : null;
  }
  const klient = (await createClient()) as unknown as SupabaseClient;
  const { data } = await klient.auth.getUser();
  return data.user ? { klient, id: data.user.id } : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const b = await bruger(req);
  if (!b) return appSvar(401, APP_IKKE_LOGGET_IND);
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return appSvar(404, { fejl: "Regningen findes ikke.", kode: "ikke_fundet" });
  if (!(await tjekGraenser([["ekstra_fragt_bruger", b.id]]))) return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  try {
    const { data, error } = await b.klient.rpc("min_ekstra_fragt_dokumentation", { p_id: id.toLowerCase() });
    if (error) throw new Error(`min_ekstra_fragt_dokumentation: ${error.message}`);
    const svar = (data ?? {}) as { kode?: string; sti?: string; navn?: string | null };
    if (svar.kode !== "ok" || !svar.sti) return appSvar(404, { fejl: "Regningen findes ikke.", kode: "ikke_fundet" });
    const url = await signeretDokumentationsLink(svar.sti, svar.navn);
    if (!url) return appSvar(500, { fejl: "Fakturaen kunne ikke hentes lige nu. Prøv igen om lidt.", kode: "fejl" });
    return appSvar(200, { ok: true, url });
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "api/ekstra-fragt/dokumentation", fejl: err, brugerId: b.id });
    return appSvar(500, { fejl: "Fakturaen kunne ikke hentes lige nu. Prøv igen om lidt.", kode: "fejl" });
  }
}
