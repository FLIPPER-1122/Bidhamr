import type { NextRequest } from "next/server";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  APP_GENERISK,
  APP_IKKE_LOGGET_IND,
  APP_UGYLDIG,
  UUID_RE,
  appBruger,
  appSvar,
  bearerToken,
  fremmedOrigin,
  laesJsonKrop,
} from "@/lib/appApi";
import {
  bekraeftAfhentningFor,
  godkendPakkeFor,
  markerModtagetFor,
  sendPakkeFor,
  type HandelstrinSvar,
} from "@/lib/handel/handelstrin";
import { hentHandelAppStatus } from "@/lib/handel/handelStatus";
import {
  genopsaetAuktionFor,
  hentAndenchanceStatusFor,
  sendAndenchanceTilbudFor,
  svarAndenchanceFor,
  type AndenchanceFejl,
} from "@/lib/andenchance";

// Handelstrin fra appen (Expo). Samme kode som hjemmesidens server actions
// (src/lib/handel/handelstrin.ts, src/lib/andenchance.ts), så beskeder (mail,
// push, klokke) og udbetalingen sker præcis som på hjemmesiden.
// Dokumentation: docs/APP-ENDPOINTS.md.
//
// POST /api/handel/app/<handling>
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   status               { trade_id }
//                        -> { annullering: { aarsag, refunderet } | null, betaling: { sidsteFejl } | null,
//                             fragt: { labelsAktiv, returlabelAktiv } }
//   send-pakke           { trade_id, tracking, billeder: [{ sti, kategori: "aaben_kasse" | "lukket_kasse" }] }
//   modtaget             { trade_id }
//   godkend              { trade_id, stjerner: 1-5, kommentar: string | null }
//   afhentning-bekraeft  { trade_id, kode: "123456" }
//   andenchance-status   { trade_id }  -> som hentAndenchanceStatus (uden ok)
//   andenchance-tilbud   { trade_id }  -> { tilbudId, budOere, udloeber }
//   andenchance-svar     { tilbud_id, ja: boolean }  -> { trade_id: string | null }
//   genopsaet            { trade_id, startpris, varighed_dage: 3 | 5 | 7 | 10 }  -> { auktion_id }
//
// Svar: 200 { ok: true, ... } | { fejl, kode } (dansk fejl).
//   400 ugyldig krop · 401 ikke logget ind · 403 ikke part i handlen / forkert
//   part · 404 handlen findes ikke · 409 handlingen kan ikke udføres nu (kode
//   fra databasen) · 413 · 429 for_mange · 500 fejl.
//
// Sikkerhed (som /api/fragt/app): kun Bearer-token - cookies bruges ikke
// (ingen CSRF); ingen CORS-headere, og en fremmed Origin afvises. Brugeren
// findes ud fra tokenet, aldrig fra kroppen, og RPC'erne kaldes SOM brugeren
// (auth.uid()). Rate limit pr. IP og pr. bruger. Proxyen lukker stien
// igennem uden cookie-login (src/lib/supabase/middleware.ts).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// godkend/afhentning starter udbetalingen hos Stripe.
export const maxDuration = 60;

const HANDLINGER = [
  "status",
  "send-pakke",
  "modtaget",
  "godkend",
  "afhentning-bekraeft",
  "andenchance-status",
  "andenchance-tilbud",
  "andenchance-svar",
  "genopsaet",
] as const;
type Handling = (typeof HANDLINGER)[number];

// Læsninger tæller ikke mod handlingsgrænsen, men har deres egen.
const LAESNINGER: Handling[] = ["status", "andenchance-status"];

const IKKE_FUNDET = { fejl: "Handlen findes ikke.", kode: "ikke_fundet" };
const IKKE_PART = { fejl: "Du er ikke part i denne handel.", kode: "ikke_part" };

// Fejlkoder fra de fælles funktioner -> HTTP-status. Alt andet er 409
// (handlingen kan ikke udføres i handlens nuværende tilstand).
const STATUS: Record<string, number> = {
  ugyldigt_tracking: 400,
  ugyldige_billeder: 400,
  ugyldige_stjerner: 400,
  kommentar_for_lang: 400,
  ugyldig_kode: 400,
  ugyldig_startpris: 400,
  ugyldig_varighed: 400,
  ikke_fundet: 404,
  ikke_byder: 404,
  ikke_saelger: 403,
  ikke_koeber: 403,
  ikke_part: 403,
  ikke_logget_ind: 401,
  mitid: 403,
  vilkaar: 403,
  dac7: 403,
  ekstra_fragt: 403,
  for_mange: 429,
  fejl: 500,
};

function fejlSvar(r: { fejl: string; kode: string }) {
  return appSvar(STATUS[r.kode] ?? 409, { fejl: r.fejl, kode: r.kode });
}

function trinSvar(r: HandelstrinSvar) {
  return "fejl" in r ? fejlSvar(r) : appSvar(200, { ok: true });
}

function andenchanceFejl(r: AndenchanceFejl) {
  return fejlSvar({ fejl: r.fejl, kode: r.kode });
}

type HandelParter = { id: string; auction_id: string; seller_id: string; buyer_id: string; status: string; afhentning: boolean };

export async function POST(req: NextRequest, { params }: { params: Promise<{ handling: string }> }) {
  const { handling: h } = await params;
  if (!(HANDLINGER as readonly string[]).includes(h)) return appSvar(404, { fejl: "Ukendt handling.", kode: "ugyldig" });
  const handling = h as Handling;
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["handel_app_ip", ip]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const token = bearerToken(req);
  if (!token) return appSvar(401, APP_IKKE_LOGGET_IND);

  const k = await laesJsonKrop(req);
  if ("svar" in k) return k.svar;
  const krop = k.krop;

  const login = await appBruger(token);
  if (!login) return appSvar(401, APP_IKKE_LOGGET_IND);
  const { bruger, supabase } = login;

  // Læsninger har deres egen, rummelige grænse pr. bruger; handlinger den
  // strammere handel_app_bruger.
  const brugerGraense = LAESNINGER.includes(handling) ? "handel_app_laes_bruger" : "handel_app_bruger";
  if (!(await tjekGraenser([[brugerGraense, bruger.id]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  try {
    // andenchance-svar handler om et tilbud, ikke en handel: databasen
    // tjekker, at kalderen er byderen.
    if (handling === "andenchance-svar") {
      if (typeof krop.tilbud_id !== "string" || !UUID_RE.test(krop.tilbud_id) || typeof krop.ja !== "boolean") {
        return appSvar(400, APP_UGYLDIG);
      }
      const r = await svarAndenchanceFor(bruger.id, krop.tilbud_id, krop.ja);
      if ("fejl" in r) return andenchanceFejl(r);
      return appSvar(200, { ok: true, trade_id: r.tradeId });
    }

    // Alle andre handlinger handler om én handel. Kun køber og sælger må
    // kalde dem: 404 hvis handlen ikke findes, 403 hvis kalderen ikke er
    // part i den. (Service role kun til dette opslag - selve handlingerne
    // kaldes som brugeren.)
    if (typeof krop.trade_id !== "string" || !UUID_RE.test(krop.trade_id)) return appSvar(400, APP_UGYLDIG);
    const { data: handel, error: handelFejl } = await createAdminClient()
      .from("trades")
      .select("id, auction_id, seller_id, buyer_id, status, afhentning")
      .eq("id", krop.trade_id)
      .maybeSingle<HandelParter>();
    if (handelFejl) throw new Error(`trades: ${handelFejl.message}`);
    if (!handel) return appSvar(404, IKKE_FUNDET);
    if (handel.buyer_id !== bruger.id && handel.seller_id !== bruger.id) return appSvar(403, IKKE_PART);
    const erSaelger = handel.seller_id === bruger.id;

    switch (handling) {
      case "status":
        return appSvar(200, { ok: true, ...(await hentHandelAppStatus(supabase, bruger.id, handel)) });
      case "send-pakke": {
        if (typeof krop.tracking !== "string" || !Array.isArray(krop.billeder)) return appSvar(400, APP_UGYLDIG);
        return trinSvar(await sendPakkeFor(supabase, bruger.id, handel.id, krop.tracking, krop.billeder));
      }
      case "modtaget":
        return trinSvar(await markerModtagetFor(supabase, bruger.id, handel.id));
      case "godkend": {
        if (krop.kommentar !== undefined && krop.kommentar !== null && typeof krop.kommentar !== "string") {
          return appSvar(400, APP_UGYLDIG);
        }
        return trinSvar(await godkendPakkeFor(supabase, bruger.id, handel.id, krop.stjerner, krop.kommentar ?? null));
      }
      case "afhentning-bekraeft": {
        if (typeof krop.kode !== "string") return appSvar(400, APP_UGYLDIG);
        if (!erSaelger) return appSvar(403, { fejl: "Kun sælgeren kan bekræfte afhentningen.", kode: "ikke_saelger" });
        return trinSvar(await bekraeftAfhentningFor(supabase, bruger.id, handel.id, krop.kode));
      }
      case "andenchance-status": {
        if (!erSaelger) return appSvar(403, { fejl: "Kun sælgeren kan se dette.", kode: "ikke_saelger" });
        const r = await hentAndenchanceStatusFor(bruger.id, handel.id);
        if ("fejl" in r) return andenchanceFejl(r);
        const { ok: _ok, ...status } = r;
        void _ok;
        return appSvar(200, { ok: true, ...status });
      }
      case "andenchance-tilbud": {
        if (!erSaelger) return appSvar(403, { fejl: "Kun sælgeren kan sende tilbuddet.", kode: "ikke_saelger" });
        const r = await sendAndenchanceTilbudFor(bruger.id, handel.id);
        if ("fejl" in r) return andenchanceFejl(r);
        return appSvar(200, { ok: true, tilbudId: r.tilbudId, budOere: r.budOere, udloeber: r.udloeber });
      }
      case "genopsaet": {
        if (typeof krop.startpris !== "number" || typeof krop.varighed_dage !== "number") return appSvar(400, APP_UGYLDIG);
        // Serveren finder selv auktionen ud fra handlen; kun sælgeren.
        if (!erSaelger) return appSvar(403, { fejl: "Kun sælgeren kan sætte varen op igen.", kode: "ikke_saelger" });
        const r = await genopsaetAuktionFor(bruger.id, handel.auction_id, krop.startpris, krop.varighed_dage);
        if ("fejl" in r) return andenchanceFejl(r);
        return appSvar(200, { ok: true, auktion_id: r.auktionId });
      }
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: `/api/handel/app/${handling}`, fejl: err, brugerId: bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}
