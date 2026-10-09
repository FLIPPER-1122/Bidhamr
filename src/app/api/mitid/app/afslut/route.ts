import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { sha256Hex } from "@/lib/mitid/oidc";
import { resultatFraKode } from "@/lib/mitid/flow";
import { MITID } from "@/lib/tekster/mitid";
import { IKKE_LOGGET_IND, UGYLDIG, bearerBruger, fremmedOrigin, jsonKrop, svar } from "@/lib/mitid/appAuth";

// Appen afslutter MitID her, når in-app browseren er endt på
// bidhamr://mitid?k=<engangs-id> (se docs/MITID.md).
//
// POST /api/mitid/app/afslut
//   Authorization: Bearer <Supabase access token>   (samme bruger som ved start)
//   Content-Type: application/json
//   { "k": "<engangs-id fra deep linket>", "hemmelighed": "<app-hemmeligheden i klartekst>" }
//
// Svar (JSON): 200 { status, besked }   status = ok | allerede | dobbeltkonto |
//   under18 | lukket | tidligereSpaerret | andenMitid | erhverv | udloebet | fejl
//   400 ugyldig, 401 ikke_logget_ind, 403 ikke_tilladt, 429 for_mange, 500 fejl
//
// Sikkerhed: callbacken registrerer ikke appens forløb. Kun den bruger, der
// startede forløbet (Bearer), og som kender hemmeligheden (kun SHA-256 er
// gemt), kan afslutte - én gang og inden for 5 minutter
// (mitid_app_afslut i databasen, atomisk). Et deep link, der lækker eller
// sendes til en anden, kan derfor ikke bruges.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["mitid_app_ip", ip]]))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const bruger = await bearerBruger(req);
  if (!bruger) return svar(401, IKKE_LOGGET_IND);

  const krop = await jsonKrop(req);
  const k = typeof krop?.k === "string" ? krop.k : "";
  const hemmelighed = typeof krop?.hemmelighed === "string" ? krop.hemmelighed : "";
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(k) || hemmelighed.length < 32 || hemmelighed.length > 256) {
    return svar(400, UGYLDIG);
  }

  try {
    const { data, error } = await createAdminClient().rpc("mitid_app_afslut", {
      p_bruger: bruger.id,
      p_afslut_hash: sha256Hex(k),
      p_hemmelighed_hash: sha256Hex(hemmelighed),
    });
    if (error) throw error;
    const kode = (data as { kode?: string } | null)?.kode;
    const status = kode === "udloebet" ? "udloebet" : resultatFraKode(kode);
    return svar(200, { status, besked: MITID.resultat[status] });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/mitid/app/afslut", fejl: err, brugerId: bruger.id });
    return svar(500, { fejl: "Noget gik galt – prøv igen.", kode: "fejl" });
  }
}
