import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { callbackUrl, mitIdKonfig, sha256Hex, sideOrigin, tilfaeldig } from "@/lib/mitid/oidc";
import { APP_TOKEN_LEVETID_SEK } from "@/lib/mitid/flow";
import { IKKE_LOGGET_IND, UGYLDIG, bearerBruger, fremmedOrigin, jsonKrop, svar } from "@/lib/mitid/appAuth";

// Appen starter MitID her (se docs/MITID.md).
//
// POST /api/mitid/app
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   { "hemmelighed_hash": "<hex SHA-256 af en tilfældig app-hemmelighed>" }
//
//   Appen laver selv en tilfældig hemmelighed (mindst 32 bytes), som den
//   holder i hukommelsen, og sender kun SHA-256 (hex) hertil. Klarteksten
//   sendes først ved POST /api/mitid/app/afslut.
//
// Svar (JSON):
//   200 { url, udloeber }   url = https://<side>/api/mitid/start?t=<engangs-token>
//                           Åbn den i en in-app browser (expo-web-browser
//                           openAuthSessionAsync) med callback-skemaet
//                           bidhamr://mitid. Tokenet kan bruges én gang inden
//                           for 2 minutter.
//   400 { fejl, kode: "ugyldig" }
//   401 { fejl, kode: "ikke_logget_ind" }
//   403 { fejl, kode: "ikke_tilladt" }
//   409 { fejl, kode: "allerede" | "erhverv" }
//   429 { fejl, kode: "for_mange" }
//   503 { fejl, kode: "ikke_tilgaengelig" }
//   500 { fejl, kode: "fejl" }

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["mitid_app_ip", ip]]))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const k = mitIdKonfig();
  const cb = callbackUrl(req.nextUrl.origin);
  if (!k || !cb) {
    return svar(503, { fejl: "MitID er ikke tilgængelig lige nu. Prøv igen senere.", kode: "ikke_tilgaengelig" });
  }

  const bruger = await bearerBruger(req);
  if (!bruger) return svar(401, IKKE_LOGGET_IND);

  const krop = await jsonKrop(req);
  const hemmelighedHash = typeof krop?.hemmelighed_hash === "string" ? krop.hemmelighed_hash.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hemmelighedHash)) return svar(400, UGYLDIG);

  if (!(await tjekGraenser([["mitid_start_bruger", bruger.id]]))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  try {
    const admin = createAdminClient();
    const { data: u, error: uFejl } = await admin
      .from("users")
      .select("konto_type, mitid_verificeret_kl, konto_slettet_kl")
      .eq("id", bruger.id)
      .maybeSingle<{ konto_type: string | null; mitid_verificeret_kl: string | null; konto_slettet_kl: string | null }>();
    if (uFejl) throw uFejl;
    if (!u || u.konto_slettet_kl) return svar(401, IKKE_LOGGET_IND);
    if (u.konto_type === "erhverv") {
      return svar(409, { fejl: "Firmakonti skal ikke bekræftes med MitID.", kode: "erhverv" });
    }
    if (u.mitid_verificeret_kl) {
      return svar(409, { fejl: "Du er allerede MitID-verificeret.", kode: "allerede" });
    }

    const token = tilfaeldig(32);
    const udloeber = new Date(Date.now() + APP_TOKEN_LEVETID_SEK * 1000).toISOString();
    const { error } = await admin.from("mitid_flow").insert({
      bruger_id: bruger.id,
      starttoken_hash: sha256Hex(token),
      app_hemmelighed_hash: hemmelighedHash,
      app: true,
      udloeber_kl: udloeber,
    });
    if (error) throw error;

    const url = new URL("/api/mitid/start", sideOrigin(cb));
    url.searchParams.set("t", token);
    return svar(200, { url: url.toString(), udloeber });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/mitid/app", fejl: err, brugerId: bruger.id });
    return svar(500, { fejl: "Noget gik galt – prøv igen.", kode: "fejl" });
  }
}
