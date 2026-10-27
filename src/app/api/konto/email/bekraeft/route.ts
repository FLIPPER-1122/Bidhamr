import type { NextRequest } from "next/server";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_GENERISK, APP_IKKE_LOGGET_IND, appBruger, appSvar, bearerToken, fremmedOrigin, laesJsonKrop } from "@/lib/appApi";
import { bekraeftEmailSkiftFor } from "@/lib/emailSkift";
import { EMAIL_SKIFT_STATUS } from "../status";

// Skift af e-mail fra appen, trin 2: koden fra mailen til den nye adresse.
// Samme kode som hjemmesiden (src/lib/emailSkift.ts). Dokumentation:
// docs/APP-ENDPOINTS.md.
//
// POST /api/konto/email/bekraeft
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   { kode: "123456" }
//   200 { ok: true, email }  - e-mailen er skiftet. Andre enheder er logget
//                              ud; denne session gælder stadig. Appen kalder
//                              supabase.auth.refreshSession(), så tokenet får
//                              den nye e-mail.
//   400 { fejl, kode: "ugyldig" | "kode_forkert" | "kode_udloebet" }
//   401 { fejl, kode: "ikke_logget_ind" }
//   403 { fejl, kode: "staff" | "suspenderet" | "lukket" | "slettet" | "ikke_tilladt" }
//   409 { fejl, kode: "optaget" }  - adressen blev taget, før koden blev brugt
//   429 { fejl, kode: "for_mange" }   503 { kode: "ikke_tilgaengelig" }   500 { kode: "fejl" }

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["konto_app_ip", ip]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const token = bearerToken(req);
  if (!token) return appSvar(401, APP_IKKE_LOGGET_IND);

  const k = await laesJsonKrop(req, 1024);
  if ("svar" in k) return k.svar;
  const { kode } = k.krop;
  if (typeof kode !== "string") return appSvar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });

  const login = await appBruger(token);
  if (!login) return appSvar(401, APP_IKKE_LOGGET_IND);
  const { bruger } = login;

  try {
    const r = await bekraeftEmailSkiftFor({
      bruger,
      kode,
      // Andre enheder logges ud - denne bliver logget ind.
      logUdAndre: async () => (await createAdminClient().auth.admin.signOut(token, "others")).error,
    });
    if ("fejl" in r) return appSvar(EMAIL_SKIFT_STATUS[r.kode] ?? 400, { fejl: r.fejl, kode: r.kode });
    return appSvar(200, { ok: true, email: r.email });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/konto/email/bekraeft", fejl: err, brugerId: bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}
