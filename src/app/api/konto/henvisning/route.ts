import { type NextRequest } from "next/server";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { APP_GENERISK, APP_IKKE_LOGGET_IND, appBruger, appSvar, bearerToken, fremmedOrigin } from "@/lib/appApi";
import { hentMinHenvisning } from "@/lib/henvisning/status";

// Henvis en ven i appen - Bearer-varianten af /konto/henvis. Samme
// databasekald (min_henvisning(), auth.uid()) som hjemmesiden. Dokumentation:
// docs/APP-ENDPOINTS.md ("Henvis en ven").
//
// POST /api/konto/henvisning   (ingen krop)
//   Authorization: Bearer <Supabase access token>
//   200 { ok: true, kan_henvise: false, grund: "erhverv" }   firmakonto: intet link
//   200 { ok: true, kan_henvise: true, kode, sti, url, kan_faa_point, grund,
//         optjening_aaben, point_pr_ven, maks_pr_maaned, maaned,
//         belonnet_denne_maaned, tilbage_denne_maaned, antal_venner,
//         antal_afventer, antal_belonnet, point_i_alt,
//         venner: [{ navn, status, point, oprettet_kl, vurderet_kl }] }
//   401 { fejl, kode: "ikke_logget_ind" }   403 { fejl, kode: "ikke_tilladt" }
//   429 { fejl, kode: "for_mange" }   500 { fejl, kode: "fejl" }
// POST (ikke GET): første kald laver brugerens kode.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["henvisning_app_ip", ip]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const token = bearerToken(req);
  if (!token) return appSvar(401, APP_IKKE_LOGGET_IND);
  const login = await appBruger(token);
  if (!login) return appSvar(401, APP_IKKE_LOGGET_IND);

  try {
    const h = await hentMinHenvisning(login.supabase);
    if (!h) return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
    return appSvar(200, { ok: true, ...h });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/konto/henvisning", fejl: err, brugerId: login.bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}
