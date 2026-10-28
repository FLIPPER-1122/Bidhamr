# Huskeliste til Filip

## Lancering – slå den rigtige forside til
I dag viser bidhamr.dk coming soon direkte på forsiden `/` for alle uden adgang (staff, beta-testere og firmakonti ser siden som før). Besøgende kan kun se coming soon, `/erhverv` (+ formularen) og `/privatliv`, `/betingelser` og `/dsa` – i en minimal udgave uden menu og uden cookie-banner. Google må allerede nu indeksere netop de sider (kun i Vercels *Production* mod produktionsdatabasen – ingen variabel at sætte; se `src/lib/seo.ts`). Den rigtige forside og resten af siden åbnes med **én kontakt**:
- **Vercel → Project → Settings → Environment Variables → `LANCERET` = `1`** (kun miljøet *Production*), og **deploy igen** (Deployments → Redeploy). Variablen virker først efter en ny deploy.
- Hvad sker der: besøgende uden login ser forsiden, søgning, auktioner, offentlige profiler og tekstsiderne. Alt andet (Min konto, Mine handler, Opret auktion, beskeder ...) sender til login. Indloggede brugere kommer ind overalt, firmakonti får hele siden, og `/coming-soon` sender videre til forsiden. Admin er stadig kun for staff.
- Fail closed: alt andet end præcis `1` (eller `true`) holder siden lukket. Fortryder du, så slet variablen og deploy igen.
- Samme dag (separate kontakter): `TILMELDING_AABEN=true` (åbner oprettelse af konti) og `SEO_INDEKSERING=true` (lader Google indeksere siden).
- **"Allow new users to sign up" skal ALTID være slået fra i Supabase** (Authentication → Sign In / Providers), også efter lancering. Tjek det i **Hamr** (produktion) og **Bidhamr Test**. Alle konti oprettes på serveren (hjemmesiden og appens `POST /api/konto/opret`, se docs/APP-SIGNUP.md) med en tilfældig adgangskode, og den valgte adgangskode sættes først, når koden fra mailen er indtastet. Hvorfor: med direkte `signUp` kunne en fremmed oprette kontoen først med en andens e-mail og sin egen adgangskode og overtage kontoen, når den rigtige ejer bekræftede.
- **Kør migrationen `supabase/migrations/20261018010000_signup_billet_altid.sql` før lanceringen** (testdatabasen først, så produktion med dit ja). Så afviser databasen enhver ny konto, som serveren ikke har lagt en billet til (bundet til serverens eget kald med et engangs-nonce) – også hvis "Allow new users to sign up" ved en fejl bliver slået til. Kør den først, når den nye signup-kode er deployet (ellers afvises nye konti fra den gamle kode). Efter migrationen kan appens gamle `signUp` ikke oprette konti – appen skal bruge `POST /api/konto/opret` (ROADMAP fase 5).
- **Samme dag som `TILMELDING_AABEN=true`: slå invitationsværnet i databasen fra.** Ellers får kun inviterede en konto, og `/admin/drift` viser "Databasen gav ingen billet til en ny konto" (eller "Supabase afviste en ny konto"). Det er en migration (dit ja) med én linje: `update public.beta_indstillinger set kun_inviterede = false;`. Billet-værnet bliver ved med at gælde. Luk også beta-testen under Admin → Beta-invitationer, hvis den stadig er åben (se "Beta-test" herunder).
- **Opret bruger / Invite user i Supabase-dashboardet virker aldrig** efter migrationen (der er ingen billet). Testbrugere oprettes via `supabase/seed.sql`, firmakonti under Admin → Erhverv.
- **Henvis en ven (`20261102230000_henvis_en_ven.sql`):** der gives ingen point, før siden er lanceret. Databasen starter optjeningen af sig selv, når serveren kører med `LANCERET=1` (cron'en hvert 5. min. og lige før en MitID-verificering kalder `henvisning_start_optjening()` én gang). Intet at gøre, men tjek efter lanceringen i SQL: `select optjening_fra_kl from henvisning_indstillinger;` (skal have et tidspunkt).
- Lokalt (`npm run dev`, testdatabasen) er siden altid "lanceret", så forsiden kan ses på http://localhost:3000. `SIMULER_FOER_LANCERING=true` i `.env.local` viser den lukkede udgave med coming-soon. `LANCERET` har ingen virkning på testdatabasen. `SIMULER_TILMELDING_LUKKET=true` lukker tilmeldingen lokalt, så beta-tilmeldingen kan testes.

## Links åbner appen (universal links og App Links, 27. okt. 2026)
- **Android:** kør `eas credentials` i `bidhamr-app` → Android → production → kopiér "SHA256 Fingerprint" (fx `AB:CD:…`). Bruger appen Google Play App Signing, så tag også aftrykket fra Play Console → Test og udgiv → App-integritet → "App signing key certificate". Sæt dem kommasepareret i **Vercel → Settings → Environment Variables → `ANDROID_SHA256_FINGERPRINTS`** (Production, og evt. i projektet "bidhamr-test"). Ingen redeploy nødvendig – filen læses ved hver forespørgsel. Tjek bagefter https://bidhamr.dk/.well-known/assetlinks.json.
- **iOS:** intet at sætte. Tjek https://bidhamr.dk/.well-known/apple-app-site-association. "Associated Domains" skal være slået til for `dk.bidhamr.app` (EAS gør det normalt selv ved næste build).
- **Det kræver et nyt native build af appen** (`eas build`), ikke kun en OTA-opdatering.

## Sikkerhed før lancering (sikkerhedsgennemgang 27. okt. 2026)
- **CAPTCHA og adgangskoder i Supabase:** slå "Prevent use of leaked passwords", CAPTCHA (Cloudflare Turnstile) og lavere rate limits til – se `docs/SIKKERHED-AUTH.md`. **Ikke før appen sender `captchaToken`** (ellers kan appen hverken oprette konti eller logge ind), og Cloudflare skal stå i privatlivspolitikken (advokat nr. 138-139).
- **Staff kan spærres ude af admin-login:** loftet `admin_login_email` (10 pr. 15 min. pr. e-mail, alle IP'er) kan rammes med vilje af nogen, der kender en staff-e-mail. Skal løses før lancering (fx kun tælle mislykkede forsøg på staff-konti + "kendt enhed"-cookie efter to-trins-login), når gaten på /adgang fjernes.
- **Edge-funktionen `notificer-foelgere`** skal deployes til prod igen (dit ja), lige efter migration 20261102060000 er kørt: `supabase functions deploy notificer-foelgere --project-ref lkifkrexeldimmghnsie --use-api`.

## Betalingsformularen vises ikke på bidhamr.dk (19. okt. 2026) – tjek Stripe-nøglen i Vercel
Lokalt prod-build med prods CSP virker, så fejlen ligger med stor sandsynlighed i Vercel-buildet: `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` bygges ind ved `next build`, og mangler den i buildet, forbliver "Betal"-knappen grå.
- **Vercel → Project → Settings → Environment Variables:** `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` skal have flueben ved **Production** (ikke kun Preview/Development). Navnet skal stå præcis sådan, og værdien skal starte med `pk_test_` (samme konto som `STRIPE_SECRET_KEY`). Ingen anførselstegn og intet mellemrum.
- **Deployments → den deployment, bidhamr.dk peger på → ⋯ → Redeploy**, og fjern fluebenet ved "Use existing Build Cache". Tjek, at den nye deployment bliver **Production/Current**. Har du brugt "Instant Rollback", bliver nye deployments ikke sat i drift af sig selv. Så skal du trykke "Promote".
- Efter deploy af den nye kode: mangler nøglen stadig, viser **/admin** en rød lampe ("Den offentlige Stripe-nøgle mangler i buildet") og **/admin/drift** en fejl. Siden viser "Betalingsformularen kunne ikke indlæses …" i stedet for en grå knap, og der laves ingen betaling.
- Rammer det også checkout? Ja, samme loader. Test et køb i checkout, når boost virker.

## Betalingsmetoder: kort, MobilePay og Revolut Pay – ingen Klarna og Link (20. okt. 2026)
- **Giv eksisterende sælgerkonti Revolut Pay i produktion (dit "ja").** Kør først en prøvekørsel, der ikke ændrer noget, og derefter den rigtige kørsel:
  ```
  node scripts/betalingsmodel-backfill.mts --env .env.production.local --produktion
  node scripts/betalingsmodel-backfill.mts --env .env.production.local --produktion --udfoer
  ```
  Scriptet anmoder om `revolut_pay_payments` på de konti, der mangler den, og rører ikke andet, der allerede er sat op. Det er kørt på testdatabasen 20. okt. 2026: 5 konti fik capability'en, og de aktive konti var stadig aktive bagefter. Uden kørslen ser købere hos de sælgere bare ikke Revolut Pay i checkout (kort, Apple Pay, Google Pay og MobilePay virker som før).
- Før live (fase 6): slå MobilePay og Revolut Pay til i Stripe-dashboardet for platformen og under Connect → Payment methods (docs/GO-LIVE-STRIPE.md E1). Er de ikke slået til, viser boost og returfragt kun kort, Apple Pay og Google Pay.

## Fakturaer i produktion – Dineros testregnskab "BidHamr Test", indtil revisoren har godkendt live (20. okt. 2026)
I dag laver bidhamr.dk ingen fakturaer: Dinero er ikke sat op i Vercel. Én boost-faktura (99 kr., 20. okt.) venter. **Produktionen skal også bruge testregnskabet "BidHamr Test" (sandkassen) – aldrig "Bidhamr ApS" – indtil revisoren har godkendt Dinero-live.** Det passer med, at produktionen stadig kører med Stripes testnøgle (fase 6): betalingerne er ikke rigtige, så fakturaerne skal heller ikke være det.
- **Først skal den nye kode være deployet** (commit "Fakturaer: kun BidHamr Test ..."). Den gamle kode nægter at bruge testregnskabet i produktionen.
- **Vercel → Project → Settings → Environment Variables, kun miljøet *Production*:**
  - `DINERO_CLIENT_ID` og `DINERO_CLIENT_SECRET`: samme værdier som i `.env.local` (din personlige integration i Dinero).
  - `DINERO_API_KEY`: API-nøglen til **BidHamr Test** (samme som i `.env.local`).
  - `DINERO_ORG_ID` = `659420` (organisations-id for **BidHamr Test**).
  - `DINERO_MILJOE` = `test` (præcis sådan – en tom værdi giver ingen fakturaer i produktionen).
  - `DINERO_LIVE_ORG_ID`: **lad den være tom** – eller sæt den til **Bidhamr ApS'** organisations-id, hvis du har det ved hånden. Så nægter koden ekstra tydeligt at sende til det rigtige regnskab, så længe `DINERO_MILJOE=test`. Den må aldrig være `659420`.
  - `DINERO_KONTO_SALG`, `DINERO_KONTO_FRAGT`, `DINERO_KONTO_INDBETALING`: **lad dem være tomme** (så bruges 1000 / 1350 / 55000, som testregnskabet har). Boost-point bogføres på salgskontoen 1000 med moms ligesom gebyrerne.
- **Deployments → Redeploy** (variablerne virker først efter en ny deploy).
- **Så sendes den ventende boost-faktura af sig selv** ved næste kørsel af betalings-cron'en (hvert 5. minut): den får et fakturanummer i "BidHamr Test", dateres betalingsdagen og står som betalt. Tjek **Admin → Fakturaer** (står der "Dinero: sat op (testregnskab ...)", og har boost-fakturaen et nummer?) og lampen **Fakturaer** på admin-forsiden (grøn).
- **Værnet:** før hver kørsel spørger koden Dinero, hvad regnskabet hedder. I test sender den kun, hvis det hedder "BidHamr Test" (eller "BidHamr Test ..." med et tillæg) og ikke har BidHamrs CVR 46836219. Ellers sendes intet, lampen bliver rød, og der kommer en drift-alarm.
- **Samme testregnskab som testdatabasen?** Det virker teknisk: dokumenterne og kontakterne har hver deres id'er, så intet kolliderer. Men fakturanumrene deles, så produktionens fakturaer kommer til at ligge mellem ca. 1.300 testfakturaer fra testdatabasen (og numrene får huller set fra produktionen), og det er svært at se, hvad der er hvad. **Anbefaling:** opret et ekstra testregnskab i Dinero til produktionen med navnet **"BidHamr Test Produktion"** (navnet skal starte med "BidHamr Test", og der må ikke stå CVR 46836219), lav en API-nøgle til det, og brug dets id og nøgle i Vercel i stedet for `659420`. Så er produktionens fakturaer samlet ét sted. Begge dele er tilladt af værnet.
- **Når revisoren har godkendt Dinero-live:** se docs/FAKTURA.md afsnit 4 (`DINERO_MILJOE=live`, `DINERO_LIVE_ORG_ID` og det rigtige regnskabs nøgler). Dinero og Stripe skal skifte samme dag (fase 6): med Stripes live-nøgle nægter koden at bruge testregnskabet, og `DINERO_MILJOE=live` virker kun med Stripes live-nøgle (så testbetalinger aldrig havner i det rigtige regnskab). Passer de ikke sammen, laves ingen fakturaer, lampen bliver rød, og der kommer en drift-alarm.

## Boost-pakker (`20261026010000_boost_pakker.sql`)
- **Kør migrationen i produktion (dit "ja").** Den er kørt to gange på testdatabasen. Den forudsætter `20261025010000_app_endpoints.sql` (min_auktion_boost med "kunst_kontrol" – md5'en i prod er allerede den udgave). Rækkefølgen af migration og deploy er ligegyldig: den gamle kode og appen køber 100-point-pakken som før, og den nye kode viser kun én pakke, indtil migrationen er kørt.
- Test på hjemmesiden: Min konto → Boost-point → vælg 300 eller 700 point → "Køb … " → betal med 4242 4242 4242 4242.

## Admin på admin.bidhamr.dk med to-trins-login (`20261027010000_staff_to_trin.sql`, docs/ADMIN-VAERT.md)
Gør det i denne rækkefølge:
1. **Kør migrationen i produktion (dit "ja")** lige før trin 3 – staff får 7 dage til at sætte to-trins-login op, regnet fra kørslen. Den er kørt to gange på testdatabasen og rører intet, den gamle kode bruger. **Rækkefølge: `20261026010000_boost_pakker.sql` (26) før `20261027010000_staff_to_trin.sql` (27).** Tjek bagefter: `select md5(pg_get_constraintdef(oid)) from pg_constraint where conname = 'moderation_log_handling_check'` skal give `ee2d44c457c60644a8762febd38d0bdb` (før: `20470dc11b09bc4558a37a28a33a5ec8`).
2. **Slå TOTP til i Supabase:** Authentication → Multi-Factor → "TOTP (App Authenticator)" (enroll og verify). Testdatabasen ("Bidhamr Test") har det allerede. Gør det i **Hamr** (produktion).
3. **Vercel (Production):** tilføj domænet `admin.bidhamr.dk` til projektet (Settings → Domains + DNS-posten hos domæneudbyderen), og sæt `ADMIN_VAERT=admin.bidhamr.dk` og `NEXT_PUBLIC_ADMIN_URL=https://admin.bidhamr.dk`. **Redeploy.** Fra nu af virker admin kun på admin.bidhamr.dk.
4. **Sæt selv to-trins-login op først** på https://admin.bidhamr.dk (log ind → "Start" → scan QR-koden → skriv koden). **Gem de 10 gendannelseskoder** et sikkert sted (fx 1Password) – de vises kun én gang.
5. **Al staff sætter to-trins-login op inden for 7 dage** (først en kode på mail, så app'en). Har nogen ikke nået det, så tryk "Åbn tilmelding (24 t)" ud for personen under Admin → Medarbejdere (kræver en kode fra din app). Mister en medarbejder sin telefon: "Nulstil to-trins-login" samme sted.
6. **`ADMIN_LUK_HOVEDDOMAENE=omdiriger`** i Vercel i 2 uger (gamle bogmærker til bidhamr.dk/admin sendes videre), **derefter `=1`** (bidhamr.dk/admin giver 404). Redeploy efter hvert skift.
7. **Vercel Firewall** (Project → Firewall → Configure → New Rule):
   - "Kun DK/EU til admin": If **Host** equals `admin.bidhamr.dk` AND **Country** is not any of (Danmark + de EU-lande, I har brug for) → **Deny**.
   - "Grænse på admin-login": If **Host** equals `admin.bidhamr.dk` AND **Request Path** starts with `/adgang` → **Rate Limit** (fx 30 forespørgsler pr. minut pr. IP) → Deny (429).
   - Publish. Test bagefter fra en mobil uden wifi (DK) og via en VPN uden for EU (skal afvises).
8. **Migration B: `20261027020000_staff_rls_aal2.sql` (dit "ja") – FØRST når al staff har to-trins-login aktivt.** Så kræver staff-adgang i databasen (andres handler, beskeder, betalinger, forsendelser, skjulte auktioner, sags-, pakke- og label-filer) også to-trins-login. Uden den kan en medarbejder med kun adgangskoden læse alt det direkte via Supabase.
   - Rækkefølge: efter `20261026010000` og `20261027010000`, og efter trin 3 (`ADMIN_VAERT` sat og deployet).
   - Tjek først under Admin → Medarbejdere, at **alle** har to-trins-login aktivt. En medarbejder uden mister med det samme staff-adgangen i databasen (admin-siderne virker stadig for ham, men han kommer ikke ind uden to-trins-login).
   - Kør den i SQL Editor på **Hamr** som én forespørgsel. Den afbryder af sig selv (og ændrer intet), hvis en funktion eller policy ikke ser ud som forventet.
   - Test bagefter: log ind på admin.bidhamr.dk og åbn Handler, Sager, Betalingsfejl, Beskeder og en skjult auktion. Åbn så en skjult auktion på bidhamr.dk (logget ind som staff): du sendes til admin.
   - Appen og bidhamr.dk påvirkes ikke for brugerne. Staff ser kun egne handler/beskeder i appen og på bidhamr.dk, og skjulte auktioner og spørgsmål kun i admin.
   - `STAFF_TO_TRIN_MAKS_TIMER` kan højst være 12 (databasen kræver en kode, der højst er 12 timer gammel). En højere værdi bruges som 12, og /admin/drift viser en fejl ved start.
   - **Fortryd migration B:** kør `prod-koersel/rollback-20261027020000.sql` (samme indhold som `supabase/rollback/20261027020000_staff_rls_aal2.sql`) i SQL Editor på Hamr. Den gendanner præcis de gamle funktioner og policies. Se docs/ADMIN-VAERT.md, "Migration B".
- **Vær opmærksom på:** hver gang en medarbejder skriver koden i admin, logger Supabase ham ud af appen og bidhamr.dk (han skal logge ind dér igen). Det er Supabases egen regel og kan ikke slås fra. Staff med to-trins-login skifter adgangskode via "Glemt adgangskode". Se docs/ADMIN-VAERT.md, "Kendte konsekvenser".
- **Separate admin-konti (besluttet 20. okt. 2026):** hver medarbejder får sin egen konto med sin egen e-mail kun til admin (staff-rollen + to-trins-login) og bruger sin private konto i appen. Sådan: (1) opret admin-kontoen som en almindelig konto med den nye e-mail, (2) chefen giver den staff-rollen under Admin → Medarbejdere/brugere, (3) fjern staff-rollen fra den private konto. Ingen kode skal ændres. **E-mailen skal kunne modtage mail** (opret-kode og koden før to-trins-opsætning) – bidhamr.dk kan i dag ikke modtage mail (null MX), så indtil der er arbejdsmail, brug fx Gmails plus-adresse (`navn+admin@gmail.com`).
- **Indtil migration B (trin 8) er kørt, beskytter to-trins-login kun admin-siderne – ikke staff-adgang via API'et.**
- **Låst ude?** Se docs/ADMIN-VAERT.md, "Nødudgang".
- Fortryd: slet `ADMIN_VAERT` og `ADMIN_LUK_HOVEDDOMAENE` i Vercel og redeploy – så er admin på bidhamr.dk/admin igen uden to-trins-login.

## Fragt via Shipmondo – DAO og GLS, ingen PostNord (se docs/FRAGT.md, "Shipmondo")
- **Køberne kan kun vælge DAO og GLS** (din beslutning 20. okt. 2026). GLS sendes med printet PDF-label – køberen og sælgeren får det at vide. **PostNord er slået fra.** Slå PostNord til igen med `SHIPMONDO_POSTNORD_AKTIV=true` (Vercel, Production, og deploy igen). Listen kan også styres med `SHIPMONDO_TRANSPORTOERER` (standard `dao,gls` – sæt den ikke, medmindre du vil ændre den). Pakker, der allerede er sendt med PostNord, virker videre.
- **Vercel: fjern `SHIPMONDO_GLS_AKTIV`**, hvis den er sat – den er erstattet (GLS er med i standarden). Den gør ingen skade, men forvirrer.
- **Kør migrationen** `supabase/migrations/20261028010000_fragt_dao_gls_ingen_postnord.sql` i produktion (dit "ja") efter `20261024020000`. Den lader databasen afvise PostNord (og alt andet uden for serverens liste) og laver tabellen `fragt_betingelser_accept` (sælgerens accept af DAO's handelsbetingelser). **Kør den umiddelbart før deploy af den nye hjemmeside:** uden tabellen kan den nye kode ikke lave DAO-labels (fail closed – sælgeren får "Noget gik galt"). **Kort vindue** mellem migration og deploy (gammel kode + ny database): vælger en køber PostNord, afviser databasen det, og den gamle kode viser kun den generelle fejltekst ("Noget gik galt …") i stedet for "PostNord kan ikke vælges lige nu …". DAO og GLS virker i vinduet. Den er kørt to gange på testdatabasen.
- **Betalte PostNord-handler:** en køber, der har betalt med PostNord, kan stadig skifte pakkeshop, men kun til DAO eller GLS (PostNord kan ikke vælges). Skifter han til GLS, skal sælgeren pludselig printe en label. Labels, der allerede er lavet med PostNord, virker videre.
- **Kør migrationen** `supabase/migrations/20261024020000_fragt_gls_slaaet_fra.sql` i produktion (dit "ja") lige efter `20261024010000` herunder (forudsætning for `20261028010000`). Den er kørt to gange på testdatabasen.
- **Kør migrationen** `supabase/migrations/20261024010000_fragt_shipmondo_transportoer.sql` i produktion (dit "ja") **FØR** `FRAGTFIRMA=shipmondo` sættes i Vercel – den er kørt to gange på testdatabasen. Uden migrationen nægter koden Shipmondo-labels og regner fragt som "ikke sat op" (ellers kunne Shipmondos "leveret" frigive penge efter 14 dage). Den gamle kode virker efter migrationen (fragtfirmaet bliver DAO), så migrationen må gerne køres først.
- **Vercel (Production):** `FRAGTFIRMA=shipmondo`, `SHIPMONDO_API_URL=https://app.shipmondo.com/api/public/v3`, `SHIPMONDO_API_BRUGER` og `SHIPMONDO_API_NOEGLE` (fra Shipmondo → Indstillinger → API, produktionskontoen – ikke sandboxen), `SHIPMONDO_WEBHOOK_NOEGLE` (en lang, tilfældig værdi, fx `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Valgfrit: `SHIPMONDO_EGEN_AFTALE=true`, hvis du booker på jeres egne aftaler hos DAO/GLS/PostNord i Shipmondo.
- **Opret de to webhooks** i Shipmondo (Indstillinger → Webhooks), "Shipment Monitor" med action **latest** og **delivered**, endpoint `https://bidhamr.dk/api/fragt/webhook/shipmondo` og nøglen = `SHIPMONDO_WEBHOOK_NOEGLE` (se docs/FRAGT.md, "Opret webhooken").
- **Labels slås til** med `FRAGT_LABELS_AKTIV=true` og returkoder i sager med `FRAGT_RETURLABEL_AKTIV=true`, når du har testet.
- **Lad være at sætte** `SHIPMONDO_LEVERET_FRIGIVER=true`, før du har set rigtige webhooks i produktion (at "leveret" kommer, og at by/postnummer passer). Indtil da frigiver Shipmondos "leveret" ikke pengene efter 14 dage – staff får opgaven som i dag. Flaget gælder kun labels, der laves, efter det er sat.
- **Lad være at sætte** `SHIPMONDO_RETUR_ER_IKKE_AFHENTET`, før du har set en rigtig pakke, der ikke blev hentet (så registreres "ikke afhentet" automatisk ud fra Shipmondos tekst – ellers trykker staff selv).
- **Spørg Shipmondo:** (1) GLS ShopReturn og PostNord Return er "erhvervsadresse"-produkter – må ShopReturn bruges til private sælgere (vi bruger ellers GLS ShopDelivery til en pakkeshop med printet label)? (2) Svarer de `cancelled_at_carrier: true` i produktion for GLS/PostNord, og refunderes en annulleret label? (3) Kan GLS sendes labelfrit (QR) via Shipmondo? I dag kun med printet label (GLS er slået til med printet label - din beslutning 20. okt. 2026). (4) Kan DAO-labels annulleres? (5) Sender Shipment Monitor den målte vægt? (6) Sender Shipment Monitor by og postnummer for leveringsstedet (vi tjekker dem, før en pakke tælles som leveret)? (7) Filtrerer `GET /shipments?reference=` på præcis reference (vi tjekker det selv i de første 50 svar)?

## Kunst er forbudt + brugerbetingelser 0.2 (`20261023010000_kunst_forbudt.sql`)
Rækkefølgen af migration og hjemmeside-deploy er ligegyldig (koden tåler, at migrationen mangler). Men:
1. **FØR migrationen:** deploy edge-funktionen til produktion (den tåler, at kolonnen mangler, og skal kende kunst-kontrollen, når migrationen er kørt):
   `npx supabase functions deploy notificer-foelgere --project-ref lkifkrexeldimmghnsie`
2. **Kør migrationen** i produktion (dit "ja"). Den er kørt to gange på testdatabasen. Brugerbetingelserne forbliver på 0.1 – intet ændres for brugerne endnu.
3. **Når den nye hjemmeside er deployet:** Admin → Drift → **"Slå brugerbetingelser 0.2 til"** (admin/chef). Først nu får alle accept-vinduet, og bud/maksimum/nye auktioner afvises, indtil de har accepteret. Gør det ikke, mens den gamle hjemmeside kører.
4. Valgfrit: Admin → Auktioner → **"Tjek aktive auktioner for kunst"** (viser først, hvor mange der rammes; auktioner med bud får kun en anmeldelse).

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

## BidHamr-bot – småting fra review (27. okt. 2026), før lancering
- Ændringer af bottens lofter på /admin/bot skal logges i `moderation_log` med gamle og nye værdier.
- Afvis en ny besked, mens et svar er i gang i samme samtale (kode `svar_i_gang`), så skønnet for svar i gang bliver rigtigt.
- Hæv `BOT_SKOEN_INPUT_PR_RUNDE` til ca. 60.000, og vis en advarsel på /admin/bot, når prisen for ét svar overstiger loftet pr. bruger (fx ved Opus).
- Efter lancering: overvej en samlet andel af budgettet for konti uden MitID-verificering.

## Rækkefølge ved udrulning af prod-pakken (review 28. okt. 2026)
- **Kode først, migrationer lige efter.** Push `main`, vent til Vercel-deployet er færdigt, og kør så migrationerne.
- Ellers rammes brugerne mens den gamle kode kører:
  - Kører `20261102340000_bruger_adresse.sql` før den nye kode, kan alle eksisterende private brugere ikke byde (BHY01 uden formular).
  - Det samme gælder sagsreglerne (`20261102210000`).
- Undtagelse: `20261102310000_bot_loft_pr_gruppe.sql` skal køres **før** den nye bot-kode, ellers svarer botten ikke. Den gamle kode tåler migrationen. Kør den sammen med de andre lige efter deployet; botten er alligevel skjult, indtil `ANTHROPIC_API_KEY` er sat i produktion.

## Sagsregler – småting fra review (28. okt. 2026)
- `sag_indpakning_ved_afgoerelse`: giv `billeder_mangler`, når staff vælger "sælgeren betaler returfragt", og sagen ikke har et pakke-/labelbillede. Ellers kan sælgeren få en regning uden bevis.
- Genåbning efter retur: markér hos staff, at BidHamr kan stå med returfragten, når sælgerens regning er frafaldet.
