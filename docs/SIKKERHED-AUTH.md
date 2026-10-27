# Login-sikkerhed: CAPTCHA og lofter i Supabase Auth (H1)

Sikkerhedsgennemgangen 27. okt. 2026 fandt, at adgangskoder kan gættes direkte
mod Supabase Auth (`/auth/v1/token?grant_type=password` med den offentlige
nøgle), uden om hjemmesidens egne lofter. Det kan kun lukkes i Supabase og
Cloudflare. **Koden er klar** - intet ændrer sig, før Filip sætter nøglerne og
slår det til.

## Hvad koden gør nu

| Sted | Hvad sker der med CAPTCHA |
|---|---|
| Login (`/login`, `logInd` i `src/app/actions/auth.ts`) | Turnstile-feltet vises, og tokenet sendes til `signInWithPassword` som `options.captchaToken`. |
| Glemt adgangskode (`/glemt-adgangskode`, `nulstilAdgangskode`) | Tokenet sendes til `resetPasswordForEmail` som `captchaToken`. |
| Opret konto (`/signup`, `opretKonto`) | Kontoen oprettes med `generateLink` på serveren (ingen CAPTCHA i Supabase), så **serveren tjekker selv** tokenet hos Cloudflare med `TURNSTILE_SECRET_KEY` (`src/lib/turnstileServer.ts`). |
| Appen: `POST /api/konto/opret` | Samme servertjek - feltet `captchaToken` i JSON-kroppen. |
| Appen: `POST /api/konto/glemt` | `captchaToken` i kroppen sendes videre til Supabase. |
| Appen: `POST /api/konto/bekraeft` | Ingen ændring: den kalder kun `verifyOtp`, som Supabase ikke beskytter med CAPTCHA. |
| Bekræft adgangskode før skift af adgangskode / sletning af konto (`src/lib/bekraeftAdgangskode.ts`) | Tjekket sker med den hemmelige nøgle (service role), som Supabase undtager fra CAPTCHA. Brugeren er allerede logget ind, og kalderne har egne lofter. |
| Staff-login og gendannelse på admin-hosten (`src/lib/adgang.ts`) | Login sker med den hemmelige nøgle (`src/lib/supabase/adgangskodeLogin.ts`) og lægges i cookies med `setSession`. Før login slås e-mailen op med service role: kun aktive staff-konti (medarbejder, admin, chef, saelger - ikke lukket, slettet eller suspenderet) logges ind; alle andre får "Forkert e-mail eller adgangskode" uden login. Alle svar tager mindst 2 sek., så svartiden ikke afslører, om e-mailen findes. Lofter: admin_login_ip, admin_login_email_ip og admin_login_email (10 pr. 15 min. pr. e-mail). Kræver to-trins-login bagefter. |

- Uden `NEXT_PUBLIC_TURNSTILE_SITE_KEY` vises intet felt og sendes intet token.
- Uden begge nøgler springer serveren sit eget tjek over (opret konto). Er kun den ene sat, afvises oprettelse af konto, og der logges en drift-advarsel (/admin/drift).
- Serveren godtager kun tokens fra vores værter (`hostname`: bidhamr.dk, www.bidhamr.dk, test.bidhamr.dk, værten i NEXT_PUBLIC_SITE_URL, ekstra i `TURNSTILE_VAERTER`, kommasepareret; localhost i udvikling) og fra formularen "opret" (`action`) på hjemmesiden. Med Cloudflares testnøgler tjekkes vært og action ikke.
- CSP (`src/lib/csp.ts`) tillader `https://challenges.cloudflare.com` (script,
  iframe, kald) på hjemmesiden, når site-nøglen er sat. Admin-hosten bruger
  ikke Turnstile.
- Et token kan kun bruges én gang. Formularerne laver et nyt efter hvert
  mislykket forsøg.
- Fejltekster: "Vent et øjeblik, mens vi tjekker, at du ikke er en robot – prøv
  så igen." (intet token endnu) og "Vi kunne ikke bekræfte, at du ikke er en
  robot. …" (Supabase/Cloudflare afviste tokenet). Appens endpoints svarer
  `400 { kode: "captcha" }`.

## Rækkefølge for Filip

Gør det først på **testprojektet (Bidhamr Test)** og test.bidhamr.dk, og først
bagefter på produktion. Appen skal kunne sende tokenet (se nederst), før
CAPTCHA slås til i det Supabase-projekt, appen bruger - ellers kan appen ikke
logge ind.

### 1. Cloudflare Turnstile

1. Cloudflare-dashboardet → **Turnstile** → **Add widget**.
2. Navn: `BidHamr`. Domæner: `bidhamr.dk`, `www.bidhamr.dk`,
   `test.bidhamr.dk` og `localhost` (til udvikling). Widget mode: **Managed**.
3. Kopiér **Site Key** og **Secret Key**.

### 2. Vercel (miljøvariabler)

Sæt på begge projekter (`bidhamr` og `bidhamr-test`):

- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` = site-nøglen
- `TURNSTILE_SECRET_KEY` = den hemmelige nøgle (kun server - aldrig `NEXT_PUBLIC_`)

Lokalt i `.env.local` kan Cloudflares testnøgler bruges:
`NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA` og
`TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` (altid godkendt).

Redeploy, og tjek at feltet vises på /login, /glemt-adgangskode og /signup.

### 3. Supabase (Authentication)

Supabase-dashboardet for projektet → **Authentication**:

1. **Attack Protection → Enable Captcha protection**: til. Provider:
   **Cloudflare Turnstile**. Secret: den samme hemmelige nøgle som i Vercel.
2. **Attack Protection → Prevent use of leaked passwords**: til (kræver Pro).
   Vores egne krav (mindst 10 tegn m.m.) gælder stadig.
3. **Rate Limits**: sæt "Sign-ins and sign-ups" (token-endpointet) ned, fx
   30 pr. 5 minutter pr. IP, og "Token verifications" tilsvarende. Lad
   "Emails sent" følge Resend-opsætningen.
4. **Sign In / Providers → Email**: "Minimum password length" 10 (som
   hjemmesiden), "Password requirements" efter behov.
5. "Allow new users to sign up" forbliver **slået fra** (som i dag).
6. **Sign In / Providers → Email**: "Confirm email" skal være **slået til**
   (som i dag), og "Secure email change" skal være **slået til** (Supabase'
   standard). Skift af e-mail går ikke via Supabase' eget flow, men via
   serveren (`src/lib/emailSkift.ts`, kode til den nye adresse + admin-API).
   Databasen afviser Supabase' eget e-mail-skift (`updateUser({ email })`)
   med en trigger (`20261102120000_skift_email.sql`). De to indstillinger er
   ekstra værn, hvis triggeren en dag mangler: med "Confirm email" slået fra
   ville `updateUser({ email })` skifte adressen med det samme uden kode, og
   med "Secure email change" slået fra skulle kun den nye adresse bekræfte.
   Skabelonen "Change Email Address" bruges ikke.

### 4. Test efter at det er slået til

På test.bidhamr.dk med en testbruger:

- Log ind, glemt adgangskode, opret konto (kode i mailen) - med og uden at
  vente på feltet.
- Skift adgangskode og slet konto (bekræft adgangskode) - skal virke uden felt.
- Staff-login og "Brug gendannelseskode" på admin-hosten.
- Et direkte kald uden token skal afvises:
  `curl -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -d '{"email":"…","password":"…"}'`
  skal give `captcha_failed`.

Virker bekræft adgangskode eller staff-login ikke efter punkt 3, er det
undtagelsen for service role, der ikke gælder - giv besked, så laves en anden
løsning, før det slås til i produktion.

## Appen (Expo) - skal bygges, før CAPTCHA slås til for appens projekt

Appen kalder i dag `supabase.auth.signInWithPassword` direkte. Når CAPTCHA er
slået til, skal kaldet have `options: { captchaToken }`:

- **Anbefalet: Turnstile i en WebView.** En lille side på hjemmesiden (fx
  `/app/turnstile`, kun Turnstile-feltet) åbnes i `react-native-webview`;
  siden sender tokenet til appen med `window.ReactNativeWebView.postMessage`.
  Domænet skal stå på widgettens domæneliste. Tokenet bruges med det samme
  (det udløber efter 5 minutter og kan kun bruges én gang).
- Bruges til: login (`signInWithPassword`), `POST /api/konto/opret`
  (`captchaToken` i kroppen) og `POST /api/konto/glemt` (`captchaToken` i
  kroppen).
- Alternativ: login via et nyt server-endpoint, der selv tjekker en
  enhedsattest (Play Integrity / App Attest) - mere arbejde, ingen WebView.
  Ikke bygget.
- Fejl: Supabase svarer `captcha_failed`; vores endpoints `400 { kode: "captcha" }`.
  Vis "Vi kunne ikke bekræfte, at du ikke er en robot. Prøv igen." og lav et
  nyt token.

## Andet fra gennemgangen, som kun Filip kan gøre

- **pg_net (L1):** migrationen `20261102060000` prøver at lukke skemaet `net`
  for `anon` og `authenticated`, men rettighederne er givet af
  `supabase_admin`, så rollen `postgres` kan ikke tilbagekalde dem (intet
  sker). Skemaet er ikke eksponeret i API'et (kun `public` og
  `graphql_public`), så det kan ikke kaldes via REST. pg_net bruges af
  cron-jobbene (`net.http_post` til `/api/cron/...`), så udvidelsen må **ikke**
  slås fra. Vil du lukke det helt, så bed Supabase-support om at køre
  `revoke execute on all functions in schema net from anon, authenticated;`
  og `revoke usage on schema net from anon, authenticated;` som
  `supabase_admin` (cron kører som `postgres` og påvirkes ikke).
