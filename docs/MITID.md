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

Appen bruger hjemmesidens server – ingen Idura-hemmeligheder i appen.

**Sikkerhed (vigtigt):** callbacken registrerer IKKE appens forløb. Ellers
kunne en angriber starte et forløb på sin egen konto og sende linket til et
offer, der så bekræftede angriberens konto med sit MitID (phishing). I stedet
gemmes den verificerede identitet på forløbet i højst 5 minutter, og appen
afslutter selv – kun med samme Bearer-session som ved start og med en
app-hemmelighed, som kun appen kender.

1. Lav en tilfældig **app-hemmelighed** (mindst 32 bytes, fx
   `Crypto.getRandomBytesAsync(32)` → hex) og hold den kun i hukommelsen.
2. `POST https://bidhamr.dk/api/mitid/app` med `Authorization: Bearer <Supabase access token>`
   og JSON `{ "hemmelighed_hash": "<hex SHA-256 af hemmeligheden>" }`.
   Svar `200 { url, udloeber }` – `url` er `https://bidhamr.dk/api/mitid/start?t=<engangs-token>`
   (gyldig i 2 minutter, kan bruges én gang; kun SHA-256 af tokenet gemmes).
   Fejl: `400 ugyldig`, `401 ikke_logget_ind`, `409 allerede | erhverv`,
   `429 for_mange`, `503 ikke_tilgaengelig`, `500 fejl` (JSON `{ fejl, kode }`).
3. Åbn `url` i en in-app browser med callback-skemaet `bidhamr://mitid`.
4. Efter MitID ender in-app browseren på
   - `bidhamr://mitid?k=<engangs-id>` – MitID gennemført, appen skal afslutte, eller
   - `bidhamr://mitid?status=<resultat>` – afbrudt/udløbet/fejl (intet at afslutte).
5. Afslut: `POST https://bidhamr.dk/api/mitid/app/afslut` med samme Bearer-token og
   JSON `{ "k": "<engangs-id>", "hemmelighed": "<hemmeligheden i klartekst>" }`.
   Svar `200 { status, besked }` (`ok`, `allerede`, `dobbeltkonto`, `under18`,
   `lukket`, `tidligereSpaerret`, `andenMitid`, `erhverv`, `udloebet`, `fejl`).
   Kan bruges én gang og kun inden for 5 minutter; forkert bruger eller
   hemmelighed giver `udloebet`.

   ```ts
   import * as WebBrowser from "expo-web-browser";
   import * as Crypto from "expo-crypto";

   const bytes = await Crypto.getRandomBytesAsync(32);
   const hemmelighed = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
   const hemmelighed_hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, hemmelighed);
   const auth = { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };

   const r = await fetch(`${SITE}/api/mitid/app`, { method: "POST", headers: auth, body: JSON.stringify({ hemmelighed_hash }) });
   const { url } = await r.json();
   const res = await WebBrowser.openAuthSessionAsync(url, "bidhamr://mitid");
   if (res.type === "success") {
     const q = new URL(res.url).searchParams;
     const k = q.get("k");
     const svar = k
       ? await (await fetch(`${SITE}/api/mitid/app/afslut`, { method: "POST", headers: auth, body: JSON.stringify({ k, hemmelighed }) })).json()
       : { status: q.get("status") };
     // Vis teksten (svar.besked eller MITID.resultat[svar.status]), og hent profilen igen.
   }
   ```
6. Skemaet kan ændres med `MITID_APP_RETUR` (kun et eget app-skema – aldrig http/https).
7. Appen skal kende fejlkoden **BHV01** på `bids`-insert, `saet_maksimum`,
   `auctions`-insert og vise "Bekræft med MitID" – og vise mærket
   "MitID-verificeret" ud fra `users.mitid_verificeret_kl` (kan læses af alle;
   ikke for firmakonti). Har brugeren et maksimumbud uden MitID: vis
   "Bekræft med MitID for at fortsætte dit maksimumbud." Egen status:
   `users.mitid_verificeret_kl` og `mitid_verificeringer` (kun egne rækker).
   `mine_data()` har en `mitid`-nøgle. Kontosletning kan nu blokeres af
   typen `suspenderet`.

Krav i appen: deep link-skemaet `bidhamr` skal være registreret (`scheme` i
`app.json`).

## Admin

- Brugersiden (`/admin/brugere/<id>`): status, tidspunkt, juridisk navn og
  fødselsdato (kun internt), historik og forsøg. "Nulstil MitID" (admin/chef;
  staff-konti kun chef; ikke sig selv; ikke ved inhabilitet – handlet med
  brugeren; ikke lukkede konti). Logges i `moderation_log` (`mitid_nulstillet`).
- Mistænkelig aktivitet (`/admin/brugere/mistaenkelig`): "MitID – mulige
  dobbeltkonti" (`admin_mitid_forsoeg()`), kan markeres som gennemgået
  (`mitid_forsoeg_behandlet`).

## Kontosletning og maksimumbud (chefens valg)

- Kontoen kan ikke slettes, mens den er suspenderet ("Du kan ikke slette din
  konto, mens den er suspenderet"). Advarsler blokerer ikke sletning (GDPR).
- Ved sletning gemmes suspensionsflag og antal advarsler på MitID-rækken. En
  ny konto med samme MitID afvises (`tidligere_spaerret`), hvis den slettede
  konto var suspenderet, lukket eller havde 3 advarsler; ellers tilladt, men
  markeret til staff (`tidligere_slettet`, med antal advarsler).
- Maksimumbud fra brugere uden MitID afgiver ikke flere automatiske bud
  (`autobud_maa_byde`) – også maksima sat før migrationen. Afgivne bud står.
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

## Go-live (Filip)

1. **www.bidhamr.dk SKAL omdirigere til bidhamr.dk i Vercel** (Project →
   Settings → Domains: `bidhamr.dk` som primært domæne, `www.bidhamr.dk` →
   "Redirect to bidhamr.dk"). State-cookien sættes på det domæne, flowet
   startes fra, og callbacken ligger altid på `https://bidhamr.dk/api/mitid/callback`
   – uden omdirigering fejler MitID for alle, der kommer ind via www.
2. Idura: produktions-application, callback `https://bidhamr.dk/api/mitid/callback`,
   databehandleraftale og MitID-ansøgning.
3. Vercel-variablerne i tabellen ovenfor (ny `MITID_HASH_NOEGLE`).
4. Kør `20261013010000_mitid.sql` i produktion (Filips "ja") – først når
   appen kan MitID, ellers kan appbrugere uden MitID ikke byde/sælge.

Generér en nøgle: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
Mangler en variabel, viser knappen "MitID er ikke tilgængelig lige nu" (fail closed).

## Test

- `supabase/seed.sql`: de private testbrugere er verificeret med et falsk id.
  `mitid-a@` og `mitid-b@` starter uden MitID. Brug Iduras test-MitID
  (MitID Test Tool på pp.mitid.dk + app-simulatoren) til selve login.
- Dobbeltkonto: verificér `mitid-a@`, log ind som `mitid-b@`, og brug samme
  test-MitID → "Dit MitID er allerede brugt …", og forsøget vises under
  Mistænkelig aktivitet.
