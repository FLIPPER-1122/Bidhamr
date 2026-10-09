import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { klientIp, tjekGraenser } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import {
  callbackUrl,
  ensStrenge,
  tilfaeldig,
  hentIdentitet,
  mitIdHash,
  mitIdKonfig,
  sha256Hex,
  sideOrigin,
} from "@/lib/mitid/oidc";
import {
  APP_AFSLUT_LEVETID_SEK,
  MITID_COOKIE,
  STANDARD_RETUR,
  resultatFraKode,
  tilApp,
  tilAppAfslut,
  tilSide,
} from "@/lib/mitid/flow";
import type { MitIdResultat } from "@/lib/tekster/mitid";

// Idura sender brugeren hertil efter MitID (registreret som
// http://localhost:3000/api/mitid/callback og https://bidhamr.dk/api/mitid/callback).
//
// 1. state skal matche cookien (samme browser) og et ubrugt, ikke-udløbet forløb
//    i mitid_flow (forbruges atomisk - kan kun bruges én gang).
// 2. Koden byttes til tokens med client secret + PKCE-verifier.
// 3. id_token verificeres (RS256-signatur mod JWKS, issuer, audience, exp, iat, nonce).
// 4. Hjemmesiden: mitid_registrer afgør reglerne i databasen: 18 år, én
//    MitID = én konto, lukkede konti. Kun en HMAC af MitIDs Person-ID gemmes -
//    aldrig CPR (der bedes ikke om scope "ssn").
//    Appen: callbacken registrerer IKKE. Identiteten gemmes på forløbet i
//    højst 5 minutter, og appen får et engangs-id (bidhamr://mitid?k=…), som
//    kun kan indløses af den bruger, der startede, med app-hemmeligheden
//    (POST /api/mitid/app/afslut). Så kan et link sendt til en anden person
//    ikke bruges til at verificere angriberens konto med offerets MitID.

export const dynamic = "force-dynamic";

type Flow = { id: string; bruger_id: string; nonce: string; code_verifier: string; retur: string | null; app: boolean };

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const state = sp.get("state") ?? "";
  const cookieState = req.cookies.get(MITID_COOKIE)?.value ?? "";

  const k = mitIdKonfig();
  const cb = callbackUrl(req.nextUrl.origin);
  const origin = cb ? sideOrigin(cb) : req.nextUrl.origin;
  const tilForside = (r: MitIdResultat) => tilSide(origin, STANDARD_RETUR, r);

  if (!(await tjekGraenser([["mitid_callback_ip", await klientIp()]]))) return tilForside("forMange");
  if (!k || !cb) return tilForside("ikkeTilgaengelig");
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) return tilForside("fejl");
  if (!cookieState || !ensStrenge(cookieState, state)) return tilForside("udloebet");

  const admin = createAdminClient();
  let flow: Flow | null = null;
  try {
    const { data, error } = await admin
      .from("mitid_flow")
      .update({ brugt_kl: new Date().toISOString() })
      .eq("state_hash", sha256Hex(state))
      .is("brugt_kl", null)
      .gt("udloeber_kl", new Date().toISOString())
      .select("id, bruger_id, nonce, code_verifier, retur, app")
      .maybeSingle<Flow>();
    if (error) throw error;
    flow = data;
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/mitid/callback", fejl: err });
    return tilForside("fejl");
  }
  if (!flow || !flow.nonce || !flow.code_verifier) return tilForside("udloebet");

  const svar = (r: MitIdResultat) => (flow!.app ? tilApp(r) : tilSide(origin, flow!.retur ?? STANDARD_RETUR, r));

  // Brugeren afbrød (eller Idura gav en fejl).
  const oidcFejl = sp.get("error");
  if (oidcFejl) return svar(oidcFejl === "access_denied" ? "afbrudt" : "fejl");
  const code = sp.get("code");
  if (!code || code.length > 2000) return svar("fejl");

  // Hjemmesiden: den, der er logget ind nu, skal være den, der startede.
  if (!flow.app) {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user || auth.user.id !== flow.bruger_id) return svar("udloebet");
  }

  try {
    const id = await hentIdentitet(k, {
      code,
      redirectUri: cb,
      codeVerifier: flow.code_verifier,
      nonce: flow.nonce,
    });
    const idHash = mitIdHash(k, id.personId);
    if (flow.app) {
      const afslut = tilfaeldig(32);
      const { error: gemFejl } = await admin
        .from("mitid_flow")
        .update({
          id_hash: idHash,
          juridisk_navn: id.navn,
          foedselsdato: id.foedselsdato,
          afslut_hash: sha256Hex(afslut),
          identitet_udloeber_kl: new Date(Date.now() + APP_AFSLUT_LEVETID_SEK * 1000).toISOString(),
        })
        .eq("id", flow.id)
        .is("afsluttet_kl", null);
      if (gemFejl) throw gemFejl;
      return tilAppAfslut(afslut);
    }
    const { data, error } = await admin.rpc("mitid_registrer", {
      p_bruger: flow.bruger_id,
      p_hash: idHash,
      p_navn: id.navn,
      p_foedselsdato: id.foedselsdato,
    });
    if (error) throw error;
    return svar(resultatFraKode((data as { kode?: string } | null)?.kode));
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/mitid/callback", fejl: err, brugerId: flow.bruger_id });
    return svar("fejl");
  }
}
