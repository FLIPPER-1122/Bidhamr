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

## Fragt via Shipmondo – DAO, GLS og PostNord (se docs/FRAGT.md, "Shipmondo")
- **Rækkefølge:** (1) kør migrationen `supabase/migrations/20261024010000_fragt_shipmondo_transportoer.sql` i produktion (dit "ja") – den er kørt to gange på testdatabasen; (2) deploy koden (den læser kolonnen `transportoer`); (3) sæt variablerne herunder og deploy igen. Sæt ikke `FRAGTFIRMA=shipmondo` før trin 2 – den gamle kode sender ikke køberens fragtfirma, som databasen nu kræver.
- **Vercel (Production):** `FRAGTFIRMA=shipmondo`, `SHIPMONDO_API_URL=https://app.shipmondo.com/api/public/v3`, `SHIPMONDO_API_BRUGER` og `SHIPMONDO_API_NOEGLE` (fra Shipmondo → Indstillinger → API, produktionskontoen – ikke sandboxen), `SHIPMONDO_WEBHOOK_NOEGLE` (en lang, tilfældig værdi, fx `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Valgfrit: `SHIPMONDO_EGEN_AFTALE=true`, hvis du booker på jeres egne aftaler hos DAO/GLS/PostNord i Shipmondo.
- **Opret de to webhooks** i Shipmondo (Indstillinger → Webhooks), "Shipment Monitor" med action **latest** og **delivered**, endpoint `https://bidhamr.dk/api/fragt/webhook/shipmondo` og nøglen = `SHIPMONDO_WEBHOOK_NOEGLE` (se docs/FRAGT.md, "Opret webhooken").
- **Labels slås til** med `FRAGT_LABELS_AKTIV=true` og returkoder i sager med `FRAGT_RETURLABEL_AKTIV=true`, når du har testet.
- **Lad være at sætte** `SHIPMONDO_RETUR_ER_IKKE_AFHENTET`, før du har set en rigtig pakke, der ikke blev hentet (så registreres "ikke afhentet" automatisk ud fra Shipmondos tekst – ellers trykker staff selv).
- **Spørg Shipmondo:** (1) GLS ShopReturn og PostNord Return er "erhvervsadresse"-produkter – må ShopReturn bruges til private sælgere (vi bruger ellers GLS ShopDelivery til en pakkeshop med printet label)? (2) Svarer de `cancelled_at_carrier: true` i produktion for GLS/PostNord, og refunderes en annulleret label? (3) Kan GLS sendes labelfrit (QR) via Shipmondo? I dag kun med printet label. (4) Kan DAO-labels annulleres? (5) Sender Shipment Monitor den målte vægt?

## DAO direkte – når du har nøglerne (se docs/DAO-API.md, "Mangler")
- **Kør migrationen** `supabase/migrations/20261021010000_fragt_dao_direkte.sql` i produktion (dit "ja"). Den er kørt to gange på testdatabasen. Den kan køres, før DAO slås til – den ændrer intet for Shipmondo/testfragt.
- **Sæt i `.env.local` (testdatabasen) først**, og først bagefter i Vercel (Production): `DAO_KUNDEID` og `DAO_KODE` (fra DAO). De står i URL'en til DAO, så del dem aldrig i chat, mails eller skærmbilleder. Valgfrit: `DAO_API_URL` (standard `https://api.dao.as`), `DAO_LABEL_PAPIR` (standard `A4Foldable`).
- **Lokalt først med `DAO_TESTMODE=true`** (DAO opretter ingen pakker) og `FRAGTFIRMA=dao`. Uden `FRAGTFIRMA` bruges testfragtfirmaet lokalt som hidtil.
- **Få koderne:** bed Claude kalde `TrackNTraceKoder.php` og `FejlKoder.php` (kun læsning) og udfylde `src/lib/fragt/daoKoder.ts`. Send derefter 2-3 rigtige pakker – og én, der ikke hentes – så "leveret" og "retur" kan ses på rigtige pakker. Indtil "leveret" er kendt, får køberen ikke "Pakken er kommet frem", og 14-dages-frigivelsen sker ikke (pengene holdes, og staff får en opgave).
- **Produktion:** `FRAGTFIRMA=dao` i Vercel, når ovenstående er gjort. `DAO_TESTMODE` må ikke sættes i produktion.
- **Efterlysning efter 14 dage:** `FRAGT_EFTERLYSNING_AKTIV=true` slår den automatiske efterlysning hos DAO til (`createclaim.php`). Uden den får staff opgaven at efterlyse manuelt. Slå den først til, når Allan har bekræftet, hvad `pris` betyder.
- **Returlabel i sager** (`FRAGT_RETURLABEL_AKTIV`) forbliver slået fra, indtil kortbetalingen af returfragten (din beslutning 13. okt. 2026) er bygget.

## Ekstern vagt på admin-forsiden (Healthchecks.io)
- **Sæt `HEALTHCHECKS_LAESENOEGLE`** i Vercel (Production) og i `.env.local`: den **read-only** API-nøgle fra Healthchecks.io (Project Settings → API Access). Brug aldrig den fulde nøgle.
- Checks skal hedde præcis **"Betalings-cron"** og **"Daglig afstemning"** hos Healthchecks. Så viser Admin → Forside to lamper ("Ekstern vagt – …"): grøn = ok, gul = forsinket, rød = nede (også i Kræver handling og statuslinjen), grå = ny/pause/ikke sat op.
- Mangler nøglen, står lamperne grå med "Ikke sat op" – aldrig grøn.

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
- **Bør sættes i produktion (Filip – Vercel):** den daglige pengeafstemning har sin egen rute (`/api/cron/afstemning`, eget pg_cron-job oprettet af migrationen `20261019020000`). Lav en ekstra check i healthchecks.io (**Period 1 day**, **Grace 3 hours**) og sæt `CRON_AFSTEMNING_HEALTHCHECK_URL` i Vercel. Den pinges, når en afstemning er kørt helt igennem uden fejl, og `/fail`, når et trin fejlede.

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
