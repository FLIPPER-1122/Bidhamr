import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { indenForGraense, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
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

// Købers fakturaer fra et firma på en handel (appen og hjemmesiden).
// Dokumentation: docs/FIRMA-FAKTURA.md og docs/APP-ENDPOINTS.md.
//
// GET  /api/firma-faktura?trade=<trade_id>
//   Authorization: Bearer <Supabase access token>  (hjemmesiden: cookie)
//   -> 200 { ok: true, kanOplyseFirma: boolean, firma: { firmanavn, cvr } | null,
//            fakturaer: [{ id, type, fakturanummer, udstedt_dato, sendt_kl, firmanavn, total_oere, pdf }] }
//      pdf = "/api/firma-faktura/<id>" (GET med samme Bearer-token giver PDF'en)
//      Handel uden for køberen eller uden firmafaktura: fakturaer = [].
// POST /api/firma-faktura   (kun Bearer)
//   { trade_id, firmanavn, cvr }  - køberen oplyser firmanavn og CVR til
//   sælgers faktura, før den sendes. Tomme strenge fjerner dem.
//   -> 200 { ok: true } | 409 { fejl, kode: "allerede_sendt" | "ingen_faktura" }
// Fejl: 400 ugyldig · 401 ikke_logget_ind · 429 for_mange · 500 fejl.
//
// Appen kan ALDRIG sende en faktura - det gør kun firmaet på hjemmesiden.
// Kun køberen selv (auth.uid()); RPC'erne kaldes som brugeren.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function bruger(req: NextRequest): Promise<{ id: string; supabase: SupabaseClient } | null> {
  const token = bearerToken(req);
  if (token) {
    const b = await appBruger(token);
    return b ? { id: b.bruger.id, supabase: b.supabase } : null;
  }
  if ((req.headers.get("authorization") ?? "").trim()) return null;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ? { id: data.user.id, supabase } : null;
}

type KoeberSvar = {
  kladde: { firmanavn: string | null; cvr: string | null } | null;
  fakturaer: { id: string; type: string; fakturanummer: string; udstedt_dato: string; sendt_kl: string; firmanavn: string; total_oere: number }[];
} | null;

export async function GET(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, APP_UGYLDIG);
  const trade = req.nextUrl.searchParams.get("trade") ?? "";
  if (!UUID_RE.test(trade)) return appSvar(400, APP_UGYLDIG);
  const b = await bruger(req);
  if (!b) return appSvar(401, APP_IKKE_LOGGET_IND);
  if (!(await indenForGraense("firma_faktura_pdf", b.id))) return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  const { data, error } = await b.supabase.rpc("koeber_firma_fakturaer", { p_trade: trade });
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: "api/firma-faktura GET", fejl: error, brugerId: b.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
  const d = data as KoeberSvar;
  return appSvar(200, {
    ok: true,
    kanOplyseFirma: !!d?.kladde,
    firma: d?.kladde ?? null,
    fakturaer: (d?.fakturaer ?? []).map((f) => ({ ...f, pdf: `/api/firma-faktura/${f.id}` })),
  });
}

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, APP_UGYLDIG);
  const token = bearerToken(req);
  if (!token) return appSvar(401, APP_IKKE_LOGGET_IND);
  const b = await appBruger(token);
  if (!b) return appSvar(401, APP_IKKE_LOGGET_IND);
  if (!(await indenForGraense("firma_faktura_gem", b.bruger.id))) return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  const k = await laesJsonKrop(req, 1024);
  if ("svar" in k) return k.svar;
  const { trade_id, firmanavn, cvr } = k.krop as { trade_id?: unknown; firmanavn?: unknown; cvr?: unknown };
  if (typeof trade_id !== "string" || !UUID_RE.test(trade_id) || typeof firmanavn !== "string" || typeof cvr !== "string") {
    return appSvar(400, APP_UGYLDIG);
  }
  const { data, error } = await b.supabase.rpc("koeber_faktura_firma_gem", {
    p_trade: trade_id,
    p_firmanavn: firmanavn.slice(0, 200),
    p_cvr: cvr.slice(0, 20),
  });
  if (error) {
    if (error.code === "22023") return appSvar(400, { fejl: error.message, kode: "ugyldig" });
    await logDriftFejl({ kilde: "server", hvor: "api/firma-faktura POST", fejl: error, brugerId: b.bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
  const s = data as { ok: boolean; kode?: string };
  if (!s.ok) {
    return appSvar(409, {
      fejl:
        s.kode === "allerede_sendt"
          ? "Sælgeren har allerede sendt fakturaen. Skriv til sælgeren, hvis noget skal rettes."
          : "Der er ingen faktura fra sælgeren på denne handel.",
      kode: s.kode ?? "ingen_faktura",
    });
  }
  return appSvar(200, { ok: true });
}
