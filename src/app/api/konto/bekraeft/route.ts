import { type NextRequest } from "next/server";
import { FOR_MANGE_FORSOEG, PROEV_IGEN_OM_LIDT, klientIp, tjekGraenserLukket } from "@/lib/rateLimit";
import { vurderAdgangskode } from "@/lib/adgangskode";
import { bekraeftKode, renEmail, renKode } from "@/lib/kontoOprettelse";
import { createAnonClient } from "@/lib/supabase/anon";
import { hentKontoStatus } from "@/lib/kontoStatus";
import { registrerLogin } from "@/lib/enheder";
import { logDriftFejl } from "@/lib/drift";
import { UGYLDIG, fremmedOrigin, jsonKrop, svar } from "@/lib/mitid/appAuth";

// Appen bekræfter e-mailen her (docs/APP-SIGNUP.md) med koden fra mailen -
// og sætter den valgte adgangskode i samme kald, EFTER verifyOtp. Appen har
// ikke hjemmesidens cookie, så adgangskoden sendes igen. Kun den, der har
// koden, kan altså bestemme adgangskoden (ingen kontoovertagelse, se
// src/lib/kontoOprettelse.ts).
//
// POST /api/konto/bekraeft
//   Content-Type: application/json
//   { "email": "...", "kode": "123456", "password": "..." }
//
// Svar (JSON):
//   200 { ok: true, adgangskode_sat: boolean,
//         session: { access_token, refresh_token, expires_in, expires_at, token_type },
//         bruger: { id, email } }
//       Appen gemmer sessionen med supabase.auth.setSession({ access_token,
//       refresh_token }). adgangskode_sat = false: adgangskoden kunne ikke
//       sættes - vis "Vælg adgangskode" og kald supabase.auth.updateUser({
//       password }) med den nye session.
//   400 { fejl, kode: "ugyldig" | "email" | "kode_forkert" | "adgangskode" }
//       kode_forkert: forkert eller udløbet kode (få en ny via /api/konto/opret).
//       adgangskode: adgangskoden opfylder ikke kravene - tjekket FØR koden
//       bruges, så koden stadig gælder.
//   403 { fejl, kode: "ikke_tilladt" }   fremmed Origin
//   403 { fejl, kode: "suspenderet" | "slettet" }   kontoen må ikke logge ind
//   429 { fejl, kode: "for_mange" }
//   503 { fejl, kode: "ikke_tilgaengelig" }   grænsen kunne ikke tjekkes (fail closed)
//   500 { fejl, kode: "fejl" }
//
// Sikkerhed: ingen cookies, ingen CORS-headere, fremmed Origin afvises (som
// /api/mitid/app). Rate limit pr. IP før alt andet og derefter de samme
// grænser som hjemmesidens kode-side (pr. IP, pr. e-mail+IP og pr. e-mail).
//
// Proxyen lukker /api/konto/bekraeft igennem uden login (src/lib/supabase/middleware.ts).

export const dynamic = "force-dynamic";

const FOR_MANGE = { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
const IKKE_TILGAENGELIG = { fejl: PROEV_IGEN_OM_LIDT, kode: "ikke_tilgaengelig" };
const FEJL = { fejl: "Noget gik galt – prøv igen.", kode: "fejl" };

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  const graenseIp = await tjekGraenserLukket([["konto_app_ip", ip]]);
  if (graenseIp === "for_mange") return svar(429, FOR_MANGE);
  if (graenseIp === "fejl") return svar(503, IKKE_TILGAENGELIG);

  const krop = await jsonKrop(req);
  if (!krop) return svar(400, UGYLDIG);

  const email = renEmail(krop.email);
  const kode = renKode(krop.kode);
  const password = typeof krop.password === "string" ? krop.password : "";
  if (!email) return svar(400, { fejl: "Indtast den e-mail, du oprettede kontoen med.", kode: "email" });
  if (!kode) return svar(400, { fejl: "Skriv hele koden fra mailen.", kode: "kode_forkert" });
  // Før koden bruges (navnet tjekkes igen efter bekræftelsen i bekraeftKode).
  const v = vurderAdgangskode(password, { email });
  if (!v.ok) return svar(400, { fejl: v.fejl ?? "Vælg en anden adgangskode.", kode: "adgangskode" });

  const supabase = createAnonClient();
  const res = await bekraeftKode(supabase, { email, kode, ip, adgangskode: password });
  if ("fejl" in res) {
    if (res.fejl === "for_mange") return svar(429, FOR_MANGE);
    if (res.fejl === "graense_fejl") return svar(503, IKKE_TILGAENGELIG);
    if (res.fejl === "kode_forkert") {
      return svar(400, {
        fejl: "Koden passer ikke, eller den er udløbet. Tjek koden, eller få en ny.",
        kode: "kode_forkert",
      });
    }
    return svar(500, FEJL);
  }

  try {
    if (!res.session) {
      // Burde ikke ske (verifyOtp giver altid en session ved type signup).
      await logDriftFejl({ kilde: "server", sti: "/api/konto/bekraeft", fejl: "verifyOtp gav ingen session", brugerId: res.user.id });
      return svar(500, FEJL);
    }

    // Suspenderede/slettede konti får ingen session (som login på hjemmesiden).
    const status = await hentKontoStatus(res.user.id);
    if (status.kode !== "ok") {
      await supabase.auth.signOut({ scope: "local" });
      if (status.kode === "suspenderet") return svar(403, { fejl: status.besked, kode: "suspenderet" });
      if (status.kode === "slettet") return svar(403, { fejl: "Kontoen findes ikke længere.", kode: "slettet" });
      return svar(500, FEJL);
    }

    await registrerLogin({ brugerId: res.user.id, email: res.user.email, accessToken: res.session.access_token });
    return svar(200, {
      ok: true,
      adgangskode_sat: res.adgangskodeSat,
      session: {
        access_token: res.session.access_token,
        refresh_token: res.session.refresh_token,
        expires_in: res.session.expires_in,
        expires_at: res.session.expires_at ?? null,
        token_type: res.session.token_type,
      },
      bruger: { id: res.user.id, email: res.user.email ?? email },
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/konto/bekraeft", fejl: err, brugerId: res.user.id });
    return svar(500, FEJL);
  }
}
