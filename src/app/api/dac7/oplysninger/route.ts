import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { klientIp, indenForGraense, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { gemSkatteoplysninger, hentMitMaskeredeCpr } from "@/lib/dac7/server";
import { DAC7 } from "@/lib/dac7/tekster";

// Appens DAC7-skatteoplysninger (samme kode som Min konto → Skatteoplysninger
// på hjemmesiden, src/lib/dac7/server.ts). CPR krypteres på serveren - appen
// sender det kun hertil over HTTPS og gemmer det aldrig selv.
//
// Status (antal salg, grænser, anmodning, kopier) henter appen direkte med
// supabase.rpc("dac7_min_status") - se docs/DAC7.md.
//
// GET  /api/dac7/oplysninger          Authorization: Bearer <access token>
//   200 { cpr: "010190-••••" | null }  (maskeret - kun fødselsdato-delen)
// POST /api/dac7/oplysninger          Authorization: Bearer <access token>
//   Content-Type: application/json
//   { adresse, postnummer, bynavn, cpr?, andetTinLand?, andetTinNummer?,
//     beholdAndetTin?: boolean, bopaelDk: true, bekraeft: true }
//   bopaelDk skal være true (kun sælgere med bopæl i Danmark - ellers
//   400 { kode: "udland" }).
//   cpr tom/udeladt = behold det gemte. beholdAndetTin = behold et gemt
//   skatte-id fra et andet EU-land uændret.
//   200 { ok: true }
//   400 { fejl, kode: "ugyldig", felt? } | { fejl, kode: "mitid" | "erhverv" | "udland" }
//   401 { fejl, kode: "ikke_logget_ind" }   413 { fejl, kode: "ugyldig" }
//   429 { fejl, kode: "for_mange" }         503 { fejl, kode: "ikke_tilgaengelig" }
//   500 { fejl, kode: "fejl" }
//
// Sikkerhed (som /api/firma/skift-pakke): kun Bearer-token - cookies bruges
// ikke (ingen CSRF); en fremmed Origin afvises. Brugeren findes ud fra
// tokenet, aldrig fra kroppen. Rate limit pr. IP og pr. bruger. CPR logges
// aldrig. Proxyen lukker stien igennem uden cookie-login
// (src/lib/supabase/middleware.ts).

export const dynamic = "force-dynamic";

const MAKS_KROP = 2048;

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

const IKKE_LOGGET_IND = { fejl: DAC7.fejl.ikkeLoggetInd, kode: "ikke_logget_ind" };

async function bruger(req: NextRequest): Promise<string | "for_mange" | null> {
  const ip = await klientIp();
  if (!(await indenForGraense("dac7_app_ip", ip))) return "for_mange";
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    (req.headers.get("authorization") ?? "").trim(),
  );
  if (!m) return null;
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.getUser(m[1]);
  return error || !data?.user ? null : data.user.id;
}

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

export async function GET(req: NextRequest) {
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });
  const id = await bruger(req);
  if (id === "for_mange") return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  if (!id) return svar(401, IKKE_LOGGET_IND);
  try {
    return svar(200, { cpr: await hentMitMaskeredeCpr(id) });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/dac7/oplysninger", fejl: err, brugerId: id });
    return svar(500, { fejl: DAC7.fejl.generisk, kode: "fejl" });
  }
}

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }
  const laengde = req.headers.get("content-length");
  if (laengde !== null && !(/^\d{1,6}$/.test(laengde) && Number(laengde) <= MAKS_KROP)) {
    return svar(413, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }
  const id = await bruger(req);
  if (id === "for_mange") return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  if (!id) return svar(401, IKKE_LOGGET_IND);
  if (!(await indenForGraense("dac7_gem_bruger", id))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  let krop: Record<string, unknown>;
  try {
    const raa = await laesBegraenset(req, MAKS_KROP);
    if (raa === null) return svar(413, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
    krop = JSON.parse(raa) as Record<string, unknown>;
    if (!krop || typeof krop !== "object" || Array.isArray(krop)) throw new Error("ikke et objekt");
  } catch {
    return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }

  try {
    const res = await gemSkatteoplysninger(id, {
      adresse: krop.adresse,
      postnummer: krop.postnummer,
      bynavn: krop.bynavn,
      cpr: krop.cpr,
      andetTinLand: krop.andetTinLand,
      andetTinNummer: krop.andetTinNummer,
      beholdAndetTin: krop.beholdAndetTin === true,
      bopaelDk: krop.bopaelDk === true,
      bekraeft: krop.bekraeft === true,
    });
    if ("ok" in res) return svar(200, res);
    return svar(res.kode === "ikke_tilgaengelig" ? 503 : 400, res);
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/dac7/oplysninger", fejl: err, brugerId: id });
    return svar(500, { fejl: DAC7.fejl.generisk, kode: "fejl" });
  }
}
