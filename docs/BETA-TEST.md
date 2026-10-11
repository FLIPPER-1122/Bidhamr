# Beta-test – plan til Filip

Roadmap, fase 6: "Beta-test med 10-20 rigtige, fremmede personer, der køber og sælger med testpenge. Ret det, de støder på."

Hører sammen med:
- `docs/BETA-GUIDE-TESTPERSONER.md` – guiden, testpersonerne får
- `docs/BETA-FEJLSKABELON.md` – fejlmelding og spørgeskema til bagefter

Punkter markeret **[CHEF]** kræver en teknisk beslutning eller noget, der skal bygges eller tjekkes, før testen starter.

---

## 1. Formål

- Se om fremmede kan bruge hele forløbet uden hjælp: opret konto, MitID, opret auktion, byd, vind, betal, send, modtag, godkend og opret en sag.
- Finde fejl, uklare tekster og steder, hvor folk går i stå.
- Se om reglerne føles rimelige: gebyrer, frister, BidHamr Beskyttelse og sager.
- Testen foregår på hjemmesiden, i telefonens browser og på computer. Appen er ikke med, fordi den ikke er klar endnu.

---

## 2. Hvem der skal rekrutteres

**Antal:** 10-20 personer. Rekruttér 20, fordi nogle falder fra.

**Fordeling (mål):**

| | Antal ud af 20 |
|---|---|
| Mest sælger | 6 |
| Mest køber | 6 |
| Begge dele | 8 |
| 18-29 år | 6 |
| 30-49 år | 7 |
| 50 år og over (gerne 2-3 over 60) | 7 |
| iPhone | ca. 10 |
| Android (gerne både Samsung og en anden) | ca. 10 |
| Bruger også computer under testen | mindst 5 |
| Vant til Vinted, DBA, Tradera eller lignende | ca. 12 |
| Har aldrig eller sjældent købt brugt online | ca. 8 |

**Krav:**
- Mindst 18 år (MitID-kravet). Alder tjekkes ved tilmelding.
- Ikke familie, nære venner eller folk, der har været med til at bygge BidHamr. Bekendtes bekendte er fint.
- Har tid til ca. 15-30 minutter om dagen i 2 uger og kan svare på beskeder inden for et døgn (fristerne er 48 timer).

**Hvor man finder dem:**
- Facebook-grupper for brugt-handel og lokale grupper
- Studerende (opslag på uddannelser, fx via studenterforeninger)
- LinkedIn og Filips netværk i anden og tredje led
- Seniorer: lokale foreninger og biblioteker

**Kort tilmeldingsskema (screening):**
1. Navn og e-mail
2. Alder (18-29 / 30-49 / 50-64 / 65+)
3. Telefon: iPhone eller Android, og hvilken model
4. Har du købt eller solgt brugte ting online det seneste år? Hvor?
5. Vil du helst sælge, købe eller begge dele?
6. Kan du være med i hele perioden [datoer]?

**Tak for hjælpen:** Filip beslutter, om testpersonerne får noget for det (fx et gavekort). Skriv det tydeligt i invitationen, hvis det er tilfældet.

---

## 3. Hvordan de får adgang

I dag er bidhamr.dk lukket: alle uden staff-rolle ser `/coming-soon`, og oprettelse af konti er lukket (`TILMELDING_AABEN` er ikke sat, og "Allow new users to sign up" er slået fra i Supabase). Testen må ikke åbne siden for alle.

**[CHEF] Hvor skal testen køre?** To muligheder:

| | A: bidhamr.dk (produktion) med invitationsliste | B: separat beta-side på testdatabasen |
|---|---|---|
| Stripe | Testmiljø (produktionen kører i Stripes testmiljø indtil fase 6) | Testmiljø |
| MitID | Virker allerede i Iduras testmiljø på bidhamr.dk | Ny callback-adresse skal sættes op hos Idura |
| Mails | Sendes rigtigt | Testdatabasen omdirigerer eller logger mails i dag (`src/lib/resend.ts`), så testpersonerne får ikke deres mails. Skal ændres |
| Data bagefter | Handelsdata slettes aldrig (bogføringsloven). Testhandler skal arkiveres og markeres som test (se `docs/GO-LIVE-STRIPE.md`, E2) | Kan ryddes frit |
| Regler i CLAUDE.md | Følger "Vercel bruger altid produktionsdatabasen" | Kræver et ekstra Vercel-projekt. Strider mod "Vercel skal altid bruge produktionsdatabasen" – kræver Filips ja |
| Ligner lanceringen | Ja, helt | Næsten |

**Anbefaling: A**, fordi det tester det rigtige setup (mails, domæne, MitID, cron), og fordi produktionen alligevel kører med testpenge indtil fase 6.

**Sikker adgang ved A – invitationsliste (bygget 11. okt. 2026, Filips ja):**
- Migration: `supabase/migrations/20261017010000_beta_invitationer.sql`. Skal køres i produktion (Filips ja), før testen starter. I produktion starter beta-testen **lukket**.
- **Sådan inviterer du:** Admin → Indstillinger → **Beta-invitationer** (admin og chef). Skriv e-mailen og evt. en note, og tryk **Send invitation**. E-mailen gemmes med små bogstaver og uden mellemrum. Personen får en mail på dansk (via Resend) med et link til `/signup`. Har e-mailen allerede en konto, siger mailen "Log ind" i stedet.
- **Sådan opretter testpersonen sig:** samme signup som ellers – fornavn, e-mail, adgangskode og fluebenet for brugerbetingelserne – og så den 6-cifrede kode på `/tjek-indbakke`. Under beta oprettes kontoen på serveren (`opretKonto` → `generateLink('signup')`), og koden sendes i vores egen mail, fordi "Allow new users to sign up" stadig er slået fra i Supabase. Det skal den blive ved med at være.
- **Kun inviterede kan oprette sig**, mens `TILMELDING_AABEN` ikke er `true`. Det tjekkes to steder: i signup-actionen og i databasen (`handle_new_user` afviser enhver ny auth-bruger uden aktiv invitation, så det ikke kan omgås via Supabase-API'et med anon-nøglen – heller ikke hvis nogen slår "Allow new users to sign up" til). Værnet hedder `beta_indstillinger.kun_inviterede`.
- **Gaten:** en indlogget bruger med aktiv invitation kommer forbi coming-soon, mens beta er åben, og kan bruge hele den private del af siden – men aldrig admin (`/admin*` sender til forsiden). Firmakonti og staff følger deres egne regler. Svaret gemmes i den signerede rolle-cookie i højst 5 minutter, så der ikke er et databasekald pr. side.
- **Status pr. invitation:** Inviteret, Oprettet konto, MitID-verificeret, Tilbagekaldt.
- **Ét klik for at lukke:** **Luk beta-testen** (kun chef). Beta-testerne ser coming-soon igen inden for 5 minutter, og ingen kan oprette sig med en invitation. Konti og data bevares. Hver invitation kan også tilbagekaldes enkeltvis (**Tilbagekald**) og genaktiveres (**Invitér igen**).
- Alt logges i `moderation_log` (se Admin → Medarbejder-log). Højst 60 nye invitationer pr. medarbejder pr. time; en invitation kan sendes højst 10 gange og højst én gang i minuttet.
- Google må ikke indeksere siden (`SEO_INDEKSERING` forbliver slået fra).
- **Ved lancering skal det slås fra:** luk beta-testen, og slå værnet fra (`update public.beta_indstillinger set kun_inviterede = false;` som migration med Filips ja) samme dag som `TILMELDING_AABEN=true`. Se HUSKELISTE.md under "Lancering".
- Opret bruger direkte i Supabase-dashboardet virker ikke, så længe værnet er slået til (medmindre e-mailen er inviteret). Firmakonti oprettes som før under Admin → Erhverv.
- Lokalt på testdatabasen er værnet slået fra, og tilmeldingen er åben. `SIMULER_FOER_LANCERING=true` og `SIMULER_TILMELDING_LUKKET=true` i `.env.local` viser beta-udgaven.

**Ikke anbefalet:** at sætte `TILMELDING_AABEN=true` og `LANCERET=1` midlertidigt. Så kan alle oprette sig og se siden, og en indlogget bruger uden staff-rolle kommer ikke forbi gaten uden `LANCERET` alligevel.

**[CHEF] Før start skal produktionen være på samme stade som testdatabasen.** Alle migrationer, testen bruger (MitID, fragt, sager, betalingsmodel, DAC7, fakturaer m.m.), skal være kørt i produktion. Saml dem til én godkendelse fra Filip. Status 11. okt. 2026: alle migrationer til og med `20261016050000` er kørt i produktion, også MitID.

---

## 4. Kun testpenge og test-MitID

- **Stripe kører i testmiljøet.** Testpersonerne betaler med testkortet `4242 4242 4242 4242`, en vilkårlig fremtidig udløbsdato og en vilkårlig CVC. Ingen rigtige penge bevæger sig. Tjek før start, at `stripe_tilstand.tilstand = 'test'`, og at Vercel har `sk_test_`/`pk_test_`-nøgler.
- **Testpersonerne skal aldrig bruge deres rigtige kort, MitID eller CPR-nummer.** Det står tydeligt i guiden.
- **MitID:** Iduras testmiljø. Hver testperson skal have sin egen testidentitet, fordi én MitID = én konto. Testidentiteten skal være over 18 år.
  - **[CHEF]** Beslut, om Filip opretter testidentiteterne på forhånd i MitID Test Tool (pp.mitid.dk) og sender brugernavnet til hver testperson, eller om testpersonerne selv opretter en. Anbefaling: Filip opretter dem, så de er 18+ og ikke deles. Skriv en kort trin-for-trin-vejledning med skærmbilleder til guiden, når det er afprøvet.
- **Udbetalingskonto (Stripe Connect):** Sælgere skal oprette en udbetalingskonto, før de kan oprette en auktion. I testmiljøet bruger de Stripes testoplysninger. **[CHEF]** Afprøv onboardingen i testmiljøet og skriv præcis, hvad testpersonerne skal taste (fx SMS-kode `000000` og testbankkonto `DK5000400440116243`). Opdatér guiden.
- **Fragt:** DAO/Shipmondo kører i sandkassen. Der sendes ingen rigtige pakker. Labelfri-koden er altid `123-456-789`. Sandkassen sender ingen sporingsmeldinger.
  - **[CHEF]** Tjek, at køberen kan trykke "Jeg har modtaget pakken" uden leveringsmelding fra DAO. Ellers skal staff kunne melde pakken leveret under testen, så sager og godkendelse kan testes.
- **[CHEF] Fakturaer:** Fakturaer på BidHamrs gebyrer må ikke ende i det rigtige regnskab. Tjek, at Dinero kører i testmiljøet (eller er slået fra) under hele testen.
- **[CHEF] DAC7:** Testhandler må ikke tælle med i DAC7-indberetningen.

---

## 5. Hvad de skal teste

Guiden har de samme opgaver i en kortere form. Hver opgave krydses af i spørgeskemaet bagefter.

**Konto**
1. Opret en konto, bekræft e-mailen med koden, og accepter brugerbetingelserne.
2. Bekræft med test-MitID (sker før første bud eller første auktion).
3. Ret profil og notifikationsindstillinger.

**Sælger**
4. Opret udbetalingskonto i Stripes testmiljø.
5. Opret en auktion med billeder, startpris, fragt (og evt. afhentning) og varighed.
6. Besvar et spørgsmål fra en køber ("Spørg sælger").
7. Når auktionen er solgt og betalt: lav fragtlabel, tag pakkebilleder med kameraet og tryk "Send pakke".
8. Prøv at rette en auktion, der har bud (skal være låst).

**Køber**
9. Søg og find en auktion. Følg en sælger, og gem en favorit.
10. Byd – både et almindeligt bud og "Byd automatisk" med et maksimum. Vælg BidHamr Beskyttelse på mindst ét bud.
11. Vind og betal på checkout-siden med testkortet inden for 48 timer. Vælg pakkeshop eller levering hjem.
12. Tryk "Jeg har modtaget pakken", og godkend handlen med en bedømmelse (1-5 stjerner).
13. Opret en sag på en anden handel (fx "skadet" med BidHamr Beskyttelse) med billeder af pakke, label og indhold.

**Begge**
14. Skriv beskeder i handlen. Prøv at skrive et telefonnummer i "Spørg sælger" (skal blokeres).
15. Download dine data under Min konto.
16. Anmeld en auktion eller profil (DSA), hvis noget ser forkert ud.

**Kun nogle få (aftales enkeltvis)**
- Lad være med at betale en vundet auktion (tester "ubetalt vinder" og "Tilbyd til næsthøjeste byder").
- Sælger: lad være med at sende inden 5 dage (tester automatisk annullering og refusion).
- Taber man en sag: anke (knappen åbner 24 timer efter afgørelsen).
- Afhentning hos sælger – kun hvis to testpersoner selv vil mødes.

**Filip skal selv sørge for:**
- At der er auktioner at byde på fra dag 1. Opret 10-15 auktioner fra egne testsælgere med 3 dages varighed.
- At sælgere og købere bliver parret, så alle får mindst én handel som køber og én som sælger (hvis de vil begge dele).
- At staff afgør sagerne hurtigt, så testpersonerne kan nå at se afgørelse og anke inden for de 2 uger.

---

## 6. Hvor længe testen varer

**2 uger** + 1 uges forberedelse og 1 uge efter.

| Tidspunkt | Hvad |
|---|---|
| Uge 0 (forberedelse) | [CHEF]-punkterne løst. Rekruttering. Testidentiteter. Filip opretter startauktioner. Én fuld prøve-handel med to af Filips egne testbrugere på bidhamr.dk |
| Dag 1-2 | Invitationer sendes. Konto, MitID, udbetalingskonto. Første auktioner (3 dage) |
| Dag 3-7 | Bud, vind, betal, send. Flere auktioner (3 og 5 dage) |
| Dag 6-10 | Modtag, godkend, opret sager. Staff afgør sager inden for 1 døgn |
| Dag 10-14 | Anker, ubetalte vindere, frister. Sidste auktioner skal slutte senest dag 11 |
| Dag 15 | Spørgeskemaet sendes. Svarfrist 5 dage |
| Uge 3 | Fejl rettes. Kort tak-mail med, hvad der er rettet |

Fristerne i reglerne (48 timer til betaling, 48 timer til sag, 4 dages ankefrist, 5 dages afsendelsesfrist) betyder, at en hel handel med sag og anke tager 7-10 dage. Auktioner, der starter efter dag 4, når derfor ikke en anke.

---

## 7. Hvordan fejl indsamles

**Kanaler:**
1. **Fejlformular** (Google Forms, se `docs/BETA-FEJLSKABELON.md`). Hovedkanalen.
2. **E-mail med skærmbillede** til en beta-adresse. **[CHEF]** Vælg adresse – fx `beta@bidhamr.dk` som gruppe i Google Workspace (se HUSKELISTE.md "Mail på bidhamr.dk"). Google Forms kræver Google-login for at uploade filer, så mail er nemmest til skærmbilleder.
3. **Kontaktformularen på siden** (`/kontakt`) som reserve. Den lander i `/admin/kontakt`.

**Filip samler alt i ét regneark** med kolonnerne: nr., dato, testperson, side, alvor, beskrivelse, status (ny / rettes / rettet / ikke en fejl), commit.

**Alvor:**
| Niveau | Betyder | Reaktion |
|---|---|---|
| Kritisk | Penge går forkert, nogen kan se eller gøre noget på andres vegne, siden er nede | Ret samme dag. Overvej at stoppe testen |
| Alvorlig | Man kan ikke gennemføre en opgave | Ret inden for 2 dage |
| Mindre | Tekst, layout, noget er uklart | Saml og ret efter testen |

Kritiske fejl om penge eller adgang går altid forbi reviewer, før de rettes.

**Én fælles kanal til spørgsmål:** fx en lukket Facebook-gruppe eller en Messenger-gruppe. Testpersonerne må ikke dele hinandens personoplysninger der. [CHEF] Filip vælger.

---

## 8. Det skal Filip tjekke hver dag

Morgen og aften, ca. 15 minutter.

**Admin på bidhamr.dk**
- `/admin/drift` – fejl, cron-kørsler, pg_cron-jobs og alarmer. "Sidste tjek" skal være under 5 minutter gammelt.
- `/admin/sager` – nye sager. Afgør inden for 1 døgn.
- `/admin/ubetalte` – ubetalte vindere, der venter på godkendelse.
- `/admin/betalinger` – røde flag ("Tilbagebetaling opgivet – kræver handling"), indsigelser og afvigelser.
- `/admin/handler` – handler, der står stille (ikke sendt, ikke modtaget).
- `/admin/rapporter` og `/admin/dsa` – anmeldelser og forbudte varer.
- `/admin/brugere/mistaenkelig` – fx forsøg med samme MitID på to konti.
- `/admin/kontakt` og `/admin/chats` – henvendelser fra testpersonerne.
- `/admin/penge` (kun chef) – at gebyrer og beløb ser rigtige ud.

**Uden for admin**
- Stripe-dashboardet (**testmiljø**): betalinger, refusioner, webhooks skal svare 2xx.
- Shipmondo-sandkassen: labels oprettes.
- Sentry: nye fejl.
- Resend: mails leveres, ingen mange afviste.
- Fejlformularen, beta-mailen og gruppen.

---

## 9. Bagefter

1. **Luk adgangen:** Admin → Beta-invitationer → **Luk beta-testen** (kun chef). Testpersonerne ser coming-soon igen inden for 5 minutter. Deres data bevares.
2. **Spørgeskema** (se `docs/BETA-FEJLSKABELON.md`) sendes dag 15. Tak-mail til alle.
3. **Ret fejlene:** Kritiske og alvorlige fejl rettes før lancering. Mindre ting lægges i `ROADMAP.md`. Forslag til ændrede regler skrives ind i `ROADMAP-BESLUTNINGER.md`, når Filip har besluttet dem.
4. **Ryd testdata, før der bruges rigtige penge** – som en migration med Filips ja (følg `docs/GO-LIVE-STRIPE.md`, E2):
   - Handelsdata slettes ikke. Testhandler, betalinger, sager og fakturaer arkiveres og markeres som test, så ingen cron prøver dem igen, og de ikke tæller i DAC7.
   - Auktioner fra testen arkiveres, så de ikke vises offentligt ved lancering.
   - Bedømmelser fra testen skjules, så sælgerprofiler starter forfra.
   - Stripe-id'er fra testmiljøet nulstilles (kunder, gemte kort, udbetalingskonti).
   - **[CHEF]** MitID-verificering fra testidentiteter skal nulstilles, så ingen konto bærer mærket "MitID-verificeret" på en testidentitet efter lancering. Beslut, om testpersonernes konti skal blive stående (de skal så verificere sig igen med rigtigt MitID og oprette udbetalingskonto på ny) eller lukkes.
5. **Data om testpersonerne:** fortæl dem på forhånd, hvad der gemmes. Teksten om dette skal godkendes af advokaten, fordi privatlivspolitikken stadig er et udkast. [CHEF]
6. **Sæt punktet til `[x]`** i `ROADMAP.md`, når fejlene er rettet, og Filip har godkendt.

---

## 10. Tjekliste før start

- [ ] [CHEF] Valg af A eller B (afsnit 3)
- [ ] [CHEF] Invitationsliste bygget (11. okt. 2026, migration `20261017010000`), gennemgået af reviewer og testet af tester
- [ ] Migration `20261017010000_beta_invitationer.sql` kørt i produktion (Filips ja), testpersonerne inviteret, og beta-testen åbnet af chefen
- [ ] [CHEF] Alle nødvendige migrationer kørt i produktion (Filips ja)
- [ ] [CHEF] Stripe i testmiljø bekræftet (nøgler og `stripe_tilstand`)
- [ ] [CHEF] Dinero i test eller slået fra. Testhandler tæller ikke i DAC7
- [ ] [CHEF] "Jeg har modtaget pakken" virker uden DAO-sporing
- [ ] [CHEF] Testidentiteter til MitID oprettet og vejledning afprøvet
- [ ] [CHEF] Testoplysninger til Stripe-udbetalingskonto afprøvet og skrevet ind i guiden
- [ ] [CHEF] Beta-mail og fejlformular sat op. Links sat ind i guiden
- [ ] `DRIFT_ALARM_MAIL` og Better Stack virker (`docs/overvaagning.md`)
- [ ] Filip har lavet én fuld prøvehandel på bidhamr.dk
- [ ] 10-15 startauktioner oprettet
- [ ] Guiden sendt til testpersonerne sammen med invitationen
