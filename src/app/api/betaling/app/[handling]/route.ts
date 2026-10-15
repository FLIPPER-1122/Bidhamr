import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { createAdminClient } from "@/lib/supabase/admin";
import { fjernGemtKortForBruger } from "@/lib/betaling/kort";
import { gemLevering } from "@/lib/fragt/handlinger";
import {
  GENERISK,
  bekraeftGemtKortFor,
  hentBetalingsindstillingerFor,
  opdaterSaelgerStatusFor,
  startBetalingFor,
  startGemKortFor,
  startOnboardingFor,
  stripeOversigtFor,
  type HandlingsFejl,
} from "@/lib/betaling/betalingHandlinger";
import { brugBoost, startBoostKoeb, type BoostStartFejl } from "@/lib/betaling/boost";

// Betaling fra appen (Expo). Samme kode som hjemmesidens server actions
// (src/lib/betaling/betalingHandlinger.ts). Dokumentation: docs/APP-BETALING.md.
//
// POST /api/betaling/app/<handling>
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   betal                    { trade_id, levering? }  -> PaymentSheet-data + saelgerNavn
//                            levering.transportoer: "dao" | "gls" | "postnord" (valgfri)
//   indstillinger            {}                       -> gemt kort + udbetalingskontoens status
//   gem-kort                 {}                       -> SetupIntent til PaymentSheet
//   bekraeft-kort            { setup_intent_id }
//   fjern-kort               {}
//   udbetalingskonto         {}                       -> Stripes onboarding-link (åbnes i in-app browser)
//   udbetalingskonto-status  {}                       -> henter status frisk fra Stripe
//   stripe-oversigt          {}                       -> engangs-link til Stripes Express Dashboard
//   boost-koeb               { samtykke? }            -> PaymentSheet-data til køb af boost-point
//   boost-brug               { auktion_id, noegle }   -> booster egen auktion (noegle: uuid, samme = samme boost)
//
// Sikkerhed (som /api/fragt/app): kun Bearer-token - cookies bruges ikke
// (ingen CSRF); ingen CORS-headere, og en fremmed Origin afvises. Brugeren
// findes ud fra tokenet, aldrig fra kroppen. Rate limit pr. IP og pr. bruger.
// Svarene indeholder kun client secrets til den indloggede bruger selv og den
// offentlige nøgle - aldrig hemmelige nøgler.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// betal med levering kan slå pakkeshoppen op hos fragtfirmaet (op til 15 s).
export const maxDuration = 60;

const HANDLINGER = [
  "betal",
  "indstillinger",
  "gem-kort",
  "bekraeft-kort",
  "fjern-kort",
  "udbetalingskonto",
  "udbetalingskonto-status",
  "stripe-oversigt",
  "boost-koeb",
  "boost-brug",
] as const;
type Handling = (typeof HANDLINGER)[number];

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

const STATUS: Record<HandlingsFejl["kode"], number> = {
  betalt: 409,
  vaelg_levering: 409,
  venter: 409,
  pause: 503,
  afvist: 409,
  ikke_fundet: 404,
  fejl: 500,
};

const BOOST_KOEB_STATUS: Record<BoostStartFejl["kode"], number> = {
  ugyldig: 400,
  ikke_fundet: 404,
  erhverv: 403,
  spaerret: 403,
  samtykke: 409,
  pause: 503,
  betalt: 409,
  fejl: 500,
};

const BOOST_BRUG_STATUS: Record<string, number> = {
  ugyldig: 400,
  ikke_fundet: 404,
  ikke_ejer: 403,
  erhverv: 403,
  spaerret: 403,
  laast: 409,
  boostet: 409,
  for_faa_point: 409,
  ikke_aktiv: 409,
  slutter_snart: 409,
  fejl: 500,
};

function fejlSvar(r: HandlingsFejl) {
  return svar(STATUS[r.kode] ?? 500, { fejl: r.fejl, kode: r.kode });
}

// Den offentlige nøgle (pk_test_/pk_live_) til StripeProvider i appen.
function offentligStripeNoegle(): string | null {
  const k = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
  return /^pk_(test|live)_[A-Za-z0-9]+$/.test(k) ? k : null;
}

// Sælgerens visningsnavn (users.navn - som hjemmesidens checkout viser
// "Sælger: X"). Kun efter at startBetalingFor har godkendt køberen.
async function saelgerNavnForHandel(tradeId: unknown): Promise<string | null> {
  if (typeof tradeId !== "string") return null;
  const admin = createAdminClient();
  const { data: t } = await admin.from("trades").select("seller_id").eq("id", tradeId).maybeSingle<{ seller_id: string }>();
  if (!t) return null;
  const { data: u } = await admin.from("users").select("navn").eq("id", t.seller_id).maybeSingle<{ navn: string | null }>();
  return u?.navn ?? null;
}

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export async function POST(req: NextRequest, { params }: { params: Promise<{ handling: string }> }) {
  const { handling: h } = await params;
  if (!(HANDLINGER as readonly string[]).includes(h)) return svar(404, { fejl: "Ukendt handling.", kode: "ugyldig" });
  const handling = h as Handling;
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["betaling_app_ip", ip]]))) {
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
    if (!obj(j)) throw new Error("ikke et objekt");
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
  if (handling !== "indstillinger" && !(await tjekGraenser([["betaling_app_bruger", bruger.id]]))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  try {
    switch (handling) {
      case "betal": {
        // Valgfrit leveringsvalg i samme kald (som "Fortsæt til betaling" på
        // hjemmesiden): samme gemLevering som /api/fragt/app/levering. Ændrer
        // valget beløbet, annulleres den gamle PaymentIntent, og der laves en ny.
        let levering: Record<string, unknown> | null = null;
        const l = krop.levering === undefined || krop.levering === null ? null : obj(krop.levering);
        if (krop.levering !== undefined && krop.levering !== null && !l) return svar(400, UGYLDIG);
        if (l) {
          if (!(await tjekGraenser([["fragt_handling_bruger", bruger.id]]))) {
            return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
          }
          const g = await gemLevering(krop.trade_id, bruger.id, {
            maade: l.maade,
            pakkeshopId: l.pakkeshop_id,
            pakkeshopPostnummer: l.pakkeshop_postnummer,
            pakkeshopAdresse: l.pakkeshop_adresse,
            modtager: obj(l.modtager),
            gemForslag: l.gem_forslag,
            // Valgfri ("dao" | "gls" | "postnord" fra checkout.transportoerer) -
            // som /api/fragt/app/levering. Udeladt = DAO.
            ...(l.transportoer !== undefined ? { transportoer: l.transportoer } : {}),
          });
          if ("fejl" in g) return svar(409, { fejl: g.fejl, kode: "levering" });
          levering = { ...g };
          delete levering.ok;
        }
        const r = await startBetalingFor(bruger.id, krop.trade_id, "app");
        if ("fejl" in r) return fejlSvar(r);
        const publishableKey = offentligStripeNoegle();
        if (!publishableKey) {
          await logDriftFejl({ kilde: "server", sti: "/api/betaling/app/betal", fejl: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY mangler", brugerId: bruger.id });
          return svar(500, { fejl: GENERISK, kode: "fejl" });
        }
        return svar(200, {
          ok: true,
          clientSecret: r.clientSecret,
          totalOere: r.totalOere,
          customerId: r.customerId,
          customerSessionClientSecret: r.customerSessionClientSecret,
          publishableKey,
          // "Sælger: X" som på hjemmesidens checkout (users.navn).
          saelgerNavn: await saelgerNavnForHandel(krop.trade_id),
          ...(levering ? { levering } : {}),
        });
      }
      case "indstillinger":
        return svar(200, { ok: true, ...(await hentBetalingsindstillingerFor(bruger.id)) });
      case "gem-kort": {
        const r = await startGemKortFor(bruger.id, "app");
        if ("fejl" in r) return fejlSvar(r);
        // Uden den offentlige nøgle kan appen ikke åbne PaymentSheet (som betal).
        const publishableKey = offentligStripeNoegle();
        if (!publishableKey) {
          await logDriftFejl({ kilde: "server", sti: "/api/betaling/app/gem-kort", fejl: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY mangler", brugerId: bruger.id });
          return svar(500, { fejl: GENERISK, kode: "fejl" });
        }
        return svar(200, { ...r, publishableKey });
      }
      case "boost-koeb": {
        // Køb af boost-point (100 point for 39 kr.): betaling til BidHamrs
        // platformskonto - samme kode som hjemmesiden (src/lib/betaling/boost.ts).
        if (krop.samtykke !== undefined && typeof krop.samtykke !== "boolean") return svar(400, UGYLDIG);
        const publishableKey = offentligStripeNoegle();
        if (!publishableKey) {
          await logDriftFejl({ kilde: "server", sti: "/api/betaling/app/boost-koeb", fejl: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY mangler", brugerId: bruger.id });
          return svar(500, { fejl: GENERISK, kode: "fejl" });
        }
        const r = await startBoostKoeb(bruger.id, "app", krop.samtykke === true);
        if ("fejl" in r) return svar(BOOST_KOEB_STATUS[r.kode] ?? 500, { fejl: r.fejl, kode: r.kode });
        return svar(200, {
          ok: true,
          koebId: r.koebId,
          clientSecret: r.clientSecret,
          beloebOere: r.beloebOere,
          point: r.point,
          customerId: r.customerId,
          customerSessionClientSecret: r.customerSessionClientSecret,
          publishableKey,
        });
      }
      case "boost-brug": {
        const r = await brugBoost(bruger.id, krop.auktion_id, krop.noegle);
        if ("fejl" in r) {
          return svar(BOOST_BRUG_STATUS[r.kode] ?? 500, {
            fejl: r.fejl,
            kode: r.kode,
            ...(r.saldo !== undefined ? { saldo: r.saldo } : {}),
            ...(r.pris !== undefined ? { pris: r.pris } : {}),
            ...(r.slutKl ? { slutKl: r.slutKl } : {}),
          });
        }
        return svar(200, { ok: true, kode: r.kode, boostId: r.boostId, slutKl: r.slutKl, saldo: r.saldo });
      }
      case "bekraeft-kort": {
        const r = await bekraeftGemtKortFor(bruger.id, krop.setup_intent_id);
        if ("fejl" in r) return fejlSvar(r);
        return svar(200, { ok: true, gemtKort: (await hentBetalingsindstillingerFor(bruger.id)).gemtKort });
      }
      case "fjern-kort":
        await fjernGemtKortForBruger(bruger.id);
        return svar(200, { ok: true });
      case "udbetalingskonto": {
        const r = await startOnboardingFor(bruger.id, "konto", "app");
        if ("fejl" in r) return fejlSvar(r);
        return svar(200, { ok: true, url: r.url });
      }
      case "udbetalingskonto-status": {
        const r = await opdaterSaelgerStatusFor(bruger.id);
        if ("fejl" in r) return fejlSvar(r);
        return svar(200, { ok: true, saelger: (await hentBetalingsindstillingerFor(bruger.id)).saelger });
      }
      case "stripe-oversigt": {
        const r = await stripeOversigtFor(bruger.id);
        if ("fejl" in r) return fejlSvar(r);
        return svar(200, { ok: true, url: r.url });
      }
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: `/api/betaling/app/${handling}`, fejl: err, brugerId: bruger.id });
    return svar(500, { fejl: GENERISK, kode: "fejl" });
  }
}
