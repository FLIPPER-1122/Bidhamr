# Rapport: cookie-banner, fejlovervågning, backup og hastighed

Alt ligger lokalt på `main`. **Intet er pushet.**

## ⚠️ Rækkefølge: kør migrationerne først, push bagefter
Koden på `main` bruger de nye ting i databasen, fx sortering efter pris og sundhedstjekket. **Kør de 7 migrationer nedenfor i produktion, før du pusher.**

## Hvad der er lavet

**Cookie-banner**
- Banneret ligger nederst og har knapperne "Accepter alle" og "Kun nødvendige". De er lige store, som Datatilsynet kræver. Der er også en knap til "Indstillinger", hvor intet er valgt på forhånd.
- På mobil er banneret kompakt og dækker ikke budknappen.
- Valget huskes i 12 måneder. "Cookieindstillinger" i footeren ændrer eller trækker samtykket tilbage.
- /cookies har en tabel over alle cookies og kan ses uden login.
- Teksten er ærlig: BidHamr bruger i dag kun nødvendige cookies (login, sikkerhed, dit valg og Stripes cookies mod svindel ved betaling). Der er ingen statistik eller reklame.
- Kommer der senere et statistik- eller reklameværktøj, kan det kun indlæses efter samtykke, og alle bliver spurgt igen.

**Fejlovervågning**
- `/api/helbred` svarer "ok", når siden og databasen virker. Den bruges af en overvågningstjeneste.
- **Alarm-mail til dig** hvert 5. minut, hvis der er:
  - nye slags fejl
  - mange fejl på kort tid
  - fejl i cron
  - fejl i Stripe-webhooks

  Du får højst én mail pr. slags pr. 30 minutter. Tekst fra brugernes browsere kommer aldrig med i mailen, så den kan ikke bruges til phishing.
- /admin/drift viser, om alarmerne kører.
- Vi bruger vores egen fejllog frem for Sentry, så der ikke kommer endnu en databehandler ind over brugernes data.

**Backup**
- Din Supabase-plan (Free) har **ingen backup, du kan gendanne fra**.
- Der er lavet et script, der tager en krypteret backup af database og billeder på din computer, og et script, der tester gendannelsen.
- Hele vejledningen og en nødplan står i [docs/backup.md](docs/backup.md).
- Login-sessioner er udeladt af backuppen, og backuppen krypteres med 7-Zip (AES-256).

**Hastighed**
- /auktioner viser 24 ad gangen med "Vis flere", og Mine handler viser 20 afsluttede ad gangen.
- Siderne bruger mindre JavaScript, og der er nye indeks i databasen.
- Score før → efter (ydelses-agentens måling):
  - forside 81 → 90
  - /auktioner 84 → 93
  - Mine handler 84 → 94
  - /konto 85 → 93
- **Målet "LCP under 2,5 sek." er ikke bekræftet.** Målt lokalt er LCP 3,0-3,6 sek., og testers måling gav lavere scores, fordi computeren var travl. Mål det rigtige tal på bidhamr.dk med PageSpeed Insights efter push.

**Rettet og forbedret undervejs**
- **/auktioner:**
  - Søgningen har en grænse pr. bruger og pr. IP.
  - `_` og `*` i søgningen virker korrekt.
  - Filtrene står i adressen, så "Tilbage", deling og menulinks virker.
  - "Laveste/Højeste bud" sorterer efter den pris, der vises.
- **Afstandssøgning:** alle auktioner får nu automatisk koordinater ud fra postnummeret. Det løser, at store afstande kunne give fejl.
- **Mine handler** er grupperet efter, hvad du skal gøre, fx "Du skal betale", "Du skal sende" og "På vej".
- **Cron-loggen** fyldte 82 MB af databasens 102 MB. Den ryddes nu dagligt og holdes på ca. 14 MB.

## Reviewer og tester
- **Reviewer:** alle dele er gennemgået, og fundene er rettet. Der er ingen kritiske fund. Slutreviewet er godkendt, og alle migrationer er klar til produktion.
- **Tester:**
  - Hele flowet er testet ved 375 og 1280 px: cookie-banner, /auktioner, Mine handler, sundhedstjek, /admin/drift og regression.
  - Snydeforsøg blev afvist.
  - Testerens fund er rettet bagefter, men ikke testet igen af tester.
- **Typetjek og lint** går igennem.

## Det skal du gøre
1. **Sig "ja"**, så kører jeg disse 7 migrationer i produktion, i denne rækkefølge:
   1. `20261008010000_drift_alarmer.sql`
   2. `20261008011000_drift_alarmer_rettelser.sql`
   3. `20261008020000_cron_log_oprydning.sql`. Den sletter ca. 142.000 gamle cron-logrækker. Det er ikke handelsdata.
   4. `20261008030000_ydelse_indeks.sql`
   5. `20261008031000_ydelse_indeks_2.sql`
   6. `20261008040000_auktion_visningspris.sql`. Den låser auktionstabellen i nogle sekunder, så kør den ikke lige når en auktion slutter.
   7. `20261008050000_auktion_koordinat_fra_postnummer.sql`

   **Push derefter.**
2. **Tjek Expo-appen før nr. 6:**
   - Den nye kolonne `visningspris` regnes ud af databasen. Sender appen en hel auktion tilbage ved redigering, fx efter `select("*")`, fejler det. Den skal kun sende de felter, der ændres.
   - Appen behøver ikke længere sende lat/lng, for databasen sætter dem ud fra postnummeret.
3. **Vercel → Settings → Environment Variables (Production):**
   - Sæt `DRIFT_ALARM_MAIL` til din e-mail, og redeploy.
   - Sæt **ikke** `HELBRED_TIMEOUT_MS`.
4. **Better Stack** (gratis, EU-baseret): opret en monitor på `https://bidhamr.dk/api/helbred` hvert 5. minut med mail til dig. Se [docs/overvaagning.md](docs/overvaagning.md). Slå også mail om fejlede deploys til i Vercel.
5. **Backup:**
   - Installér **7-Zip** og **Docker Desktop**, og følg [docs/backup.md](docs/backup.md) for at tage den første backup og teste gendannelsen.
   - **Beslut, om du vil opgradere Supabase til Pro** (ca. 175 kr./md.). Det giver 7 dages daglige backups med gendannelse med ét klik. Det anbefales senest før lanceringen.
6. **Efter push:** mål forside, /auktioner og en auktionsside med PageSpeed Insights (pagespeed.web.dev) på mobil.

## Spørgsmål til dig
1. **Cron-loggen** slettes nu efter 14 dage i stedet for 90 dage, som du tidligere har besluttet. Intet på siden kigger mere end 24 timer tilbage, og fejlloggen beholdes stadig i 90 dage. Er 14 dage ok?

## Kendte begrænsninger
- **Backup og gendannelse af databasen er ikke kørt rigtigt endnu**, fordi Docker mangler på din computer. Backup af billeder er testet og virker.
- **Hastighedsmålet** skal bekræftes på bidhamr.dk.
- **Advokaten bør bekræfte**, at disse må regnes som nødvendige cookies:
  - `bh_enhed`: mail ved nyt login, 400 dage
  - kladden til auktioner
  - Stripes svindel-cookies
- **En afsluttet handel med en åben sag** vises både under "Sager i gang" og "Afsluttede" i Mine handler.
