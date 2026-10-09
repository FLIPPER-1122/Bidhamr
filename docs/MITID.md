# MitID-verificering (Idura Verify, tidligere Criipto)

Regler: `ROADMAP-BESLUTNINGER.md`, "MitID (Filip, 9. okt. 2026)". Database:
`supabase/migrations/20261013010000_mitid.sql`.

## Kort fortalt

- Man kan oprette konto og kigge uden MitID.
- MitID kræves **før første bud** (også maksimum/automatisk bud) og **før første
  auktion** (opret, sæt op igen/genopsæt, tilbud til næste byder). Håndhæves i
  databasen med triggere, så det også gælder appen:
  - `bids` (a3_bids_mitid – kun brugerens egne bud, ikke autobud-motorens)
  - `bud_maksimum` (a0_bud_maksimum_mitid – nyt maksimum eller ændret beløb)
  - `auctions` (auctions_a0_mitid – alle nye auktioner)
  - `andenchance_tilbud` (a0_andenchance_mitid – sælgerens tilbud)
- Fejlkode **`BHV01`**, besked `mitid_mangler: Bekræft dig med MitID, før du byder eller sætter varer til salg. Det gør du kun én gang.`
- Firmakonti (`users.konto_type = 'erhverv'`) er undtaget.
- Én MitID = én konto: kun en HMAC-SHA256 af MitIDs Person-ID (claim `uuid`)
  gemmes (`mitid_verificeringer.id_hash`, unik blandt aktive). Aldrig CPR –
  der bedes ikke om scope `ssn`.
- 18 år: fødselsdato (`birthdate`) fra MitID. Under 18 afvises.
- Navnet fra MitID (`name`) gemmes som juridisk navn – kun brugeren selv og
  staff kan læse det (RLS). Offentligt: `users.mitid_verificeret_kl`
  (mærket "MitID-verificeret").

## Flow (hjemmesiden)

1. Knappen "Bekræft med MitID" er et link til
   `GET /api/mitid/start?retur=/auktion/<id>` (kræver login).
2. Ruten laver et forløb i `mitid_flow` (state-hash, nonce, PKCE-verifier,
   10 min), sætter cookien `bh_mitid` (state, httpOnly, SameSite=Lax, sti
   `/api/mitid`) og sender brugeren til Idura (`acr_values=urn:grn:authn:dk:mitid:substantial`,
   `prompt=login`, `code_challenge_method=S256`).
3. Idura sender tilbage til `GET /api/mitid/callback?code=…&state=…`.
   Callbacken tjekker cookie = state, forbruger forløbet atomisk (én gang),
   kræver at samme bruger stadig er logget ind, bytter koden med
   client secret (Basic) + PKCE-verifier, verificerer `id_token` (RS256 mod
   JWKS, issuer, audience/azp, exp, iat, nonce, `identityscheme = dkmitid`,
   niveau mindst betydelig) og kalder `mitid_registrer` (service_role).
4. Brugeren sendes tilbage til `retur` med `?mitid=<resultat>`; beskeden vises
   øverst på siden (`src/components/mitid/MitIDResultat.tsx`).

Resultater: `ok`, `allerede`, `afbrudt`, `dobbeltkonto`, `under18`, `lukket`,
`andenMitid`, `erhverv`, `udloebet`, `fejl`, `ikkeTilgaengelig`, `forMange`
(tekster i `src/lib/tekster/mitid.ts`).

**Hvorfor "betydelig" (substantial):** MitID-app/kodeviser + PIN – det niveau,
Idura anbefaler, og som svarer til NSIS "betydelig". "Lav" er for svagt til at
forhindre dobbeltkonti; "høj" kræver chip og er for besværligt for en
markedsplads.

## Appen (Expo)

Appen bruger hjemmesidens server – ingen hemmeligheder i appen.

1. `POST https://bidhamr.dk/api/mitid/app` med `Authorization: Bearer <Supabase access token>`.
   Svar `200 { url, udloeber }` – `url` er `https://bidhamr.dk/api/mitid/start?t=<engangs-token>`
   (gyldig i 2 minutter, kan bruges én gang; kun SHA-256 af tokenet gemmes).
   Fejl: `401 ikke_logget_ind`, `409 allerede | erhverv`, `429 for_mange`,
   `503 ikke_tilgaengelig`, `500 fejl` (JSON `{ fejl, kode }`).
2. Åbn `url` i en in-app browser med callback-skemaet `bidhamr://mitid`:

   ```ts
   import * as WebBrowser from "expo-web-browser";
   const r = await fetch(`${SITE}/api/mitid/app`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` } });
   const { url } = await r.json();
   const res = await WebBrowser.openAuthSessionAsync(url, "bidhamr://mitid");
   if (res.type === "success") {
     const status = new URL(res.url).searchParams.get("status"); // ok | dobbeltkonto | under18 | …
     // Vis teksten fra MITID.resultat[status], og hent profilen igen.
   }
   ```
3. Efter MitID ender in-app browseren på `bidhamr://mitid?status=<resultat>`
   (samme værdier som `?mitid=` på hjemmesiden). Skemaet kan ændres med
   `MITID_APP_RETUR` (kun et eget app-skema – aldrig http/https).
4. Appen skal kende fejlkoden **BHV01** på `bids`-insert, `saet_maksimum`,
   `auctions`-insert og vise "Bekræft med MitID" – og vise mærket
   "MitID-verificeret" ud fra `users.mitid_verificeret_kl` (kan læses af alle).
   Egen status: `users.mitid_verificeret_kl` og `mitid_verificeringer`
   (kun egne rækker). `mine_data()` har nu en `mitid`-nøgle.

Krav i appen: deep link-skemaet `bidhamr` skal være registreret (`scheme` i
`app.json`). Bemærk: in-app browseren har ingen hjemmeside-session – det er
engangs-tokenet, der binder forløbet til brugeren.

## Admin

- Brugersiden (`/admin/brugere/<id>`): status, tidspunkt, juridisk navn og
  fødselsdato (kun internt), historik og forsøg. "Nulstil MitID" (admin/chef;
  staff-konti kun chef; ikke sig selv; ikke ved inhabilitet – handlet med
  brugeren; ikke lukkede konti). Logges i `moderation_log` (`mitid_nulstillet`).
- Mistænkelig aktivitet (`/admin/brugere/mistaenkelig`): "MitID – mulige
  dobbeltkonti" (`admin_mitid_forsoeg()`), kan markeres som gennemgået
  (`mitid_forsoeg_behandlet`).

## Kontosletning (chefens valg)

- Hashen bevares (status `slettet`), så en lukket konto aldrig kan få en ny
  konto verificeret, og så staff ser det, når en slettet bruger kommer igen
  (`mitid_forsoeg.aarsag = 'tidligere_slettet'` – tilladt, men markeret).
- Navn og fødselsdato bevares kun, hvis brugeren har handler (handelsdata/DAC7).
- Permanent lukkede konti: MitID'en kan aldrig bruges igen (uanset status).

## Miljøvariabler

| Variabel | Test (`.env.local`) | Produktion (Vercel) |
|---|---|---|
| `CRIIPTO_DOMAIN` | `bidhamr-test.test.idura.broker` | produktionsdomænet fra Idura (fx `bidhamr.idura.broker` eller eget domæne) |
| `CRIIPTO_CLIENT_ID` | fra Idura (test) | fra Idura (produktion) |
| `CRIIPTO_CLIENT_SECRET` | fra Idura (test) | fra Idura (produktion) |
| `MITID_HASH_NOEGLE` | tilfældig, mindst 32 tegn | **ny** tilfældig, mindst 32 tegn – må **aldrig** skiftes eller mistes |
| `MITID_CALLBACK_URL` | (valgfri) | (valgfri – standard `https://bidhamr.dk/api/mitid/callback`) |
| `MITID_APP_RETUR` | (valgfri, standard `bidhamr://mitid`) | (valgfri) |

**bidhamr.dk skal være den faste adresse** (www.bidhamr.dk skal omdirigere til
bidhamr.dk i Vercel): state-cookien sættes på det domæne, flowet startes fra,
og callbacken ligger altid på `https://bidhamr.dk/api/mitid/callback`.

Generér en nøgle: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
Mangler en variabel, viser knappen "MitID er ikke tilgængelig lige nu" (fail closed).

## Test

- `supabase/seed.sql`: de private testbrugere er verificeret med et falsk id.
  `mitid-a@` og `mitid-b@` starter uden MitID. Brug Iduras test-MitID
  (MitID Test Tool på pp.mitid.dk + app-simulatoren) til selve login.
- Dobbeltkonto: verificér `mitid-a@`, log ind som `mitid-b@`, og brug samme
  test-MitID → "Dit MitID er allerede brugt …", og forsøget vises under
  Mistænkelig aktivitet.
