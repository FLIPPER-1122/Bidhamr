import type { NextRequest } from "next/server";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { createAdminClient } from "@/lib/supabase/admin";
import { offentligNoegle } from "@/lib/supabase/noegler";
import {
  APP_GENERISK,
  APP_IKKE_LOGGET_IND,
  appBruger,
  appSvar,
  bearerToken,
  fremmedOrigin,
  laesJsonKrop,
} from "@/lib/appApi";
import { skiftAdgangskodeFor, type AuthFejlInfo } from "@/lib/adgangskodeSkift";

// Skift adgangskode fra appen. Samme kode som "Skift adgangskode" på /konto
// (src/lib/adgangskodeSkift.ts): den nuværende adgangskode tjekkes, samme
// styrkekrav, andre enheder logges ud (denne enhed beholder sin session), og
// brugeren får en sikkerhedsmail. Dokumentation: docs/APP-ENDPOINTS.md.
//
// POST /api/konto/adgangskode
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   { nuvaerende, ny }
//   200 { ok: true }
//   400 { fejl, kode: "ugyldig" | "adgangskode" | "samme_adgangskode" }
//   401 { fejl, kode: "ikke_logget_ind" }
//   403 { fejl, kode: "forkert_adgangskode" | "genlog_ind" | "ikke_tilladt" }
//   429 { fejl, kode: "for_mange" }   500 { fejl, kode: "fejl" }
//
// Sikkerhed: kun Bearer-token (ingen cookies, ingen CSRF), en fremmed Origin
// afvises, grænser pr. IP og pr. bruger (adgangskode_bruger som hjemmesiden).

export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
  adgangskode: 400,
  samme_adgangskode: 400,
  forkert_adgangskode: 403,
  genlog_ind: 403,
  for_mange: 429,
  fejl: 500,
};

// Supabase Auth: PUT /auth/v1/user med brugerens eget token - det samme,
// som supabase.auth.updateUser gør med en cookie-session på hjemmesiden.
async function saetMedToken(token: string, ny: string): Promise<AuthFejlInfo | null> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: offentligNoegle(),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: ny }),
    cache: "no-store",
  });
  if (res.ok) return null;
  const j = (await res.json().catch(() => ({}))) as { code?: unknown; error_code?: unknown; msg?: unknown; message?: unknown };
  const code = typeof j.error_code === "string" ? j.error_code : typeof j.code === "string" ? j.code : null;
  const message = typeof j.msg === "string" ? j.msg : typeof j.message === "string" ? j.message : null;
  return { code, status: res.status, message };
}

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
  const { nuvaerende, ny } = k.krop;
  if (typeof nuvaerende !== "string" || typeof ny !== "string") {
    return appSvar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }

  const login = await appBruger(token);
  if (!login) return appSvar(401, APP_IKKE_LOGGET_IND);
  const { bruger } = login;

  try {
    const r = await skiftAdgangskodeFor({
      bruger,
      nuvaerende,
      ny,
      saetAdgangskode: (kode) => saetMedToken(token, kode),
      // Andre enheder logges ud - denne bliver logget ind.
      logUdAndre: async () => (await createAdminClient().auth.admin.signOut(token, "others")).error,
    });
    if ("fejl" in r) return appSvar(STATUS[r.kode] ?? 400, { fejl: r.fejl, kode: r.kode });
    return appSvar(200, { ok: true });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/konto/adgangskode", fejl: err, brugerId: bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}
