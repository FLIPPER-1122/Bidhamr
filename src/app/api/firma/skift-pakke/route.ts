import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { skiftPakkeForBruger } from "@/lib/erhverv/pakkeskift";
import { velkomstSkiftForPakke } from "@/lib/erhverv/betaling";

// Pakkeskift for en firmakonto direkte fra appen. Samme regler og samme kode
// som Firma oversigt på hjemmesiden (src/lib/erhverv/pakkeskift.ts): databasen
// OG abonnementet i Stripe ændres, og fejler Stripe, rulles skiftet tilbage.
// (firma_skift_pakke kan ikke længere kaldes direkte med supabase.rpc.)
//
// GET /api/firma/skift-pakke?til=<pakke-uuid>
//   Authorization: Bearer <Supabase access token>
//   Hvad et skift til pakken koster NU - samme regel og samme tal, som
//   serveren bruger, når der trykkes (velkomstSkiftUdfald). Kald det, før
//   bekræftelsen vises, og send "visning" med i POST'en.
//   200 { ok: true, pakke: { id, navn }, velkomstSkift: false }
//         Ikke et skift op fra Starts gratis måned: de almindelige regler
//         gælder, og POST'en kræver ingen visning.
//   200 { ok: true, pakke: { id, navn }, velkomstSkift: true,
//         udfald: "skift" | "venter" | "ret_rabat",
//         visning: "velkomst:50" | "intro:30" | "intro:30:skift" | "saerpris:0" | "venter" | "ret_rabat",
//         rabat: { slags: "velkomst", procent }
//              | { slags: "intro", procent, til: "31. marts 2027" | null, maaneder }
//              | { slags: "saerpris", procent: 0 } | null,
//         beloeb: { eksklOere, inklOere } | null   (det, der trækkes i dag; kun ved "skift"),
//         kanSkifte: boolean                      (false ved ret_rabat, og når pakken
//                                                  ingen pris har - vis ingen knap),
//         tekst: "<bekræftelsen på dansk>", knap: "<knaptekst>" | "" }
//   "Skift op" afgøres med databasens rang (erhverv_pakke_rang; en arkiveret
//   nuværende pakke er mindst) - samme regel som POST'en, så velkomstSkift:
//   false aldrig efterfølges af 409 visning_mangler.
//   400 { fejl, kode: "ugyldig_pakke" }  (ukendt, inaktiv eller arkiveret pakke - som POST'en)
//   401 ikke_logget_ind  403 ikke_tilladt (ikke firmakonto)
//   429 { fejl, kode: "for_mange" }      500 { fejl, kode: "fejl" } (fx Stripe nede - vis ikke et beløb)
//
// POST /api/firma/skift-pakke
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   { "pakkeId": "<uuid>", "visning"?: "velkomst:50" | "intro:30" | "intro:30:skift" | "saerpris:0" | "venter" | "ret_rabat" }
//   visning: feltet "visning" fra GET'en. KRÆVET ved et skift op fra Starts
//   gratis måned (velkomstSkift: true) - mangler den, afvises skiftet (409
//   visning_mangler), før noget ændres. Er rabatten ændret siden GET'en,
//   afvises skiftet (409 pris_aendret), før noget trækkes. Ved andre skift
//   bruges den ikke - men den tjekkes ALTID: en sendt, ugyldig visning giver
//   400 ugyldig_visning ved alle skift, før noget ændres (også hjemmesiden).
//   Send den derfor kun, når GET'en gav velkomstSkift: true.
//
// Svar (JSON) - samme felter som hjemmesiden:
//   200 { ok: true, kode: "opgraderet" | "opgradering_afventer_betaling" |
//         "betal_forskellen" (url = Stripes fakturaside, åbn i browser) |
//         "nedgradering_planlagt" (gaelderFra) | "skiftet" | "uaendret", besked, pakke? }
//   400 { fejl, kode: "ugyldig" | "ugyldig_pakke" | "ugyldig_visning" }
//   413 { fejl, kode: "ugyldig" }            (kroppen er over 1 KB)
//   401 { fejl, kode: "ikke_logget_ind" }
//   403 { fejl, kode: "ikke_tilladt" }       (ikke firmakonto / ikke aktiv /
//                                             spærret konto / opsagt)
//   409 { fejl, kode: "i_gang" }             (et andet pakkeskift er i gang)
//   409 { fejl, kode: "betal_foerst" | "stripe_fejl" }  (pakken er uændret)
//   409 Skift op fra den gratis måned afvist - der er IKKE trukket noget:
//       { fejl, kode: "pris_aendret" }      prisen er ændret: hent GET igen, vis den nye pris
//       { fejl, kode: "rabat_venter" }      introrabatten er sat op (eller sættes op): hent GET igen
//       { fejl, kode: "ret_rabat" }         rabatten skal rettes af BidHamr (vis fejl, ingen knap)
//       { fejl, kode: "visning_mangler" }   visning blev ikke sendt: hent GET, og send den med
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
  let krop: { pakkeId?: unknown; visning?: unknown };
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
    const res = await skiftPakkeForBruger(bruger.id, krop.pakkeId, krop.visning);
    if ("ok" in res) return svar(200, res);
    return svar(statusForKode(res.kode), { fejl: res.fejl, kode: res.kode ?? "fejl" });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/firma/skift-pakke", fejl: err, brugerId: bruger.id });
    return svar(500, { fejl: "Noget gik galt. Prøv igen om lidt.", kode: "fejl" });
  }
}

// HTTP-status for skiftPakkeForBruger's fejlkoder.
const KONFLIKT = new Set(["betal_foerst", "stripe_fejl", "i_gang", "pris_aendret", "rabat_venter", "ret_rabat", "visning_mangler"]);
function statusForKode(kode: string | undefined): number {
  if (kode === "ugyldig_pakke" || kode === "ugyldig_visning") return 400;
  if (kode === "ikke_tilladt") return 403;
  if (kode && KONFLIKT.has(kode)) return 409;
  if (kode === "for_mange") return 429;
  return 500;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["firma_skift_pakke_vis_ip", ip]]))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth.trim());
  if (!m) return svar(401, IKKE_LOGGET_IND);

  const til = req.nextUrl.searchParams.get("til") ?? "";
  if (!UUID.test(til)) return svar(400, { fejl: "Vælg en pakke.", kode: "ugyldig_pakke" });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: brugerData, error: brugerFejl } = await supabase.auth.getUser(m[1]);
  const bruger = brugerData?.user;
  if (brugerFejl || !bruger) return svar(401, IKKE_LOGGET_IND);
  if (!(await tjekGraenser([["firma_skift_pakke_vis_bruger", bruger.id]]))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  try {
    const res = await velkomstSkiftForPakke(bruger.id, til);
    if (res.status === "ikke_firma") return svar(403, { fejl: "Kun firmakonti kan skifte pakke.", kode: "ikke_tilladt" });
    if (res.status === "ugyldig_pakke") return svar(400, { fejl: "Pakken findes ikke længere. Vælg en anden.", kode: "ugyldig_pakke" });
    if (!res.tilbud) return svar(200, { ok: true, pakke: res.pakke, velkomstSkift: false });
    return svar(200, { ok: true, pakke: res.pakke, velkomstSkift: true, ...res.tilbud });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/firma/skift-pakke", hvor: "GET", fejl: err, brugerId: bruger.id });
    return svar(500, { fejl: "Vi kunne ikke hente prisen lige nu. Prøv igen om lidt.", kode: "fejl" });
  }
}
