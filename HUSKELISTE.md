# Huskeliste til Filip

## Lancering – slå den rigtige forside til
I dag viser bidhamr.dk `/coming-soon` for alle uden staff-rolle. Den rigtige forside og resten af siden åbnes med **én kontakt**:
- **Vercel → Project → Settings → Environment Variables → `LANCERET` = `1`** (kun miljøet *Production*), og **deploy igen** (Deployments → Redeploy). Variablen virker først efter en ny deploy.
- Hvad sker der: besøgende uden login ser forsiden, søgning, auktioner, offentlige profiler og tekstsiderne. Alt andet (Min konto, Mine handler, Opret auktion, beskeder ...) sender til login. Indloggede brugere kommer ind overalt, firmakonti får hele siden, og `/coming-soon` sender videre til forsiden. Admin er stadig kun for staff.
- Fail closed: alt andet end præcis `1` (eller `true`) holder siden lukket. Fortryder du, så slet variablen og deploy igen.
- Samme dag (separate kontakter): `TILMELDING_AABEN=true` (åbner oprettelse af konti) og `SEO_INDEKSERING=true` (lader Google indeksere siden).
- **"Allow new users to sign up" skal ALTID være slået fra i Supabase** (Authentication → Sign In / Providers), også efter lancering. Tjek det i **Hamr** (produktion) og **Bidhamr Test**. Alle konti oprettes på serveren (hjemmesiden og appens `POST /api/konto/opret`, se docs/APP-SIGNUP.md) med en tilfældig adgangskode, og den valgte adgangskode sættes først, når koden fra mailen er indtastet. Hvorfor: med direkte `signUp` kunne en fremmed oprette kontoen først med en andens e-mail og sin egen adgangskode og overtage kontoen, når den rigtige ejer bekræftede.
- **Kør migrationen `supabase/migrations/20261018010000_signup_billet_altid.sql` før lanceringen** (testdatabasen først, så produktion med dit ja). Så afviser databasen enhver ny konto, som serveren ikke har lagt en billet til (bundet til serverens eget kald med et engangs-nonce) – også hvis "Allow new users to sign up" ved en fejl bliver slået til. Kør den først, når den nye signup-kode er deployet (ellers afvises nye konti fra den gamle kode). Efter migrationen kan appens gamle `signUp` ikke oprette konti – appen skal bruge `POST /api/konto/opret` (ROADMAP fase 5).
- **Samme dag som `TILMELDING_AABEN=true`: slå invitationsværnet i databasen fra.** Ellers får kun inviterede en konto, og `/admin/drift` viser "Databasen gav ingen billet til en ny konto" (eller "Supabase afviste en ny konto"). Det er en migration (dit ja) med én linje: `update public.beta_indstillinger set kun_inviterede = false;`. Billet-værnet bliver ved med at gælde. Luk også beta-testen under Admin → Beta-invitationer, hvis den stadig er åben (se "Beta-test" herunder).
- **Opret bruger / Invite user i Supabase-dashboardet virker aldrig** efter migrationen (der er ingen billet). Testbrugere oprettes via `supabase/seed.sql`, firmakonti under Admin → Erhverv.
- Lokalt (`npm run dev`, testdatabasen) er siden altid "lanceret", så forsiden kan ses på http://localhost:3000. `SIMULER_FOER_LANCERING=true` i `.env.local` viser den lukkede udgave med coming-soon. `LANCERET` har ingen virkning på testdatabasen. `SIMULER_TILMELDING_LUKKET=true` lukker tilmeldingen lokalt, så beta-tilmeldingen kan testes.

## Beta-test – invitationer (se docs/BETA-TEST.md afsnit 3)
- **Sæt `SIGNUP_ADGANGSKODE_HEMMELIGHED` i Vercel** (Production), før testen starter: en lang, tilfældig værdi, fx fra `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Den krypterer den valgte adgangskode, mens e-mailen bekræftes. Mangler den, bruges en nøgle afledt af service-role-nøglen (virker, men en egen nøgle er bedre).
- **Kør først migrationen** `supabase/migrations/20261017010000_beta_invitationer.sql` (testdatabasen først, så produktion med dit ja). Den laver invitationslisten, kontakten og databasens tilmeldingsværn. I produktion starter beta-testen **lukket**, og værnet er **slået til**.
- **Sådan inviterer du:** Admin → Indstillinger → **Beta-invitationer** (admin og chef). Skriv e-mailen (og evt. en note, fx alder og telefon), og tryk **Send invitation**. Personen får en mail med et link til "Opret konto". Kun netop den e-mail kan oprette en konto. Har e-mailen allerede en konto, står der i mailen, at personen bare skal logge ind.
- **Åbn testen:** samme side, **Åbn beta-testen** (kun chef). Først da kan de inviterede oprette sig og komme forbi coming-soon. De kan bruge hele den private del af siden, men aldrig admin. Firmakonti og staff følger deres egne regler.
- **Status pr. invitation:** Inviteret → Oprettet konto → MitID-verificeret, eller Tilbagekaldt. "Send igen" sender mailen igen (højst 10 gange, højst én gang i minuttet).
- **Tilbagekald én person:** **Tilbagekald** ved personen. Personen ser coming-soon igen inden for 5 minutter. Kontoen og alle data bevares. **Invitér igen** genaktiverer.
- **Luk hele testen med ét klik:** **Luk beta-testen** (kun chef). Alle beta-testere ser coming-soon igen inden for 5 minutter, og ingen kan oprette sig med en invitation. Konti, handler og data bevares. Du kan åbne igen med ét klik.
- **Opret bruger i Supabase-dashboardet virker ikke** (databasen afviser alle nye konti uden en billet fra serveren). Invitér e-mailen, så personen selv opretter sig, eller opret firmakonti under Admin → Erhverv som før (den lægger selv en billet).
- **Ved lancering:** luk beta-testen og slå værnet fra (se "Lancering" ovenfor). Beta-adgangen har så ingen betydning, fordi alle kommer ind.

## MitID (Idura) – før det går live (se docs/MITID.md, "Go-live")
- **www.bidhamr.dk SKAL omdirigere til bidhamr.dk** (Vercel → Project → Settings → Domains: sæt `bidhamr.dk` som primært domæne og `www.bidhamr.dk` til "Redirect to bidhamr.dk"). Ellers virker MitID ikke for dem, der kommer ind via www (cookien sættes på www, men Idura sender tilbage til bidhamr.dk).
- Idura: opret produktions-application, callback `https://bidhamr.dk/api/mitid/callback`, godkend databehandleraftalen og MitID-ansøgningen.
- Vercel-variabler: `CRIIPTO_DOMAIN`, `CRIIPTO_CLIENT_ID`, `CRIIPTO_CLIENT_SECRET`, `MITID_HASH_NOEGLE` (ny, tilfældig, mindst 32 tegn – må aldrig skiftes).
- (Lokalt er `MITID_HASH_NOEGLE` allerede sat i `.env.local`.)
- Før lancering (fra reviewer): brug et verificeret Universal Link/App Link (`https://bidhamr.dk/...`) som returadresse for appen i stedet for `bidhamr://`, og kør `mitid_flow_oprydning` fra betalings-cron, så MitID-data fra uafsluttede app-forløb slettes efter 5 min.
- Kør `20261013010000_mitid.sql` i produktion (dit "ja") først, når appen kan MitID (BHV01 + `/api/mitid/app` + `/api/mitid/app/afslut`).

## Vagt udefra på betalings-cron'en (healthchecks.io, gratis – ca. 10 min)
Hvis betalings-cron'en holder op med at køre (pg_cron, Vercel eller Supabase står stille), kan siden ikke selv sige det. En ekstern "dead man's switch" giver alarm, når der ikke er kommet et livstegn i 30 minutter.
1. Opret en gratis konto på https://healthchecks.io (gratis plan: 20 checks, mail-alarmer).
2. **Add Check**: navn `bidhamr betalings-cron`, **Period 5 minutes**, **Grace Time 25 minutes** (= alarm efter 30 min uden vellykket kørsel). Under *Integrations* slår du mail til (og gerne appen/Slack/SMS, hvis du vil).
3. Kopiér checkens **ping-URL** (`https://hc-ping.com/<uuid>`).
4. **Vercel → Project → Settings → Environment Variables → `CRON_HEALTHCHECK_URL`** = ping-URL'en (kun *Production*). Deploy igen.
5. Tjek efter 5-10 minutter i healthchecks.io, at checken står grøn ("up") og får et ping hvert 5. minut.
- Hvad sker der: cron'en pinger URL'en efter hver **vellykket** kørsel. Fejler et pengetrin, sendes kun en logbesked (`/log` – ændrer ikke status), så alarmen kommer, når der har været 30 min uden succes. Står cron'en helt stille, kommer der ingen ping – og så kommer alarmen også. Uden variablen sker der intet. Pinget indeholder ingen persondata.
- Lokalt og på testdatabasen: sæt den ikke (eller brug en separat check).
- Den gamle `HEARTBEAT_URL` virker stadig (pinger `/fail` ved hver fejl = alarm med det samme). Brug kun den ene af dem til samme check.

## Mail på bidhamr.dk (når erhvervskonto og CVR er på plads)
- Google Workspace **Starter**, **1 bruger**, gerne **månedlig** betaling: opret `filip@bidhamr.dk`
- Opret `support@bidhamr.dk`, `erhverv@bidhamr.dk` og `faktura@bidhamr.dk` som gratis **grupper** i Google Admin (erhverv@ bruges af firmaer – Filip, 7. okt. 2026)
- Tilføj Googles MX/TXT-poster hos One.com – **slet ingen** eksisterende poster (Resend/Vercel), og der må kun være **én** SPF-post (flet dem)
- Skift faktura-mail hos Stripe, Vercel, Supabase, Google, One.com, Resend m.fl. til `faktura@bidhamr.dk`

---

# Tidligere noter

Testdatabasen er sat op (commit 3e22009). Det her mangler:

## Gør først (5 min)
1. **Udfyld to felter i `.env.local`** med nøglerne fra Supabase → **Bidhamr Test** (IKKE "Hamr") → Project Settings → API Keys:
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_…`-nøglen (gammelt navn: `NEXT_PUBLIC_SUPABASE_ANON_KEY` med "anon public"-nøglen)
   - `SUPABASE_SECRET_KEY` = `sb_secret_…`-nøglen (gammelt navn: `SUPABASE_SERVICE_ROLE_KEY` med "service_role"-nøglen)
   - Se `.env.example` for alle navne.
2. **Genstart dev-serveren** (stop `npm run dev` og start den igen).
3. **Log ind på localhost med `chef@test.bidhamr.dk`** – adgangskoden står øverst i `supabase/seed.sql`. Din egen konto findes ikke i testdatabasen.
4. Tjek at designet og coming-soon-siden ser rigtige ud. Er du tilfreds: commit og push, og sæt `[x]` ved de færdige fase 0-punkter i `ROADMAP.md`.

## Tre beslutninger, Claude Code venter på
1. **Skal "gaten" kunne åbnes på testdatabasen?** I dag kommer kun staff forbi coming-soon, så almindelige testbrugere (køber/sælger) kan ikke teste som rigtige brugere. Anbefaling: ja – åbn gaten kun på testdatabasen, aldrig på bidhamr.dk.
2. **Slet det fejlende cron-job i produktion.** Jobbet `afslut-auktioner` fejler hvert minut (pg_net er ikke installeret). Det rigtige job `afslut-udloebne-auktioner` virker. Anbefaling: ja, slet det – det kræver dit ja, fordi det er produktion.
3. **Stop mails fra dev-serveren.** Resend sender stadig mails fra localhost til falske `@test.bidhamr.dk`-adresser. Mange mails, der ikke kan leveres, kan skade bidhamr.dk's omdømme som afsender, så dine rigtige mails havner i spam. Anbefaling: slå mails fra på testdatabasen (log dem i stedet), eller send dem kun til din egen mail.

## Godt at vide
- Produktion indeholdt tabeller og kolonner, der aldrig stod i en migration (formentlig lavet direkte i Supabase til appen). Det er nu indfanget i `20260930130000_indfang_prod_drift.sql`. **Fremover: lav ikke ændringer direkte i Supabase til appen** – bed Claude Code lave en migration, så web, app og testdatabase holder sig i trit.
- Næste store skridt er **fase 1: betalingen med Stripe**. Tjek mailen for svar fra Stripes team først.

Svar til Claude Code, når du har besluttet dig, fx:
> 1. Ja, åbn gaten kun på testdatabasen. 2. Ja, slet cron-jobbet afslut-auktioner i produktion. 3. Slå mails fra i dev – log dem i stedet.
