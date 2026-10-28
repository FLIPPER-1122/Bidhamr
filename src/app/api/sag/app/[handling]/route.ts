import type { NextRequest } from "next/server";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
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
import { hentSagMulighederFor } from "@/lib/sagMuligheder";
import { opretSagFor, svarPaaSagFor } from "@/lib/sagHandlinger";
import { SAG_FAELLES_TEKSTER } from "@/lib/tekster/sagValg";

// "Meld et problem" fra appen (Expo) - samme kode som hjemmesiden
// (src/lib/sagMuligheder.ts, src/lib/sagHandlinger.ts), så appen ikke selv
// regner mulighederne ud, og så beskeden til sælgeren sendes med det samme.
// Dokumentation: docs/APP-ENDPOINTS.md ("POST /api/sag/app/<handling>").
//
// POST /api/sag/app/<handling>
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   muligheder  { trade_id }   (kun køberen)
//               -> { ok, muligheder: SagMuligheder, tekster }
//   opret       { trade_id, type, beskrivelse, billeder: [{ sti, kategori }],
//                 pakke_smidt_ud?: boolean, smidt_ud_begrundelse?: string,
//                 valg?: "stykker" | "annonce" | "anden_vare" | "tom" | "ikke_kommet" | "andet" }
//               -> { ok, sag_id }
//   svar        { sag_id, tekst, billeder: [{ sti, kategori }] }   (kun sælgeren)
//               -> { ok }
// Billederne uploades først af appen til Storage ('sag-billeder') under
// <eget id>/<handel-id>/<fil> med { upsert: false } (som i dag).
//
// Svar: 200 { ok: true, ... } | { fejl, kode } (dansk fejl). 400 ugyldig
// krop · 401 ikke logget ind · 404 handlen/sagen findes ikke · 409 kan ikke
// nu (kode fra databasen) · 413 · 429 for_mange · 500 fejl.
//
// Sikkerhed (som /api/handel/app): kun Bearer-token, ingen cookies, ingen
// CORS, fremmed Origin afvises. Brugeren findes ud fra tokenet, og RPC'erne
// kaldes SOM brugeren (auth.uid()). Rate limit pr. IP og pr. bruger.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HANDLINGER = ["muligheder", "opret", "svar"] as const;
type Handling = (typeof HANDLINGER)[number];

const STATUS: Record<string, number> = {
  ugyldig_type: 400,
  ugyldig_beskrivelse: 400,
  ugyldig_tekst: 400,
  ugyldige_billeder: 400,
  smidt_ud_begrundelse: 400,
  ugyldigt_valg: 400,
  kontaktinfo: 400,
  ikke_fundet: 404,
  ikke_logget_ind: 401,
  for_mange: 429,
  fejl: 500,
};

function fejlSvar(r: { fejl: string; kode: string }) {
  return appSvar(STATUS[r.kode] ?? 409, { fejl: r.fejl, kode: r.kode });
}

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

  const graense = handling === "muligheder" ? "handel_app_laes_bruger" : "handel_app_bruger";
  if (!(await tjekGraenser([[graense, bruger.id]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  try {
    switch (handling) {
      case "muligheder": {
        if (typeof krop.trade_id !== "string" || !UUID_RE.test(krop.trade_id)) return appSvar(400, APP_UGYLDIG);
        const r = await hentSagMulighederFor(bruger.id, krop.trade_id);
        if ("fejl" in r) return fejlSvar(r);
        return appSvar(200, { ok: true, muligheder: r, tekster: SAG_FAELLES_TEKSTER });
      }
      case "opret": {
        if (typeof krop.trade_id !== "string" || !UUID_RE.test(krop.trade_id)) return appSvar(400, APP_UGYLDIG);
        if (krop.pakke_smidt_ud !== undefined && typeof krop.pakke_smidt_ud !== "boolean") return appSvar(400, APP_UGYLDIG);
        const r = await opretSagFor(supabase, bruger.id, {
          tradeId: krop.trade_id,
          type: krop.type,
          beskrivelse: krop.beskrivelse,
          billeder: krop.billeder ?? [],
          pakkeSmidtUd: krop.pakke_smidt_ud === true,
          smidtUdBegrundelse: krop.smidt_ud_begrundelse,
          valg: krop.valg,
        });
        if ("fejl" in r) return fejlSvar(r);
        return appSvar(200, { ok: true, sag_id: r.sagId });
      }
      case "svar": {
        if (typeof krop.sag_id !== "string" || !UUID_RE.test(krop.sag_id)) return appSvar(400, APP_UGYLDIG);
        const r = await svarPaaSagFor(supabase, bruger.id, {
          sagId: krop.sag_id,
          tekst: krop.tekst,
          billeder: krop.billeder ?? [],
        });
        if ("fejl" in r) return fejlSvar(r);
        return appSvar(200, { ok: true });
      }
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: `/api/sag/app/${handling}`, fejl: err, brugerId: bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}
