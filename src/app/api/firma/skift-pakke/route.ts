import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { skiftPakkeForBruger } from "@/lib/erhverv/pakkeskift";

// Pakkeskift for en firmakonto direkte fra appen. Samme regler og samme kode
// som Firma oversigt på hjemmesiden (src/lib/erhverv/pakkeskift.ts): databasen
// OG abonnementet i Stripe ændres, og fejler Stripe, rulles skiftet tilbage.
// (firma_skift_pakke kan ikke længere kaldes direkte med supabase.rpc.)
//
// POST /api/firma/skift-pakke
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   { "pakkeId": "<uuid>" }
//
// Svar (JSON) - samme felter som hjemmesiden:
//   200 { ok: true, kode: "opgraderet" | "opgradering_afventer_betaling" |
//         "betal_forskellen" (url = Stripes fakturaside, åbn i browser) |
//         "nedgradering_planlagt" (gaelderFra) | "uaendret", besked, pakke? }
//   400 { fejl, kode: "ugyldig" | "ugyldig_pakke" }
//   401 { fejl, kode: "ikke_logget_ind" }
//   403 { fejl, kode: "ikke_tilladt" }       (ikke firmakonto / ikke aktiv)
//   409 { fejl, kode: "betal_foerst" | "stripe_fejl" }  (pakken er uændret)
//   429 { fejl, kode: "for_mange" }
//   500 { fejl, kode: "fejl" }
//
// Sikkerhed (som /api/konto/slet): kun Bearer-token - cookies bruges ikke
// (ingen CSRF); ingen CORS-headere, og en fremmed Origin afvises. Brugeren
// findes ud fra tokenet, aldrig fra kroppen. Rate limit pr. IP her og pr.
// bruger i databasen. Proxyen lukker stien igennem uden cookie-login
// (src/lib/supabase/middleware.ts).

export const dynamic = "force-dynamic";

function svar(status: number, krop: Record<string, unknown>) {
  return NextResponse.json(krop, { status, headers: { "Cache-Control": "no-store" } });
}

function fremmedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const vaert = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host !== vaert;
  } catch {
    return true;
  }
}

const IKKE_LOGGET_IND = { fejl: "Du er ikke logget ind længere. Log ind igen.", kode: "ikke_logget_ind" };

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["firma_skift_pakke_ip", ip]]))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth.trim());
  if (!m) return svar(401, IKKE_LOGGET_IND);

  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }
  let krop: { pakkeId?: unknown };
  try {
    const raa = await req.text();
    if (raa.length > 1024) return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
    krop = JSON.parse(raa) as typeof krop;
    if (!krop || typeof krop !== "object") throw new Error("ikke et objekt");
  } catch {
    return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: brugerData, error: brugerFejl } = await supabase.auth.getUser(m[1]);
  const bruger = brugerData?.user;
  if (brugerFejl || !bruger) return svar(401, IKKE_LOGGET_IND);

  try {
    const res = await skiftPakkeForBruger(bruger.id, krop.pakkeId);
    if ("ok" in res) return svar(200, res);
    const status =
      res.kode === "ugyldig_pakke" ? 400
      : res.kode === "ikke_tilladt" ? 403
      : res.kode === "betal_foerst" || res.kode === "stripe_fejl" ? 409
      : res.kode === "for_mange" ? 429
      : 500;
    return svar(status, { fejl: res.fejl, kode: res.kode ?? "fejl" });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/firma/skift-pakke", fejl: err, brugerId: bruger.id });
    return svar(500, { fejl: "Noget gik galt. Prøv igen om lidt.", kode: "fejl" });
  }
}
