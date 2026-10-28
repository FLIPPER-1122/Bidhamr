import { type NextRequest } from "next/server";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import {
  APP_GENERISK,
  APP_IKKE_LOGGET_IND,
  appBruger,
  appSvar,
  bearerToken,
  fremmedOrigin,
  laesJsonKrop,
} from "@/lib/appApi";
import { gemMinAdresse, hentFakturaNavn, hentMinAdresse } from "@/lib/adresse/server";

// Min adresse i appen - Bearer-varianten af /konto/adresse og formularen før
// første bud/betaling. Samme databasekald som hjemmesiden: læsning med
// brugerens egen session (RLS: kun egen række), gem med gem_min_adresse()
// (auth.uid()). Dokumentation: docs/APP-SIGNUP.md ("Adresse").
//
// GET /api/konto/adresse
//   Authorization: Bearer <Supabase access token>
//   200 { ok: true, adresse: { adresse, postnummer, by } | null,
//         faktura_navn: string | null, navn_fra_mitid: boolean }
//       adresse null = ingen adresse endnu: vis formularen.
//       navn_fra_mitid = true: navnet på fakturaer er navnet fra MitID og kan
//       ikke rettes (vis det som låst).
//
// POST /api/konto/adresse
//   Content-Type: application/json
//   { "adresse": "Testvej 12, 2. th.", "postnummer": "2100" }
//   ("by" må sendes med, men ignoreres: serveren bruger bynavnet for
//   postnummeret og sender det tilbage.)
//   200 { ok: true, adresse: { adresse, postnummer, by } }
//   400 { fejl, kode: "adresse" | "postnummer" | "ugyldig" }   fejl er dansk tekst til feltet
//   403 { fejl, kode: "konto" }   lukket eller slettet konto
//
// Fælles: 401 { fejl, kode: "ikke_logget_ind" }, 403 { fejl, kode: "ikke_tilladt" }
// (fremmed Origin), 429 { fejl, kode: "for_mange" }, 500 { fejl, kode: "fejl" }.

export const dynamic = "force-dynamic";

async function login(req: NextRequest) {
  if (fremmedOrigin(req)) return { svar: appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" }) };
  const ip = await klientIp();
  if (!(await tjekGraenser([["adresse_app_ip", ip]]))) {
    return { svar: appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" }) };
  }
  const token = bearerToken(req);
  if (!token) return { svar: appSvar(401, APP_IKKE_LOGGET_IND) };
  const l = await appBruger(token);
  if (!l) return { svar: appSvar(401, APP_IKKE_LOGGET_IND) };
  return { login: l };
}

export async function GET(req: NextRequest) {
  const r = await login(req);
  if ("svar" in r) return r.svar;
  const { bruger, supabase } = r.login;
  try {
    const [adresse, navn] = await Promise.all([hentMinAdresse(supabase, bruger.id), hentFakturaNavn(supabase, bruger.id)]);
    if (adresse === "fejl") return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
    return appSvar(200, { ok: true, adresse, faktura_navn: navn.navn, navn_fra_mitid: navn.mitid });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/konto/adresse", fejl: err, brugerId: bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}

export async function POST(req: NextRequest) {
  const r = await login(req);
  if ("svar" in r) return r.svar;
  const { bruger, supabase } = r.login;
  if (!(await tjekGraenser([["adresse_bruger", bruger.id]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }
  const k = await laesJsonKrop(req);
  if ("svar" in k) return k.svar;
  try {
    const svar = await gemMinAdresse(supabase, bruger.id, { adresse: k.krop.adresse, postnummer: k.krop.postnummer });
    if ("ok" in svar) return appSvar(200, { ok: true, adresse: svar.adresse });
    if (svar.felt) return appSvar(400, { fejl: svar.fejl, kode: svar.felt });
    if (svar.konto) return appSvar(403, { fejl: svar.fejl, kode: "konto" });
    return appSvar(500, { fejl: svar.fejl, kode: "fejl" });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/konto/adresse", fejl: err, brugerId: bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}
