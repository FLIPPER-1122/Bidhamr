import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG, type GraenseNavn } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import {
  annullerPakke,
  bookPakke,
  hentCheckout,
  hentForsendelser,
  hentLabelLink,
  gemLevering,
  lavReturlabel,
  soegPakkeshops,
} from "@/lib/fragt/handlinger";

// Fragt fra appen (Expo). Samme kode som hjemmesidens server actions
// (src/lib/fragt/handlinger.ts). Dokumentation: docs/FRAGT.md.
//
// POST /api/fragt/app/<handling>
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   pakkeshops   { postnummer, adresse?, by?, antal? }
//   checkout     { trade_id }
//   levering     { trade_id, maade: "pakkeshop" | "doer", pakkeshop_id?, pakkeshop_postnummer?, pakkeshop_adresse?,
//                  modtager: { navn, adresse?, postnummer?, by?, telefon }, gem_forslag? }
//   book         { trade_id, afsender?: { navn, adresse, postnummer, by, telefon? } }
//   annuller     { trade_id, forsendelse_id }
//   forsendelser { trade_id }
//   label        { forsendelse_id }   -> { url } (gyldig i 5 minutter)
//   retur        { trade_id, afsender: { navn, adresse, postnummer, by, telefon } }
//
// Svar: 200 { ok: true, ... } | 400/409 { fejl, kode } | 401 | 403 | 404 | 413 | 429 | 500.
// En forretningsfejl (fx "Vælg en pakkeshop.") gives som 409 { fejl, kode: "afvist" }
// med en dansk tekst, der kan vises direkte.
//
// Sikkerhed (som /api/betaling/kort): kun Bearer-token - cookies bruges ikke
// (ingen CSRF); ingen CORS-headere, og en fremmed Origin afvises. Brugeren
// findes ud fra tokenet, aldrig fra kroppen. Rate limit pr. IP og pr. bruger.
// Proxyen lukker stien igennem uden cookie-login (src/lib/supabase/middleware.ts).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HANDLINGER = ["pakkeshops", "checkout", "levering", "book", "annuller", "forsendelser", "label", "retur"] as const;
type Handling = (typeof HANDLINGER)[number];

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UGYLDIG = { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" };
const IKKE_LOGGET_IND = { fejl: "Du er ikke logget ind længere. Log ind igen.", kode: "ikke_logget_ind" };
const MAKS_KROP = 4096;

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

function resultat(r: { fejl: string } | Record<string, unknown>) {
  if ("fejl" in r && typeof r.fejl === "string") return svar(409, { fejl: r.fejl, kode: "afvist" });
  return svar(200, { ...r, ok: true });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ handling: string }> }) {
  const { handling: h } = await params;
  if (!(HANDLINGER as readonly string[]).includes(h)) return svar(404, { fejl: "Ukendt handling.", kode: "ugyldig" });
  const handling = h as Handling;
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["fragt_app_ip", ip]]))) {
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
  let krop: Record<string, unknown>;
  try {
    const raa = await laesBegraenset(req, MAKS_KROP);
    if (raa === null) return svar(413, UGYLDIG);
    const j = JSON.parse(raa || "{}") as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("ikke et objekt");
    krop = j as Record<string, unknown>;
  } catch {
    return svar(400, UGYLDIG);
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: brugerData, error: brugerFejl } = await supabase.auth.getUser(m[1]);
  const bruger = brugerData?.user;
  if (brugerFejl || !bruger) return svar(401, IKKE_LOGGET_IND);

  const graense: GraenseNavn = handling === "pakkeshops" ? "fragt_pakkeshop_bruger" : "fragt_handling_bruger";
  // Læsninger tæller ikke mod handlingsgrænsen.
  if (!["checkout", "forsendelser", "label"].includes(handling)) {
    if (!(await tjekGraenser([[graense, bruger.id]]))) {
      return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
    }
  }

  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

  try {
    switch (handling) {
      case "pakkeshops":
        return resultat(await soegPakkeshops({
          postnummer: krop.postnummer,
          adresse: krop.adresse,
          by: krop.by,
          antal: krop.antal,
        }));
      case "checkout":
        return resultat(await hentCheckout(krop.trade_id, bruger.id));
      case "levering":
        return resultat(await gemLevering(krop.trade_id, bruger.id, {
          maade: krop.maade,
          pakkeshopId: krop.pakkeshop_id,
          pakkeshopPostnummer: krop.pakkeshop_postnummer,
          pakkeshopAdresse: krop.pakkeshop_adresse,
          modtager: obj(krop.modtager),
          gemForslag: krop.gem_forslag,
        }));
      case "book":
        return resultat(await bookPakke(krop.trade_id, bruger.id, obj(krop.afsender)));
      case "annuller":
        return resultat(await annullerPakke(krop.trade_id, krop.forsendelse_id, bruger.id));
      case "forsendelser":
        return resultat(await hentForsendelser(krop.trade_id, bruger.id));
      case "label":
        return resultat(await hentLabelLink(krop.forsendelse_id, bruger.id));
      case "retur":
        return resultat(await lavReturlabel(krop.trade_id, bruger.id, obj(krop.afsender)));
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: `/api/fragt/app/${handling}`, fejl: err, brugerId: bruger.id });
    return svar(500, { fejl: GENERISK, kode: "fejl" });
  }
}
