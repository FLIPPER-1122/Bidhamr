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
//   413 { fejl, kode: "ugyldig" }            (kroppen er over 1 KB)
//   401 { fejl, kode: "ikke_logget_ind" }
//   403 { fejl, kode: "ikke_tilladt" }       (ikke firmakonto / ikke aktiv /
//                                             spærret konto / opsagt)
//   409 { fejl, kode: "i_gang" }             (et andet pakkeskift er i gang)
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

const MAKS_KROP = 1024;

// Læser højst `maks` bytes; null hvis kroppen er større (læsningen afbrydes).
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
  // Længden tjekkes FØR kroppen læses: først Content-Length, og derefter
  // læses højst MAKS_KROP bytes fra strømmen (også uden Content-Length).
  const laengde = req.headers.get("content-length");
  if (laengde !== null && !(/^\d{1,6}$/.test(laengde) && Number(laengde) <= MAKS_KROP)) {
    return svar(413, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }
  let krop: { pakkeId?: unknown };
  try {
    const raa = await laesBegraenset(req, MAKS_KROP);
    if (raa === null) return svar(413, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
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
      : res.kode === "betal_foerst" || res.kode === "stripe_fejl" || res.kode === "i_gang" ? 409
      : res.kode === "for_mange" ? 429
      : 500;
    return svar(status, { fejl: res.fejl, kode: res.kode ?? "fejl" });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/firma/skift-pakke", fejl: err, brugerId: bruger.id });
    return svar(500, { fejl: "Noget gik galt. Prøv igen om lidt.", kode: "fejl" });
  }
}
