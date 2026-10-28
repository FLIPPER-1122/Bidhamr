# Køb af boost-point i appen (Apple In-App Purchase og Google Play Billing)

Beslutning: ROADMAP-BESLUTNINGER.md, "Køb af boost-point i appen (Filip, 27. okt. 2026)". Apple (App Store-reglerne
3.1.1 og 3.1.3(g)) og Google Play kræver deres egen betaling for digitale varer. I appen købes boost-point derfor kun
via Apple og Google. På bidhamr.dk købes de fortsat via Stripe (uændret).

- Migrationer: `supabase/migrations/20261102320000_boost_iap.sql`, `20261102370000_boost_iap_rettelser.sql`
  (rettelser efter review: markering af testkøb/promo, ventende refusioner, lås mellem kreditering og refusion,
  "Download dine data") og `20261102400000_boost_iap_rettelser2.sql` (en ophævet refusion genåbnes ikke af den
  samme `REFUND` igen, testkøb tilbagekaldes med låse i fast rækkefølge)
- Kode: `src/lib/iap/` (konfig, regler, apple, google, server)
- Ruter: `GET/POST /api/app/boost/iap`, `POST /api/webhooks/apple`, `POST /api/webhooks/google-play`
- Appens kontrakt: docs/APP-ENDPOINTS.md, "Køb af boost-point i appen"
- Tests: `tests/enhed/iap.test.ts` (falske Apple- og Google-svar) og `tests/penge-db/boostIap.test.ts` (migrationen)

## Sådan flyder pengene og pointene

1. Køberen trykker "Køb" i appen. Apple eller Google viser deres eget betalingsvindue og trækker beløbet. **Apple og
   Google er sælger over for køberen.** De opkræver moms og udsteder kvitteringen. BidHamr rører ikke pengene.
2. Appen sender beviset til `POST /api/app/boost/iap`:
   - iOS: den signerede transaktion fra StoreKit 2.
   - Android: produkt-id og purchaseToken.
3. Serveren stoler ikke på appen. Den slår købet op:
   - **Apple:** JWS'en verificeres med Apples officielle bibliotek: certifikatkæden til Apple Root CA - G3 (indlejret
     og tjekket med SHA-256-fingeraftrykket), Apples OID'er, signaturen, OCSP, bundle-id og miljø. Derefter hentes
     købet igen med App Store Server API (**Get Transaction Info**). Apples svar er sandheden: forbrugsprodukt, ét stk.,
     ikke refunderet og købt af den rigtige konto (`appAccountToken`).
   - **Google:** `purchases.products.get` med service account: betalt (`purchaseState` 0), ikke et testkøb på
     produktion, ét stk. og den rigtige konto (`obfuscatedExternalAccountId`). `purchaseType` 1 (promokode, ikke
     betalt) krediteres med markeringen `promo` og tælles ikke som omsætning. `purchaseType` 2 (belønnet) afvises.
   - **Kontobindingen er påkrævet i produktion.** `appAccountToken` (Apple) og `obfuscatedAccountId` (Google) er et
     UUID, som serveren regner ud: HMAC-SHA256 af bruger-id'et med `IAP_KONTO_HEMMELIGHED` (formateret som UUID
     version 8). **`IAP_KONTO_HEMMELIGHED` må aldrig roteres** (se Miljøvariabler). Appen får værdien fra
     `GET /api/app/boost/iap`. Bruger-id'et sendes ikke til Apple/Google. Mangler
     værdien i købet, afvises det med `409 konto_mangler` (på testdatabasen må den mangle). Står der en anden værdi:
     `409 anden_konto`.
   - Kontoen (firma/spærret) tjekkes **efter** verificeringen. Er købet ægte, men kontoen kan ikke få point (`erhverv`,
     `spaerret` eller `konto_mangler`), får chefen en drift-note (`boost/iap-afvist-betalt`), for brugeren har betalt.
     Google-køb forbruges ikke og refunderes derfor automatisk af Google efter 3 dage. Apple refunderer ikke af sig
     selv: brugeren skal søge refusion på reportaproblem.apple.com, eller chefen giver pointene.
4. Databasen krediterer pointene **én gang** (`boost_iap_krediter`). Antallet af point kommer fra
   `boost_iap_produkter`. Købet gemmes i `boost_iap_koeb` med unikt indeks på platform + transaktion/ordre og på
   Googles token. Samme køb kan derfor aldrig give point to gange eller gå til en anden bruger. Posteringerne hedder
   `koeb_apple` / `koeb_google`.
5. Google: serveren kalder `consume`, så pakken kan købes igen. Fejler det, prøver den daglige cron igen. Uden
   consume inden 3 dage refunderer Google selv købet, og så trækkes pointene tilbage.
6. Apple og Google udbetaler beløbet til BidHamr efter deres gebyr: 15 % hos Apple med Small Business Program og
   15 % hos Google.

**Refusion:** Apple (`REFUND`-notifikation) eller Google (`voidedPurchaseNotification` via Pub/Sub) trækker pointene
tilbage med `refusion_apple` / `refusion_google`. Sikkerhedsnet i den daglige cron:
- **Apple:** App Store Server API **Get Notification History** (`getNotificationHistory` i Apples officielle
  bibliotek) for `REFUND` og `REFUND_REVERSED` det seneste døgn plus 12 timers overlapning (36 timer), i hvert tilladt
  miljø. Hver notifikation verificeres og behandles præcis som webhooken - samme idempotens (`notificationUUID`), så
  en notifikation, webhooken allerede har behandlet, gør intet. Delvise refusioner (`REFUND_PRORATED`) virker også.
- **Google:** Voided Purchases API (de seneste 3 døgn).
- En Google-RTDN bekræftes hos Google, før pointene trækkes. Googles dokumentation for `purchases.products.get` nævner
  kun `purchaseState` 0 (købt), 1 (annulleret) og 2 (afventer) og siger ikke, hvilken værdi et refunderet køb har.
  Derfor godtages alt andet end 0 og 2 som annulleret. Siger Google 0 eller 2, mangler værdien, eller kendes tokenet
  ikke længere (404/410), slår serveren op i Voided Purchases API (30 dage): står købet dér, er refusionen bekræftet.
  Ellers trækkes intet (den daglige cron tager det, hvis det er rigtigt). Kan Google ikke nås, svarer serveren 500,
  og Pub/Sub prøver igen.
  **Skal testes med en rigtig refusion** (Play Console → Order management → Refund på et licenstester-køb): se i
  loggen, at RTDN'en giver `tilbagefoert` og ikke `ikke_bekraeftet`, og at pointene trækkes.

**Refusion før kreditering:** kommer en refusion for et køb, vi endnu ikke har krediteret (fx før appen nåede at
sende købet, eller et firmakøb), gemmes den i `boost_iap_ventende_refusioner`, og notifikationen markeres som
behandlet. Sender appen købet bagefter, afviser `boost_iap_krediter` det (`409 refunderet`). Apple `REFUND_REVERSED`
ophæver den ventende refusion, og chefen får en drift-note (`boost/iap-refusion-tilbage`): "Apple har trukket en
refusion tilbage – brugeren kan mangle point, giv dem manuelt, hvis købet ikke sendes igen". Rækken husker Apples
`notificationUUID` og `signedDate` for refusionen og ophævelsen: en ophævet række genåbnes kun af en refusion, der er
signeret efter ophævelsen, og en `REFUND_REVERSED` ophæver kun en refusion, der er ældre. Så kan den daglige
historik-kørsel ikke blokere købet igen ved at køre den samme `REFUND` en gang til. Kommer `REFUND_REVERSED` før
`REFUND`, gemmes en allerede ophævet række, så den ældre `REFUND` ikke blokerer købet. Kreditering og refusion af samme køb er låst mod hinanden i databasen (advisory lock på
transaktions-id/Google-token), så en samtidig refusion ikke går tabt.

Er pointene brugt, går saldoen i **minus**:
- Chefen får en drift-alarm (`boost/iap-minus`), og købet er markeret under Admin → brugeren → Boost-point.
- Nye boost er blokeret, til saldoen er over prisen for et boost.
- Nye køb og optjente point lægges til som normalt.
- Delvise refusioner hos Apple (`REFUND_PRORATED`) trækker den refunderede andel (rundet op).
- `REFUND_REVERSED` (Apple har trukket refusionen tilbage) giver ikke pointene igen automatisk. Chefen får besked og
  kan justere pointene.
- `CONSUMPTION_REQUEST`: BidHamr har ikke køberens samtykke til at dele forbrugsdata med Apple. Apples vejledning er,
  at man så ikke svarer. Der laves kun en note på købet.

**Ingen faktura og ingen kvitteringsmail fra BidHamr.** Købene ligger i `boost_iap_koeb`, ikke i `boost_koeb`. Derfor
ser fakturakøen (`faktura_planlaeg_boost`) og Stripe-flowet dem aldrig.

**Stripe-refusion ved minus:** refunderer chefen et Stripe-køb, mens saldoen er i minus, trækkes der ingen point
(tilbageførslen klippes til 0). Admin viser en advarsel i dialogen, før refusionen gives.

**Testkøb** (Apple Sandbox og Googles licenstestere) er gratis:
- Altid tilladt på testdatabasen (gemmes som `miljoe = 'test'`).
- På produktion kun når **begge** dele er sat (ellers slået fra - fail closed):
  - `IAP_TILLAD_TESTKOEB_TIL=<ISO-dato>` i fremtiden og **højst 14 dage frem**. En dato i fortiden, for langt frem
    eller i et andet format slår det fra.
  - `IAP_TESTKOEB_KONTI=<bruger-id>,<bruger-id>` - kun disse konti (fx kontoen til Apples App Review) må lave testkøb.
- Testkøb i produktion får markeringen `testkoeb_prod` og tælles for sig i rapporten (ikke som omsætning).
- Så længe det er slået til, logger den daglige cron en drift-advarsel: "Testkøb er slået til i produktion"
  (`boost/iap-testkoeb`).
- Når Apple har godkendt appen: fjern de to variabler, og træk testkøbene tilbage samlet i Supabase SQL Editor:
  `select public.boost_iap_tilbagekald_testkoeb();` Svaret er antal køb og point. Den er idempotent.
- Det gamle flag `IAP_TILLAD_TESTKOEB=1` virker ikke længere.

## Rapport

Admin → **Penge** → "Boost-salg" viser for perioden, hver for sig:
- **bidhamr.dk (Stripe):** antal, bruttopris og refusioner.
- **App Store:**
  - antal og point
  - bruttopris i DKK (Apple oplyser prisen på købet)
  - listepris på bidhamr.dk
  - refusioner
  - testkøb (heraf testkøb i produktion)
- **Google Play:** de samme tal. Google oplyser ikke prisen på købet, så her vises kun listeprisen. Promokoder vises
  for sig og tæller ikke med i omsætningen.
- Antal brugere med negativ saldo.

Admin → brugeren → Boost-point viser brugerens køb i appen med platform, pris, transaktions-id, markering (testkøb i
produktion / promokode), refusion og noter.

**Download dine data** (`mine_data`) har nøglen `boost_koeb`: saldo, køb på bidhamr.dk (Stripe: point, beløb,
status, datoer - uden Stripe-id'er) og køb i appen (platform, transaktions-id, produkt, point, pris, land,
refusion - uden Googles token).

## Bogføring

- **Køb på bidhamr.dk (Stripe):** BidHamrs egen omsætning med dansk moms og faktura fra BidHamr (uændret,
  docs/FAKTURA.md).
- **Køb i appen:** Apple/Google er sælger over for køberen. De opkræver og afregner momsen i køberens land og udsteder
  kvitteringen. BidHamr fakturerer ikke køberen. BidHamr modtager en månedlig udbetaling fra Apple/Google: salg minus
  deres gebyr (15 %) og minus den moms, de afregner.
- Forslag (skal godkendes af revisoren):
  - Bogfør udbetalingen pr. måned ud fra Apples "Financial Reports"/"Payments and Financial Reports" og Googles
    "Earnings report" som omsætning via Apple og Google.
  - Gebyret bogføres som en købt ydelse fra udlandet (Apple Distribution International, Irland / Google Ireland
    Limited), formentlig med omvendt betalingspligt for moms.
  - Refusioner fratrækkes af Apple/Google i rapporten.
- Bilag: rapporterne fra App Store Connect og Play Console. Databasens tal (Admin → Penge) er kun til afstemning.
  Apple/Google er sandheden om beløbet.

**TODO til revisoren:**
- Bekræft, at køb i appen bogføres som omsætning via Apple/Google (nettometoden eller bruttometoden?).
- Bekræft, at BidHamr ikke skal afregne dansk moms af køberens betaling, når Apple/Google er sælger.
- Afklar momsbehandlingen af Apples/Googles gebyr (omvendt betalingspligt?).
- Bekræft, hvilke rapporter der skal gemmes som bilag, og hvordan valutakurser for udbetalinger i anden valuta
  håndteres.
- Afklar, om udestående point skal medtages som forpligtelse (point købt i appen udløber aldrig - Apple 3.1.1).

## Miljøvariabler

Navnene står i `.env.example`. Mangler én, er køb i appen skjult på den platform (`klar: false`, `503
iap_ikke_klar`).

| Variabel | Hvad |
|---|---|
| `APPLE_IAP_ISSUER_ID` | Issuer ID (App Store Connect → Users and Access → Integrations → In-App Purchase) |
| `APPLE_IAP_KEY_ID` | Key ID for In-App Purchase-nøglen |
| `APPLE_IAP_PRIVATE_KEY` | Indholdet af .p8-filen (linjeskift må skrives som `\n`) |
| `APPLE_BUNDLE_ID` | `dk.bidhamr.app` |
| `APPLE_APP_APPLE_ID` | Appens Apple ID (tal, App Information) |
| `APPLE_IAP_MILJOE` | `Production` (bidhamr.dk) eller `Sandbox` (test.bidhamr.dk). `Sandbox` på produktionsdatabasen virker kun, mens testkøbsvinduet er åbent |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Service account-nøglen (hele JSON'en) |
| `GOOGLE_PLAY_PACKAGE` | `dk.bidhamr.app` |
| `GOOGLE_PUBSUB_AUDIENCE` | Audience i push-abonnementet, fx `https://bidhamr.dk/api/webhooks/google-play` |
| `GOOGLE_PUBSUB_SA_EMAIL` | Den service account, push-abonnementet signerer med |
| `IAP_KONTO_HEMMELIGHED` | Påkrævet (begge platforme). Mindst 32 tegn, fx `openssl rand -hex 32`. Bruges til kontobindingen (`appAccountToken`). **Må aldrig roteres**: kontobindingen i alle tidligere køb og installerede apps er regnet ud med den, så med en ny hemmelighed afvises gamle køb (genkøb, gendannelse) som `anden_konto`. Lækker den, så kontakt udvikleren, før noget ændres. Forskellig på bidhamr.dk og test.bidhamr.dk |
| `IAP_TILLAD_TESTKOEB_TIL` | Valgfri, kun produktion. ISO-dato (fx `2026-11-10`), højst 14 dage frem. Testkøb er tilladt indtil da (kun under App Review) |
| `IAP_TESTKOEB_KONTI` | Valgfri, kun produktion. Kommaseparerede bruger-id'er, der må lave testkøb (fx App Review-kontoen) |

## Filips opsætning

### App Store Connect (Apple)

1. **Aftaler, skat og bank** (Business):
   - Underskriv **Paid Applications Agreement**.
   - Udfyld bankoplysninger og skatteoplysninger (W-8BEN-E for et dansk selskab).
   - Uden det kan der ikke sælges i appen.
2. **App Store Small Business Program:** Ansøg på developer.apple.com/app-store/small-business-program. Så er gebyret
   15 % i stedet for 30 %.
3. **In-App Purchases** (appen → Monetization → In-App Purchases): opret tre **Consumable**-produkter:
   - `dk.bidhamr.app.boost100` - "100 boost-point" - 39 kr. (eller nærmeste price point)
   - `dk.bidhamr.app.boost300` - "300 boost-point" - 99 kr.
   - `dk.bidhamr.app.boost700` - "700 boost-point" - 199 kr.
   - Hvert produkt skal have dansk visningsnavn, beskrivelse og et review-skærmbillede.
   - Produkterne skal sendes til review sammen med appversionen.
   - Tilgængelighed: alle lande, hvor appen er.
4. **In-App Purchase Key** (Users and Access → Integrations → In-App Purchase):
   - Generér en nøgle, og download .p8-filen. Den kan kun hentes én gang.
   - Notér **Key ID** og **Issuer ID**.
   - Sæt `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID` og `APPLE_IAP_PRIVATE_KEY` i Vercel.
5. **App Store Server Notifications** (appen → App Information):
   - Vælg **Version 2**.
   - Production Server URL: `https://bidhamr.dk/api/webhooks/apple`.
   - Sandbox Server URL: `https://test.bidhamr.dk/api/webhooks/apple`.
   - Test med "Request a Test Notification". Den skal vise `TEST` i serverens log med svaret 200.
6. **Appens Apple ID:** står under App Information. Sæt det i `APPLE_APP_APPLE_ID`. Sæt også `APPLE_BUNDLE_ID` og
   `APPLE_IAP_MILJOE` (Production på bidhamr.dk, Sandbox på test.bidhamr.dk).
7. **Sandbox-testere** (Users and Access → Sandbox → Test Accounts):
   - Opret et par testkonti med e-mails, der ikke er rigtige Apple-konti.
   - Log ind med dem under Indstillinger → App Store → Sandbox-konto på en testtelefon.
8. **Under App Review:**
   - Apple køber i Sandbox. Opret en BidHamr-konto til reviewerne, og sæt midlertidigt i produktion:
     `IAP_TESTKOEB_KONTI=<kontoens bruger-id>` og `IAP_TILLAD_TESTKOEB_TIL=<dato højst 14 dage frem>`.
   - Når appen er godkendt: fjern begge, og kør `select public.boost_iap_tilbagekald_testkoeb();`. Udløber datoen,
     slås det fra af sig selv. Andre konti (fx TestFlight-testere) kan aldrig få gratis point i produktion.

### Google Play Console

1. **Betalingsprofil / merchant-konto** (Settings → Payments profile): opret den, og knyt den til udviklerkontoen.
   Udfyld bank og skat. Først da kan der sælges i appen.
2. **Servicegebyr:** Google tager 15 % af de første 1 mio. USD om året. Tjek, at kontoen står til 15 % (kræver
   evt. en "account group" under Settings → Developer account).
3. **In-app-produkter** (Monetize with Play → Products → One-time products / In-app products):
   - Opret `dk.bidhamr.app.boost100` (39 kr.), `dk.bidhamr.app.boost300` (99 kr.) og `dk.bidhamr.app.boost700`
     (199 kr.).
   - Giv dem dansk navn og beskrivelse, og aktivér dem.
   - Slå **ikke** "flere stk." (multi-quantity) til.
4. **Service account:**
   - I Google Cloud (samme projekt som Pub/Sub): aktivér **Google Play Android Developer API**.
   - Opret en service account, og download en JSON-nøgle. Sæt hele JSON'en i `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
   - I Play Console → Users and permissions: invitér service accountens e-mail med adgang til appen og rettighederne
     **"View financial data, orders and cancellation survey responses"** og **"Manage orders and subscriptions"**.
   - Det kan tage op til et døgn, før adgangen virker.
5. **Pub/Sub:**
   - I Google Cloud → Pub/Sub: opret et topic, fx `play-rtdn`.
   - Giv `google-play-developer-notifications@system.gserviceaccount.com` rollen **Pub/Sub Publisher** på topic'et.
   - Opret et **push-abonnement** på topic'et:
     - Endpoint `https://bidhamr.dk/api/webhooks/google-play`.
     - Slå **Enable authentication** til, og vælg en service account (den e-mail sættes i `GOOGLE_PUBSUB_SA_EMAIL`).
     - Audience: `https://bidhamr.dk/api/webhooks/google-play` (sættes i `GOOGLE_PUBSUB_AUDIENCE`).
     - Pub/Sub-tjenesteagenten `service-<projektnummer>@gcp-sa-pubsub.iam.gserviceaccount.com` skal have rollen
       `iam.serviceAccountTokenCreator`.
   - Lav et separat topic og abonnement til test.bidhamr.dk, hvis testserveren også skal have notifikationer.
6. **RTDN** (Play Console → Monetize with Play → Monetization setup → Real-time developer notifications):
   - Indtast topic-navnet `projects/<projekt>/topics/play-rtdn`.
   - Vælg at få notifikationer for alle typer (også engangskøb).
   - Tryk "Send test notification". Serveren svarer 204.
7. **Licenstestere** (Settings → License testing): tilføj testernes Google-konti. Deres køb er gratis testkøb
   (`purchaseType` 0) og virker kun på test.bidhamr.dk, eller i produktion for kontiene i `IAP_TESTKOEB_KONTI`, mens
   `IAP_TILLAD_TESTKOEB_TIL` er gyldig.
8. **Apple Get Notification History** bruges også af den daglige cron med samme In-App Purchase-nøgle. Der skal
   ikke sættes andet op.
9. **Voided Purchases API** bruges af den daglige cron (en del af betalings-cron'en, én gang i døgnet). Den kræver
   samme service account. Der skal ikke sættes andet op.

### Sådan testes det (test.bidhamr.dk)

1. Kør migrationerne, og sæt variablerne med `APPLE_IAP_MILJOE=Sandbox` og en `IAP_KONTO_HEMMELIGHED`.
2. `GET /api/app/boost/iap` skal give `klar: { ios: true, android: true }`.
3. Køb 100 point med en Sandbox-tester og en licenstester. Saldoen stiger med 100, og købet står under Admin →
   brugeren → Boost-point.
4. Send samme køb igen (genstart appen). Svaret er `allerede`, og saldoen er uændret.
5. Brug pointene på 2 boost, og refundér så købet:
   - Apple: Sandbox → "Refund" i StoreKit Testing eller via reportaproblem.apple.com.
   - Google: Play Console → Order management → Refund. Tjek i Vercel-loggen, at RTDN'en blev bekræftet (resultat
     `tilbagefoert`, ikke `ikke_bekraeftet`) - det viser, at Googles `purchaseState` for et refunderet køb virker.
6. Saldoen går til -100. Drift-alarmen kommer, og boost er blokeret.
7. Log ind som firma. GET giver `kanKoebe: false`, og POST giver 403.
