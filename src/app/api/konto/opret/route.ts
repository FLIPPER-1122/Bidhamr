import { type NextRequest } from "next/server";
import { FOR_MANGE_FORSOEG, PROEV_IGEN_OM_LIDT, klientIp, tjekGraenserLukket } from "@/lib/rateLimit";
import { vurderAdgangskode } from "@/lib/adgangskode";
import { VILKAAR_VERSION } from "@/lib/vilkaar";
import { godkendtSignupVersion } from "@/lib/vilkaarServer";
import { opretKontoPaaServeren, renEmail, renNavn } from "@/lib/kontoOprettelse";
import { UGYLDIG, fremmedOrigin, jsonKrop, svar } from "@/lib/mitid/appAuth";
import { CAPTCHA_FEJL } from "@/lib/turnstile";
import { tjekTurnstile } from "@/lib/turnstileServer";
import { validerAdresse } from "@/lib/adresse/regler";

// Appen opretter konti her (docs/APP-SIGNUP.md) - aldrig med supabase.auth.signUp
// (det afviser databasen). Samme kodevej som hjemmesidens opretKonto
// (src/lib/kontoOprettelse.ts): kontoen oprettes på serveren med en
// tilfældig adgangskode, og koden sendes til e-mailen. Den valgte adgangskode,
// navnet og vilkårsaccepten gemmes IKKE her (de tjekkes kun) - appen sender
// dem igen til POST /api/konto/bekraeft sammen med koden.
//
// POST /api/konto/opret
//   Content-Type: application/json
//   { "fornavn": "...", "efternavn": "...", "adresse": "Testvej 12, 2. th.",
//     "postnummer": "2100", "by": "København Ø", "email": "...", "password": "...",
//     "vilkaar_version": "<VILKAAR_VERSION>", "captchaToken": "..." }
//   adresse + postnummer: påkrævet (adressen til fakturaer, 20261102340000).
//   by: valgfri - serveren bruger altid bynavnet for postnummeret.
//   captchaToken: Turnstile-token - kræves kun, når TURNSTILE_SECRET_KEY er
//   sat på serveren (docs/SIKKERHED-AUTH.md).
//
// Svar (JSON):
//   200 { ok: true }   ALTID ved gyldigt input - uanset om e-mailen er ny,
//                      allerede har en konto, ikke er inviteret (lukket
//                      tilmelding) eller noget fejlede. Vis "Tjek din indbakke".
//                      Samme kald igen = "Send ny kode" (højst én kodemail pr.
//                      e-mail hvert 2. minut; inden for vinduet sendes intet).
//   400 { fejl, kode: "ugyldig" | "fornavn" | "efternavn" | "adresse" | "postnummer" | "email" |
//         "adgangskode" | "vilkaar" | "captcha" }
//   403 { fejl, kode: "ikke_tilladt" }   fremmed Origin (browser på et andet domæne)
//   429 { fejl, kode: "for_mange" }
//   503 { fejl, kode: "ikke_tilgaengelig" }   grænsen kunne ikke tjekkes (fail closed)
//
// Sikkerhed: ingen cookies og ingen CORS-headere (en browser på et andet
// domæne kan ikke sende JSON hertil uden preflight, som ikke godkendes), og
// en fremmed Origin afvises. Appen (native) sender ingen Origin. Rate limit
// pr. IP før alt andet og derefter de samme grænser som hjemmesiden (pr. IP
// og pr. e-mail).
//
// Proxyen lukker /api/konto/opret igennem uden login (src/lib/supabase/middleware.ts).

export const dynamic = "force-dynamic";

const FOR_MANGE = { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
const IKKE_TILGAENGELIG = { fejl: PROEV_IGEN_OM_LIDT, kode: "ikke_tilgaengelig" };

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  const graenseIp = await tjekGraenserLukket([["konto_app_ip", ip]]);
  if (graenseIp === "for_mange") return svar(429, FOR_MANGE);
  if (graenseIp === "fejl") return svar(503, IKKE_TILGAENGELIG);

  const krop = await jsonKrop(req);
  if (!krop) return svar(400, UGYLDIG);

  const fornavn = renNavn(krop.fornavn);
  const efternavn = renNavn(krop.efternavn);
  const email = renEmail(krop.email);
  const password = typeof krop.password === "string" ? krop.password : "";
  if (!fornavn) return svar(400, { fejl: "Skriv dit fornavn.", kode: "fornavn" });
  if (!efternavn) return svar(400, { fejl: "Skriv dit efternavn.", kode: "efternavn" });
  const adr = validerAdresse({ adresse: krop.adresse, postnummer: krop.postnummer });
  if ("fejl" in adr) return svar(400, { fejl: adr.fejl, kode: adr.felt });
  if (!email) return svar(400, { fejl: "Indtast en gyldig e-mail.", kode: "email" });
  const v = vurderAdgangskode(password, { email, navn: [fornavn, efternavn] });
  if (!v.ok) return svar(400, { fejl: v.fejl ?? "Vælg en anden adgangskode.", kode: "adgangskode" });
  // Hjemmesidens eller databasens aktive version (appen sender databasens).
  const vilkaarVersion = await godkendtSignupVersion(krop.vilkaar_version);
  if (!vilkaarVersion) {
    return svar(400, {
      fejl: "Du skal acceptere brugerbetingelserne for at oprette en konto.",
      kode: "vilkaar",
      vilkaar_version: VILKAAR_VERSION,
    });
  }

  const graense = await tjekGraenserLukket([["opret_ip", ip], ["gensend_email", email]]);
  if (graense === "for_mange") return svar(429, FOR_MANGE);
  if (graense === "fejl") return svar(503, IKKE_TILGAENGELIG);

  // CAPTCHA (docs/SIKKERHED-AUTH.md): kun når TURNSTILE_SECRET_KEY er sat.
  // generateLink har ingen CAPTCHA i Supabase, så serveren tjekker selv.
  if (!(await tjekTurnstile(krop.captchaToken, ip))) {
    return svar(400, { fejl: CAPTCHA_FEJL, kode: "captcha" });
  }

  // Kaster aldrig; fejl logges i /admin/drift. Svaret er det samme uanset udfald.
  // Navn, vilkår og adgangskode gemmes IKKE her - appen sender dem igen til
  // /api/konto/bekraeft, så de kommer fra den, der har koden.
  await opretKontoPaaServeren(email);
  return svar(200, { ok: true });
}
