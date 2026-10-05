# Rapport – fase 4: Brugerens egne ting

Alt ligger lokalt på `main`. **Intet er pushet.**

## ⚠️ Rækkefølge: migrationer først, så push
Koden på `main` bruger de nye tabeller og funktioner. Opret auktion sender fx en ny kolonne med. **Kør migrationerne nedenfor i produktion, før du pusher**, ellers fejler bl.a. oprettelse af auktioner på bidhamr.dk.

## Hvad der er lavet

**Statistik på profilen** (`/konto/statistik`)
- Antal auktioner (i alt, aktive og solgte).
- Indtjening for denne uge, måned, år og i alt, delt op i "udbetalt" og "på vej". Beløbet er efter gebyr og uden fragt. Penge fra handler, hvor en refusion er i gang, tælles ikke med.
- Teksten siger, at betalingen håndteres af vores betalingspartner Stripe.
- Liste over auktioner man har budt på. Filtrene er Alle, Aktive, Vundet og Ikke vundet, og "Vundet" linker direkte til handlen.

**Følg sælgere**
- Følg-knap på sælgerprofilen og på auktionssiden.
- Oversigt under `/konto/foelger`.
- Profilen viser, hvor mange følgere sælgeren har, men ikke hvem de er.
- Blokerede brugere kan ikke følge hinanden. En anonymt spærret byder kan ikke afsløres via følgeknappen.

**Gemte søgninger** (`/konto/soegninger`)
- "Gem søgning" på /auktioner gemmer søgeord, kategori, postnummer og afstand.
- Man får højst én samlet besked pr. søgning hver 6. time, fx "3 nye auktioner matcher …".
- Man kan gemme højst 20 søgninger og omdøbe dem, slå besked til og fra og slette dem.

**Bedømmelser**
- Sælgeren kan skrive ét offentligt svar på en bedømmelse.
  - Svaret kan rettes eller slettes i 48 timer.
  - Kontaktinfo og grove ord afvises.
- Brugere kan rapportere en bedømmelse eller et svar.
- **Admin `/admin/bedommelser`:** staff kan skjule med en begrundelse, vise igen eller beholde.
  - En skjult bedømmelse tæller ikke med i gennemsnittet.
  - Ingen bedømmelse slettes nogensinde.
  - Den, der skrev teksten, får en besked med begrundelsen.
  - En medarbejder kan ikke behandle bedømmelser, han selv er part i.

**Konto og sikkerhed**
- **Bekræftelse af e-mail:**
  - Siden "Tjek din indbakke" med knappen "Send mailen igen".
  - Et udløbet link giver mulighed for at få en ny mail.
  - Ny bekræftelsesmail i BidHamr-stil.
- **Stærk adgangskode:**
  - Mindst 10 tegn.
  - Ikke en almindelig kode, og ikke ens mail eller navn.
  - Styrkemåler med ✓ og ✗.
- **To-trins-login** med en app som Google Authenticator. Det er frivilligt. Sletning, skift af adgangskode og data-download kræver koden, hvis man har slået det til.
- **Mail ved login fra en ny enhed.**
  - Liste over enheder med "Fjern" og "Log ud alle andre steder".
  - Der sendes højst 5 mails i timen.
- **Download dine data** (GDPR): en JSON-fil med alt om en selv. Andres adresse, telefon og e-mail er aldrig med.
- **Slet konto:**
  - Kan ikke ske, mens der er åbne handler, sager eller betalinger. Siden viser tydeligt, hvad der mangler, med links.
  - Persondata anonymiseres, og navnet bliver "Slettet bruger".
  - Handelsdata bevares altid.
  - Brugere kan nu heller ikke slettes hårdt fra Supabase-dashboardet. Før ville det slette deres auktioner, bedømmelser og beskeder.
  - Endpointet `/api/konto/slet` er klar, så appen kan tilbyde sletning. Det kræver Apple.

**Rettet undervejs** (fundet af reviewer og tester)
- **Samtidige bud kunne låse hinanden fast.** I testen gik 31 af 400 bud tabt. Nu blev 674 af 674 bud behandlet uden fejl.
- **Telefonnumre som "Mit nr er 2030 4050" og "insta: sofie_99" slap gennem chatfilteret.**
  - De stoppes nu.
  - Afhentningstider ("20.00-22.00", "klokken 20.30"), priser, størrelser og "Mit signal er dårligt" går stadig igennem.
  - Testet med 107 eksempler.
- **Visningsnavne må ikke indeholde e-mail eller telefon.**
- **Den offentlige profil viste forkerte tal**, fx 0 handler for en sælger med 29. Tallene passer nu med statistikken.
- **Et lynhurtigt dobbeltklik kunne oprette to auktioner eller give en forkert bud-fejl.** Begge dele er rettet.
- **Notifikationer citerer ikke længere svar og spørgsmål.** Staff kan skjule teksten bagefter, og så skal den heller ikke stå i notifikationen.
- **Tekster:**
  - /coming-soon sagde, at "pengene holdes sikkert". Nu står der, at betalingen håndteres af Stripe.
  - Knappen "Stop" hedder nu "Stop med at følge".
  - Sletningssiden samler blokeringerne pr. type.
- **/konto er hurtigere,** fordi Stripe først hentes, når man trykker "Gem et kort".

## Reviewer og tester
- **Reviewer:** alle dele er gennemgået to-tre gange. Alle kritiske og vigtige fund er rettet, og slutreviewet er godkendt.
- **Tester:** alt er testet i browseren som køber, sælger, medarbejder og snyder ved 375 og 1280 px. Slut-testen er grøn.
  - Alle sider scorer 90 eller mere i Lighthouse på mobil.
  - Testen dækker også to-trins-login, sletning, data-download og samtidige bud.
- **Testdatabasen:** alle migrationer er kørt og testet.
- **Typetjek og lint** går igennem.

## Det skal du gøre
1. **Sig "ja"**, så kører jeg disse 10 migrationer i produktion, i denne rækkefølge:
   1. `20261006042000_forbudte_varer_skaerpet.sql` (fra sidst: pistol, gevær og levende dyr bliver blokeret)
   2. `20261007010000_brugerens_egne_ting.sql`
   3. `20261007011000_brugerens_egne_ting_rettelser.sql`
   4. `20261007020000_bedoemmelse_svar.sql`
   5. `20261007021000_bedoemmelse_svar_rettelser.sql`
   6. `20261007030000_konto_sikkerhed_gdpr.sql`
   7. `20261007031000_konto_sikkerhed_rettelser.sql`
   8. `20261007040000_bud_laas.sql`
   9. `20261007050000_fase4_testrettelser.sql`
   10. `20261007051000_fase4_testrettelser_2.sql`

   **Bemærk:**
   - Nr. 9 ændrer navnet til "Bruger" for **11 rigtige brugere**, som i dag har deres e-mail som navn, og den vises offentligt. De gamle navne gemmes i et arkiv, så det kan fortrydes.
   - Nr. 4 regner alle brugeres gennemsnitlige bedømmelse ud på ny.

   **Push derefter.**
2. **Hold disse to tilbage**, indtil appen er klar. De står i fase 5 i ROADMAP.md.
   - `20261007012000_seller_follows_stramning.sql`: i dag kan alle se, hvem der følger hvem.
   - `20261007032000_mfa_database_haandhaevelse.sql`: databasen kræver to-trins-koden, når brugeren har slået det til.
3. **Supabase-dashboardet (produktion) → Authentication.** Det kan jeg ikke gøre for dig:
   - Slå **"Confirm email"** til.
   - Under Email Templates → "Confirm signup": indsæt `supabase/templates/confirmation.html` med emnet "Bekræft din e-mail til BidHamr". Tjek, at Site URL er https://bidhamr.dk.
   - Sæt **Minimum password length** til 10.
   - Slå **Secure password change** til. **Det er vigtigt:** uden det kan en, der har overtaget en session, skifte adgangskoden uden at kende den gamle. Det fandt tester.
   - Sæt mail-frekvens (max frequency) til 60 sekunder.
   - Slå "leaked password protection" til, hvis jeres plan har det.
   - Ved lancering: "Allow new users to sign up" og `TILMELDING_AABEN=true` i Vercel.
4. **Tjek Expo-appen.** Listen står i fase 5 i ROADMAP.md. Det vigtigste:
   - **To-trins-login:** har en bruger slået det til på hjemmesiden, skal appen bede om koden. Det gælder først, når nr. 2 ovenfor er kørt.
   - **Ny fejlkode BHN02:** navn med e-mail eller telefon afvises.
   - **Ny chat-grund `socialt_medie`.**
   - **`idempotens_noegle` ved opret auktion:** valgfri.
5. **Se det på localhost:**
   - /konto og /konto/statistik
   - følg en sælger
   - gem en søgning
   - svar på en bedømmelse
   - /admin/bedommelser
   - /signup
   - to-trins-login under /konto
   - /konto/slet

## Beslutninger, jeg har truffet – godkend eller ret
Skrevet i ROADMAP-BESLUTNINGER.md som "foreslået, afventer din godkendelse":
- **Bedømmelser:**
  - Sælgerens svar kan rettes eller slettes i 48 timer.
  - Et slettet svar kan ikke skrives igen.
  - Medarbejdere (ikke kun admin) kan skjule bedømmelser.
- **Konto og GDPR:**
  - Sletning er blokeret ved åbne handler, sager og betalinger.
  - Anonymisering i stedet for sletning.
  - Bedømmelser bevares som "Slettet bruger".
- **To-trins-login er frivilligt**, også for staff. Admin viser en anbefaling til staff uden.
- **Et telefonnummer skrevet alene, fx "22 34 56 78", bliver nu stoppet i chatten.** Før gik det igennem.

## Kendte begrænsninger
- **Kontaktfilteret** kan stadig narres af beslutsomme brugere, fx "2 0 3 0 4 0 5 0" eller "str 2030 4050". Det fanger de almindelige forsøg.
- **To-trins-login gælder ikke for Realtime og billed-upload**, før migration 032000 er kørt.
- **Gemte kort ligger stadig i Stripe**, når en konto slettes. Kun vores henvisning fjernes. Det ryddes op, når Stripe-arbejdet genoptages.
- **Der er ingen admin-knap til at fjerne en brugers to-trins-login**, hvis telefonen er væk. Lige nu skal det gøres manuelt i Supabase.
- **Rigtige bekræftelsesmails er ikke testet ende til ende.** Supabase afviser `@test.bidhamr.dk`-adresser, så linket blev testet via admin-API'et.
