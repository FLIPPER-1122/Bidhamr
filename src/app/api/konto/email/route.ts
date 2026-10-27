import type { NextRequest } from "next/server";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { APP_GENERISK, APP_IKKE_LOGGET_IND, appBruger, appSvar, bearerToken, fremmedOrigin, laesJsonKrop } from "@/lib/appApi";
import { anmodEmailSkiftFor } from "@/lib/emailSkift";
import { EMAIL_SKIFT_STATUS } from "./status";

// Skift af e-mail fra appen, trin 1. Samme kode som Indstillinger på
// hjemmesiden (src/lib/emailSkift.ts). Dokumentation: docs/APP-ENDPOINTS.md.
//
// POST /api/konto/email
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   { ny_email, adgangskode }
//   200 { ok: true, besked }  - ALTID ved rigtig adgangskode og gyldig adresse,
//                               også når adressen er i brug (så sendes intet)
//   400 { fejl, kode: "ugyldig" | "email" | "samme_email" }
//   401 { fejl, kode: "ikke_logget_ind" }
//   403 { fejl, kode: "forkert_adgangskode" | "staff" | "firma" | "suspenderet" | "lukket" | "slettet" | "ikke_tilladt" }
//   429 { fejl, kode: "for_mange" }   503 { kode: "ikke_tilgaengelig" }   500 { kode: "fejl" }
//
// Sikkerhed: kun Bearer-token (ingen cookies, ingen CSRF), en fremmed Origin
// afvises, grænser pr. IP (konto_app_ip) og pr. bruger/adresse (som
// hjemmesiden).

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["konto_app_ip", ip]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const token = bearerToken(req);
  if (!token) return appSvar(401, APP_IKKE_LOGGET_IND);

  const k = await laesJsonKrop(req, 2048);
  if ("svar" in k) return k.svar;
  const { ny_email, adgangskode } = k.krop;
  if (typeof ny_email !== "string" || typeof adgangskode !== "string") {
    return appSvar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }

  const login = await appBruger(token);
  if (!login) return appSvar(401, APP_IKKE_LOGGET_IND);
  const { bruger } = login;

  try {
    const r = await anmodEmailSkiftFor({ bruger, nyEmail: ny_email, adgangskode });
    if ("fejl" in r) return appSvar(EMAIL_SKIFT_STATUS[r.kode] ?? 400, { fejl: r.fejl, kode: r.kode });
    return appSvar(200, { ok: true, besked: r.besked });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/konto/email", fejl: err, brugerId: bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}
