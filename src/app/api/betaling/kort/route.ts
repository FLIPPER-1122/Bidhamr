import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { fjernGemtKortForBruger } from "@/lib/betaling/kort";

// "Fjern kort" direkte fra appen. Samme kode som Min konto på hjemmesiden
// (src/lib/betaling/kort.ts). Appen kan ikke selv ændre betalingsprofiler
// (authenticated har kun select).
//
// POST /api/betaling/kort
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   { "handling": "fjern-kort" }
//     - fjerner det gemte kort (også hos Stripe).
//
// Automatisk betaling findes ikke længere (Filip, 9. okt. 2026): alle vindere
// betaler selv på checkout-siden. { "handling": "autobetaling", ... } svarer
// 410 { fejl, kode: "findes_ikke" }, og intet ændres.
//
// Svar (JSON):
//   200 { ok: true }
//   400 { fejl, kode: "ugyldig" }            (forkert krop)
//   410 { fejl, kode: "findes_ikke" }        (handlingen "autobetaling")
//   401 { fejl, kode: "ikke_logget_ind" }
//   403 { fejl, kode: "ikke_tilladt" }       (fremmed Origin)
//   413 { fejl, kode: "ugyldig" }            (kroppen er over 1 KB)
//   429 { fejl, kode: "for_mange" }
//   500 { fejl, kode: "fejl" }
//
// Sikkerhed (som /api/firma/skift-pakke): kun Bearer-token - cookies bruges
// ikke (ingen CSRF); ingen CORS-headere, og en fremmed Origin afvises.
// Brugeren findes ud fra tokenet, aldrig fra kroppen. Rate limit pr. IP.
// Proxyen lukker stien igennem uden cookie-login (src/lib/supabase/middleware.ts).

export const dynamic = "force-dynamic";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UGYLDIG = { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" };
const IKKE_LOGGET_IND = { fejl: "Du er ikke logget ind længere. Log ind igen.", kode: "ikke_logget_ind" };
const FINDES_IKKE = {
  fejl: "Automatisk betaling findes ikke længere. Når du vinder, betaler du selv på betalingssiden – har du gemt et kort, er det valgt på forhånd dér.",
  kode: "findes_ikke",
};
const MAKS_KROP = 1024;

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

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["betaling_kort_ip", ip]]))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth.trim());
  if (!m) return svar(401, IKKE_LOGGET_IND);

  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return svar(400, UGYLDIG);
  }
  const laengde = req.headers.get("content-length");
  if (laengde !== null && !(/^\d{1,6}$/.test(laengde) && Number(laengde) <= MAKS_KROP)) {
    return svar(413, UGYLDIG);
  }
  let krop: { handling?: unknown };
  try {
    const raa = await laesBegraenset(req, MAKS_KROP);
    if (raa === null) return svar(413, UGYLDIG);
    krop = JSON.parse(raa) as typeof krop;
    if (!krop || typeof krop !== "object") throw new Error("ikke et objekt");
  } catch {
    return svar(400, UGYLDIG);
  }
  // Ældre app-versioner: klar besked i stedet for en generisk fejl.
  if (krop.handling === "autobetaling") return svar(410, FINDES_IKKE);
  if (krop.handling !== "fjern-kort") return svar(400, UGYLDIG);

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: brugerData, error: brugerFejl } = await supabase.auth.getUser(m[1]);
  const bruger = brugerData?.user;
  if (brugerFejl || !bruger) return svar(401, IKKE_LOGGET_IND);
  if (!(await tjekGraenser([["betaling_kort_bruger", bruger.id]]))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  try {
    await fjernGemtKortForBruger(bruger.id);
    return svar(200, { ok: true });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/betaling/kort", fejl: err, brugerId: bruger.id });
    return svar(500, { fejl: GENERISK, kode: "fejl" });
  }
}
