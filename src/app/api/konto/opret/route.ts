import { type NextRequest } from "next/server";
import { FOR_MANGE_FORSOEG, PROEV_IGEN_OM_LIDT, klientIp, tjekGraenserLukket } from "@/lib/rateLimit";
import { vurderAdgangskode } from "@/lib/adgangskode";
import { VILKAAR_VERSION } from "@/lib/vilkaar";
import { opretKontoPaaServeren, renEmail, renNavn } from "@/lib/kontoOprettelse";
import { UGYLDIG, fremmedOrigin, jsonKrop, svar } from "@/lib/mitid/appAuth";

// Appen opretter konti her (docs/APP-SIGNUP.md) - aldrig med supabase.auth.signUp
// (det afviser databasen). Samme kodevej som hjemmesidens opretKonto
// (src/lib/kontoOprettelse.ts): kontoen oprettes på serveren med en
// tilfældig adgangskode, og koden sendes til e-mailen. Den valgte adgangskode
// gemmes IKKE her - appen sender den igen til POST /api/konto/bekraeft
// sammen med koden.
//
// POST /api/konto/opret
//   Content-Type: application/json
//   { "fornavn": "...", "efternavn": "...", "email": "...", "password": "...",
//     "vilkaar_version": "<VILKAAR_VERSION>" }
//
// Svar (JSON):
//   200 { ok: true }   ALTID ved gyldigt input - uanset om e-mailen er ny,
//                      allerede har en konto, ikke er inviteret (lukket
//                      tilmelding) eller noget fejlede. Vis "Tjek din indbakke".
//                      Samme kald igen = "Send ny kode" (højst én kodemail pr.
//                      e-mail hvert 2. minut; inden for vinduet sendes intet).
//   400 { fejl, kode: "ugyldig" | "fornavn" | "efternavn" | "email" | "adgangskode" | "vilkaar" }
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
  if (!email) return svar(400, { fejl: "Indtast en gyldig e-mail.", kode: "email" });
  const v = vurderAdgangskode(password, { email, navn: [fornavn, efternavn] });
  if (!v.ok) return svar(400, { fejl: v.fejl ?? "Vælg en anden adgangskode.", kode: "adgangskode" });
  if (krop.vilkaar_version !== VILKAAR_VERSION) {
    return svar(400, {
      fejl: "Du skal acceptere brugerbetingelserne for at oprette en konto.",
      kode: "vilkaar",
      vilkaar_version: VILKAAR_VERSION,
    });
  }

  const graense = await tjekGraenserLukket([["opret_ip", ip], ["gensend_email", email]]);
  if (graense === "for_mange") return svar(429, FOR_MANGE);
  if (graense === "fejl") return svar(503, IKKE_TILGAENGELIG);

  // Kaster aldrig; fejl logges i /admin/drift. Svaret er det samme uanset udfald.
  await opretKontoPaaServeren({ email, fornavn, efternavn });
  return svar(200, { ok: true });
}
