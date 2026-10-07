# BidHamr – Roadmap mod lancering

**Mål: hjemmeside og app er teknisk færdige inden udgangen af 2026.** Hele 2027 går til marketing og møder. Lancering juni 2027.
Faserne tages i rækkefølge. Fase 6 afhænger af CVR-nummer og advokat og kan først lukkes, når de er på plads.

Bygget ud fra `ROADMAP-BESLUTNINGER.md`. Agenterne tager altid det øverste åbne punkt i den aktive fase.
Afkryds med `[x]`, når Filip har godkendt og pushet. Intet må pushes af agenter.

Status: `[ ]` ikke startet · `[~]` i gang · `[x]` færdig

---

## Fase 0 – Fundament
Formål: rydde op, så agent-teamet kan arbejde sikkert og ens.

- [x] Erstat den ødelagte `CLAUDE.md` i hamr (indeholder PDF-data) med en ren markdown-fil
- [x] Skriv `PRODUKT.md` (produktretning: Tradera for auktionen, Vinted for handlen, egne regler)
- [x] Skriv `DESIGN.md` (designsystem ud fra mockup D: farver, skrifttyper, knapper, kort, afstande)
- [x] Sæt agent-team op i `.claude/agents/` (backend, betaling, frontend, indhold, reviewer, tester) + chef-rolle i CLAUDE.md
- [x] Agenterne arbejder i egne git worktrees og fletter ind i `main` – Filip pusher (se regel 1 i CLAUDE.md)
- [x] Testdatabase "Bidhamr Test" sat op: `npm run dev` bruger test, bidhamr.dk bruger produktion
- [x] Ret fejl: bedømmelser kan i dag gives af alle til alle (kun køber → sælger efter handel)
- [x] Ret gebyr i koden: sælgergebyr fra 10% til 5% (`wallet_udbetal_saelger`, `admin_frigiv_handel`)
- [x] Nyt design (farver, skrifttyper, logo, favicon) og ny coming-soon-side
- [x] Next.js opgraderet til 16.3.6 (sikkerhedshuller lukket)
- [x] **Sikkerhed-agent** oprettet og første fulde sikkerhedsgennemgang af hele systemet (RLS på alle tabeller inkl. dem lavet direkte i Supabase, funktioner, storage, nøgler, login, admin-adgang). Kritiske fund rettes, før fase 1 fortsætter. Agenten køres derefter efter hver fase
- [ ] **Filip – afklar med rådgiver/advokat (blokerer IKKE fase 1 – agenterne bygger videre i testmiljøet):**
  - BESLUTTET: **Stripe holder pengene (Stripe Connect), ikke BidHamr. Ingen købersaldo – vinderen betaler selv inden for 24 timer, og gemt kort med automatisk betaling er et tilvalg.** Stripe har bekræftet det overordnede (se chat-udskrift på mail). Opsætningen er besluttet: separate charges and transfers. Tag Stripes svar med til rådgiveren, så han kan bekræfte, at BidHamr ikke selv skal have tilladelse
  - BESLUTTET: Det hedder **"BidHamr Beskyttelse"** – aldrig "forsikring" nogen steder på siden, i mails eller i koden
  - **Hvidvaskloven**: gælder den for BidHamr, når I håndterer betalinger (kundekendskab ved store beløb)?

## Fase 1 – Handelsflowet færdigt og sikkert
Formål: alt efter auktionen virker hele vejen, med testpenge. Sikkerheden i top.

- [x] **Ny betalingsmodel: betal når du vinder – ingen saldo** (stort punkt – tages først i fasen). Stripe har bekræftet, at en købersaldo ikke passer til Stripe Connect og kan kræve e-penge-tilladelse. Derfor:
  - Den nuværende wallet med indbetaling før bud, låsning af beløb og wallet-tabel **fjernes**
  - Når auktionen slutter, har vinderen **24 timer til selv at betale** (bud + købergebyr + fragt + evt. BidHamr Beskyttelse) med kort, **MobilePay**, Apple Pay eller Google Pay. Påmindelser efter 12 og 20 timer
  - **Valgfrit: automatisk betaling.** Brugeren kan i sine indstillinger gemme et kort og slå "Betal automatisk, når jeg vinder" til. Så trækkes kortet med det samme, når auktionen slutter. Det er et tilvalg, ikke et krav
  - Pengene ligger på BidHamrs Stripe-konto (manuelle udbetalinger), indtil køber bekræfter / 48 timer uden sag / sag er afgjort
  - Sælger oprettes som **Stripe Connect-konto** (Express), og Stripe tjekker sælgerens identitet. Pengene overføres minus sælgergebyr, og Stripe udbetaler til sælgerens bank
  - Opsætning: **BESLUTTET – "separate charges and transfers"** med manuelle udbetalinger. Køber betaler til BidHamrs platformskonto, og pengene overføres til sælgerens Connect-konto, når de frigives. Bekræftes med Stripes team, når de svarer, men der bygges videre på det nu
- [x] **Testmiljøet flyttes til Stripe**: al test af penge sker i **Stripes testmiljø** (test mode), ikke med testsaldoer i BidHamrs egen database
  - Opret Stripe-testnøgler (`sk_test_` / `pk_test_`) på Filips Stripe-konto og læg dem i Vercel + `.env.local` i stedet for de gamle nøgler
  - Test med Stripes testkort (fx 4242 4242 4242 4242) og testkort, der bliver afvist eller kræver 3D Secure
  - Opret falske sælgerkonti i Stripe Connect test mode til at teste udbetalinger
  - **Fjern** admin-værktøjerne "Sæt saldo" og "Justér saldo" og siden med wallet-transaktioner – de hører til den gamle model
  - **Fjern** wallet-tabellerne og wallet-funktionerne i databasen (`wallets`, `wallet_entries`, `bid_reservations`, `wallet_*`-funktionerne) med en migration, når det nye flow virker
- [x] **Hvis vinderen ikke betaler inden 24 timer** (eller den automatiske betaling fejler og han ikke betaler selv inden for fristen): handlen annulleres, køber får en advarsel (tæller med i 3-advarsler-reglen), og sælger kan tilbyde varen til næsthøjeste byder eller sætte den op igen
- [x] Gennemgang af hele pengestrømmen (reviewer): køb, gebyrer, frigivelse, refusion, ingen huller
- [x] Gebyrer: 5% køber + 5% sælger, altid
- [x] **BidHamr Beskyttelse**: 5% tilkøb for køber (min 25 / maks 250 kr), vælges ved bud (låst)
- [x] **Notifikationssystem** (bygges før staff-chat og sager): klokke med rødt tal + indbakke, mail og push; side med notifikationsindstillinger, hvor brugeren vælger kanal pr. type; påkrævede typer kan ikke slås helt fra (se ROADMAP-BESLUTNINGER afsnit 5)
- [x] **Chat mellem staff og brugere** (bygges før sagerne, fordi de bruger den):
  - Medarbejder, admin og chef kan klikke **"Åbn chat"** med en bruger fra admin (brugersiden eller en sag). Først derefter kan brugeren skrive i den samtale. Brugere kan IKKE selv starte en samtale med BidHamr – vil de kontakte os, skriver de en mail
  - Brugeren ser samtalen under "Beskeder" og kan svare, så længe chatten er åben. Staff har **til hver en tid** en knap "Afslut chat" i samtalen; derefter kan brugeren ikke skrive mere (samtalen kan stadig læses)
  - Beskeder fra BidHamr er tydeligt markeret. Alle samtaler logges og gemmes (slettes aldrig)
  - **Ved en sag:** staff skriver med køber og sælger hver for sig i separate interne samtaler, der knyttes til sagen. Admin kan desuden skrive en fællesbesked til begge i den eksisterende chat mellem køber og sælger (tydeligt markeret som besked fra BidHamr)
- [x] Sag inden for 48 timer efter afhentning – pengene fryses og sagen vises på Sager-siden
- [~] Uden BidHamr Beskyttelse: ingen retur via BidHamr. Med beskyttelse: BidHamr håndterer sagen *(delvist: returlabel mangler – se fase 2, venter på aftale med fragtfirma)*
- [x] Bedømmelse: køber skal give sælger 1-5 stjerner, før godkendelse går igennem
- [x] Afhentning hos sælger: køber giver stjerner og viser koden → pengene frigives med det samme
- [x] Krævede pakkebilleder i "Send pakke" (kamera direkte, ikke kamerarulle): varen indpakket i åben kasse + lukket kasse med label
- [x] Sag kræver billeder fra køber (pakke, label, indhold) inden for 48 timer
- [x] Svindel-undtagelse: åbenlys svindel giver altid en sag, med eller uden beskyttelse
- [x] Permanent lukning af konti ved svindel (køber eller sælger)
- [x] Advarselssystem: dårlig indpakning giver påmindelse første gang, derefter en advarsel pr. gang. 3 advarsler = permanent lukning (byg videre på den eksisterende advarsel-funktion i admin)
- [x] Mails ved alle trin i handlen
- [x] **Udbetaling til sælgers bankkonto** via Stripe Connect (testmiljø – ingen rigtige penge endnu)
- [ ] **DAC7**: brug Stripes "Platform Tax Reporting" til at indsamle og indberette sælgeroplysninger
- [x] Kvittering til køber og sælger efter handel med opdeling af pris, gebyr, BidHamr Beskyttelse og fragt (kvittering/handelsbekræftelse for selve varen – IKKE en faktura, fordi varen sælges mellem private)
- [ ] Filip: spørg revisor, om **Dinero** er et godkendt digitalt bogføringssystem, og vælg regnskabsprogram (Dinero, Billy eller e-conomic)
- [ ] **Automatiske fakturaer på BidHamrs egne gebyrer** med moms: køber får faktura på købergebyr + evt. BidHamr Beskyttelse, sælger får faktura på sælgergebyr. Oprettes automatisk i det valgte regnskabsprogram via API, så alle fakturaer ligger samlet ét sted. Fakturaerne vises også under brugerens profil. **Venter på Filips valg af regnskabsprogram** – byg kvitteringen først
- [x] Sælger kan redigere eller annullere sin auktion, så længe der ikke er bud
- [x] **Startpris = mindstepris**: sælger sætter én synlig startpris, som alle kan se. Første bud skal mindst være startprisen. Ingen skjult mindstepris
- [x] Ved oprettelse vises en tydelig anbefaling: "Sæt startprisen lidt under det, du regner med at få – er den for høj, byder ingen"
- [x] Oprydning: behandlede rapporter flyttes til arkiv efter 48 timer – gemmes permanent (cron)
- [x] Oprydning: afsluttede auktioner **skjules/arkiveres** 48 timer efter afsluttet handel – de må IKKE slettes, fordi kvitteringer, bedømmelser, DAC7 og bogføringsloven kræver, at handelsdata gemmes i 5 år
- [x] **Afsendelsesfrist**: sælger skal sende inden 5 dage. Sendes der ikke, annulleres handlen, og køber refunderes fuldt (som Vinted/Tradera)
- [x] **Bindende bud**: bud kan ikke trækkes tilbage – vises tydeligt, før man byder
- [x] Minimum budstigning (fx +10 kr / +5%) og valg af auktionsvarighed ved oprettelse
- [x] **Anke**: den, der taber en sag, kan anke. **Anke-knappen åbner først 24 timer efter afgørelsen** (afkølingsperiode), og derefter er der **3 dage** til at anke. Kræver begrundelse og gerne ny dokumentation. Behandles af en anden medarbejder end den, der afgjorde sagen (admin/chef). Afgørelsen på anken er endelig. Pengene er frosset, til ankefristen er udløbet (i alt 4 dage efter afgørelsen). Gælder kun handler med en sag

## Fase 1B – Nyt admin-dashboard
Formål: ét samlet sted, hvor staff kan styre hele BidHamr. Bygges efter fase 1, fordi pengetallene afhænger af den nye Stripe-model.

- [x] **Forside med fokus på brugere**: antal brugere i alt, nye brugere i dag / denne uge / denne måned, graf over tilvækst. Derudover nye auktioner og solgte varer
- [x] **"Kræver handling nu"** øverst på forsiden: åbne sager, nye rapporter, handler der hænger, ubetalte vindere, fejlede betalinger
- [x] **Penge – KUN for rollen chef**: omsætning, BidHamrs indtjening (købergebyr, sælgergebyr, BidHamr Beskyttelse), betalinger, udbetalinger og refusioner fra Stripe, penge der holdes lige nu og hvornår de frigives. Medarbejdere og admins må ikke kunne se indtjeningstal – heller ikke via URL eller API (tjekkes på serveren)
- [x] **Brugere og sikkerhed**: søgning, advarsler, suspenderinger, MitID-status, mistænkelig aktivitet (fx mange sager eller mange ubetalte auktioner)
- [x] **Drift**: fejlede cron-jobs, mails der ikke er sendt, fejl på siden
- [x] **Medarbejder-log**: hvad hver medarbejder har gjort (bygger videre på moderation_log)

## Fase 2 – Fragt og automatisk frigivelse
Formål: sporing kører af sig selv, og sælgerne får deres penge uden manuel indgriben.

- [ ] Byg og test fragt mod **GLS' testmiljø** (kræver ikke firmaaftale) – skal være færdigt inden nytår
- [ ] Filip: møde med Shipmondo om den bedste løsning
- [ ] Filip: spørg GLS/Shipmondo, om fragtfirmaet selv **vejer pakken**, og om den målte vægt kan hentes via API (bruges som bevis i svindelsager)
- [ ] Filip: spørg GLS/Shipmondo om **reklamation ved transportskade**: kan BidHamr reklamere på sælgers vegne (fragten er på BidHamrs aftale), hvad er maks. erstatning pr. pakke, er elektronik/glas undtaget, og findes der tillægsforsikring?
- [ ] **Reklamation hos fragtfirma**: når en sag om transportskade afgøres til købers fordel, og sælger har pakket ordentligt, opretter staff (eller systemet via fragtfirmaets API) en reklamation med pakkebilleder, købers skadebilleder og sporingsdata. Status vises på sagen for sælger. Erstatning fra fragtfirmaet udbetales til sælger. Afvises den, lukkes reklamationen, og sælger får besked (se ROADMAP-BESLUTNINGER.md afsnit 4)
- [ ] Når GLS melder pakken leveret: notifikation "Pakken er kommet frem" til **køberen** (type pakke_leveret, påkrævet) – sælgeren får fortsat besked, når køberen bekræfter
- [x] Byg koden, så fragtfirmaet kan skiftes (GLS nu, evt. Shipmondo senere) uden at omskrive handelsflowet
- [ ] Sælger får fragtlabel/QR-kode direkte i BidHamr
- [ ] **Returlabel i sager**: når en sag afgøres med retur, får køberen et returlabel fra BidHamr via fragtfirmaet (køberen betaler returfragten). Sagsflowet med retur er bygget, men selve labelen mangler, indtil Filips aftale med fragtfirmaet er på plads – derfor er sagsretur kun delvist færdig
- [ ] Køber betaler fragt og ser prisen, før han byder
- [ ] Sporing hentes automatisk – status "afhentet" registreres
- [ ] Auto-frigivelse 48 timer efter afhentning, hvis ingen sag
- [ ] Sælger kan annullere/ændre en fragtbooking, så længe pakken ikke er afleveret
- [ ] Fragtberegner: sælger vælger pakkestørrelse (Lille/Mellem/Stor) ved oprettelse, prisen hentes fra GLS og vises på auktionssiden. Findes også som selvstændig side
- [ ] Vælger sælger en for lille pakkestørrelse, og fragtfirmaet opkræver ekstra, betaler sælgeren forskellen
- [ ] Ikke-afhentet pakke (GLS returnerer efter 7 dage): sælger beholder varen og får fragten dækket, køber refunderes minus gebyrer og fragt begge veje. Afhentning udløser aldrig udbetaling – kun købers bekræftelse (eller 48 timer uden sag) gør

## Fase 3 – Nyt design og forside
Formål: siden bliver troværdig, professionel, tryg og moderne.

- [x] Nyt logo (nr. 8) og app-ikon (7B) ind på web og i appen
- [x] Skift fra rød til den grønne/orange stil fra mockup D på hele siden
- [x] Ny forside: delt hero med søgefelt, tryghedsstribe, kategorier med ikoner, "Slutter snart"-kort
- [x] Ny menu/topbar med bedre struktur
- [x] Gennemgå alle øvrige sider, så de følger `DESIGN.md`
- [x] Hele hjemmesiden mobilvenlig
- [x] "Sådan virker det"-side og hjælp/FAQ (købersikring, gebyrer, fragt, sager)
- [x] Søgning og filtre: pris, kategori, slutter snart, afstand
- [x] Forbudte varer: liste + kontrol ved oprettelse af auktion
- [x] Blokering af brugere – inkl. at sælger kan spærre bestemte brugere fra at byde på sine auktioner
- [x] Rapportér en besked/bruger i chatten + automatisk spamfilter i beskeder
- [x] SEO (titler, beskrivelser, sitemap) og besøgsstatistik (cookie-venlig)
- [x] Filip: find en skabelon til **privatlivspolitik** og **brugerbetingelser/handelsbetingelser** *(begge ligger i `jura/` med noter til agenten: `brugerbetingelser-skabelon.md` og `privatlivspolitik-skabelon.md`)* (fx fra Erhvervsstyrelsen/Virk, Datatilsynet, din rådgiver eller en dansk skabelontjeneste for markedspladser) og læg den i projektet som `jura/privatlivspolitik-skabelon.md` og `jura/brugerbetingelser-skabelon.md`
- [x] Implementér privatlivspolitik og brugerbetingelser ud fra Filips skabeloner, tilpasset BidHamr og `ROADMAP-BESLUTNINGER.md` (indhold-agenten). Vises som egne sider og linkes fra footer, oprettelse af profil og betaling. Tydeligt markeret **"UDKAST – skal godkendes af advokat"**, indtil advokaten har gennemgået dem i fase 6. Brugeren skal acceptere brugerbetingelserne ved oprettelse
- [x] Footer og faste sider: Om BidHamr, Kontakt/kundeservice, Handelsbetingelser, Privatlivspolitik, Cookies *(Handelsbetingelser og Privatlivspolitik mangler – venter på Filips skabeloner)*
- [x] Kontaktformular til kundeservice, som lander i admin
- [x] Pæne fejlsider (404/500) og loading-tilstande overalt
- [x] **Spørg sælger**: købere kan stille spørgsmål til sælgeren, mens auktionen kører. **Sælger vælger selv ved oprettelse, om det er slået til eller fra** (kan ændres undervejs). Er det slået fra, vises "Sælgeren modtager ikke spørgsmål – læs beskrivelsen grundigt"
- [x] Tilgængelighedserklæring i footeren + "Rapportér en fejl"-knap
- [x] **Stand på varen** som faste valg ved oprettelse (Ny med mærke / Som ny / God / Brugt / Defekt) – gør "ikke som beskrevet"-sager lettere at afgøre
- [x] Billeder: op til 10 pr. auktion, understøt iPhone-formatet HEIC, automatisk komprimering
- [x] Pakkeguide i FAQ: "Sådan pakker du din vare" (hænger sammen med reglen om, at sælger har ansvaret for indpakning)
- [ ] "MitID-verificeret"-mærke på alle profiler *(venter på MitID – Filip, 6. okt.)*
- [x] Sælgerens adresse og telefonnummer vises aldrig offentligt – kun det nødvendige deles med køberen efter handlen
- [x] Opret auktion: gennemgå hele flowet, så det er hurtigt og nemt (billeder, kategorier, fragtvalg, forhåndsvisning)

## Fase 4 – Brugerens egne ting
Formål: brugerne har overblik og styr på deres beskeder.

- [x] Live statistikker under profil: antal auktioner, indtjening (uge/måned/år/lifetime), auktioner man har budt på
- [x] Følg sælgere
- [x] **Gemte søgninger med besked**: få besked, når der kommer nye auktioner, der matcher en søgning (fx "Omega ur")
- [x] Notifikationer: overbudt, ny auktion fra fulgt sælger, bud på egen auktion, vundet, pakke kommet frem
- [x] Side med notifikationsindstillinger (mail / app / begge / fra, pr. type)
- [x] Notifikations-indbakke på siden (klokke i topbaren)
- [~] Bekræftelse af e-mail ved oprettelse med en 6-cifret kode i mailen (ikke link, ikke SMS) *(bygget på hjemmesiden 7. okt. 2026 – "Confirm email" i Supabase slås først til, når appen håndterer koden (`verifyOtp` type `signup`), og en egen mailserver (SMTP, fx Resend) er sat op i Supabase)*
- [x] GDPR: brugeren kan slette sin konto og downloade sine data
- [x] Kontosikkerhed: mail ved login fra ny enhed, krav til stærk adgangskode, e-mail-kode ved oprettelse *(to-trins-login er udgået – fjernet 7. okt. 2026, Filip)*
- [x] Sælger kan skrive ét offentligt svar på en bedømmelse. BidHamr kan fjerne bedømmelser, der bryder reglerne (fx grove ord)

## Fase 5 – Appen
Formål: appen og hjemmesiden er ens 1:1. **Appen er det primære produkt** – de fleste brugere skal bruge appen frem for hjemmesiden.

**Appen kodes af Filip selv på MacBook'en (ingen app-agent).** Når den er færdig, flyttes koden til den stationære computer, og agent-teamet hjælper med at få app og hjemmeside til at matche.

- [ ] Filip: flyt den færdige app-kode fra MacBook til den stationære (via GitHub)
- [ ] Sammenlign app og hjemmeside skærm for skærm – lav en liste over forskelle
- [ ] Ret forskellene, så funktioner, tekster og design er ens (DESIGN.md gælder også appen)
- [ ] Appen bruger samme Supabase-database og samme Stripe-betalingsflow som hjemmesiden (vinderen betaler selv inden for 24 timer, valgfrit gemt kort, ingen saldo)
- [ ] Appen: ubekræftet e-mail håndteres (indtast koden fra mailen: `verifyOtp({ email, token, type: "signup" })`, ny kode med `resend({ type: "signup", email })`), og kontosletning direkte i appen (Apples krav 5.1.1(v)) via et sikkert endpoint (POST /api/konto/slet er bygget på hjemmesiden: Bearer-token, adgangskode + "SLET"). *(To-trins-login/AAL2 i appen er udgået – to-trins-login er fjernet 7. okt. 2026, og 20261007032000_mfa_database_haandhaevelse.sql er slettet.)*
- [ ] Appen: følgere tælles med `antal_foelgere()` og kun insert/delete på `seller_follows` – kør derefter `20261007012000_seller_follows_stramning.sql` i produktion (i dag kan alle se, hvem der følger hvem)
- [ ] Appen kender fase 4: `stand`, `idempotens_noegle` ved opret auktion (+ `min_auktion_for_noegle`), fejlkoden BHN02 (navn), `blokeret_grund = 'socialt_medie'`, `profil_offentlige_tal()`, svar på bedømmelser (`skriv_bedoemmelse_svar`, `bedoemmelse_svar`), gemte søgninger (`gemte_soegninger`) og notifikationstyperne `gemt_soegning` og `bedoemmelse`
- [ ] Push-notifikationer
- [ ] Statistikker i appen
- [ ] Nyt design og app-ikon (7B)

## Fase 6 – Klar til lancering
Formål: alt det juridiske og praktiske er på plads.

- [ ] CVR-nummer
- [ ] MitID-verificering ved oprettelse (Criipto) – virker ikke i dag
- [x] Cookie-banner
- [ ] Handelsbetingelser og privatlivspolitik skrevet af advokat
- [ ] Afklar med advokat: svindel og platformens ansvar
- [ ] Skift fra testpenge til rigtige penge (Stripe live), inkl. udbetaling til rigtige bankkonti
- [ ] DAC7: bekræft indberetningsforpligtelsen med revisor/advokat
- [ ] **Juridisk tjekliste til advokaten (dansk/EU-lov for markedspladser):**
  - Firmaoplysninger synligt på siden: navn, adresse, CVR og e-mail (e-handelsloven)
  - Tydeligt på hver auktion, at sælger er **privatperson**, og at forbrugerregler som 14 dages fortrydelsesret derfor ikke gælder
  - Forklaring af, hvordan søgeresultater sorteres (krav til markedspladser)
  - **Totalpris** vises før man byder: bud + købergebyr + fragt (+ evt. beskyttelse). Moms på BidHamrs egne gebyrer
  - Aldersgrænse 18 år (følger af MitID-kravet)
  - Databehandleraftaler med Supabase, Stripe, Resend, GLS m.fl. (GDPR)
  - Henvisning til klagemuligheder (fx Forbrugerklagenævnet) i handelsbetingelserne
  - Tilgængelighedsloven (European Accessibility Act): tjek om BidHamr som lille virksomhed er undtaget
- [x] **EU's Digital Services Act (DSA)**: markedspladser skal have en måde at anmelde ulovligt indhold, give brugeren en begrundelse, når en auktion fjernes, og udgive en årlig gennemsigtighedsrapport (Tradera og Vinted gør det begge). Afklar omfanget med advokat – det meste bygger videre på det eksisterende rapport-system
- [x] **Hastighedsgennemgang**: Lighthouse på forside, auktionsside, søgning, opret auktion og mine handler. Mål: Performance-score 90+ og LCP under 2,5 sek. på mobil. Ret de største syndere (billeder, databaseforespørgsler, JavaScript)
- [x] Fejlovervågning (fx Sentry) og besked til Filip, hvis siden går ned
- [~] Backup af databasen er slået til og testet
- [ ] **Beta-test med 10-20 rigtige, fremmede personer**, der køber og sælger med testpenge. Ret det, de støder på
- [~] Endelig sikkerhedsgennemgang og test af hele flowet (sikkerhed-agenten kører en fuld gennemgang) *(første fulde gennemgang og rettelser 7. okt. 2026 – gentages lige før lancering)*
- [ ] **Ekstern pentest**: et professionelt sikkerhedsfirma tester siden, før der skiftes til rigtige penge
- [ ] Erstat coming-soon-siden med den rigtige forside
- [ ] Logo finpudset af designer, favicon og app store-billeder
- [ ] **Lancering**

---

## Senere – efter lancering
Fundet i gennemgang af Tradera, Vinted og Etsy. Gode, men ikke nødvendige for at lancere.
- [ ] **Feriemodus**: sælger kan sætte sin profil på pause, så nye auktioner ikke kan oprettes, og købere kan se, at sælger er væk *(flyttet hertil af Filip 6. okt. 2026 – rart at have, ikke nødvendigt til lancering)*
- [~] **Autobud (maksimalbud)**: køber angiver sit maksimum, og BidHamr byder automatisk op til det (som Tradera). Maksimum kan sænkes, men ikke under nuværende bud *(flyttet fra fase 1 af Filip, 3. oktober 2026)*
- [ ] Efter første bud kan sælger ikke redigere, kun tilføje et synligt **tillæg** til beskrivelsen *(flyttet fra fase 1 af Filip, 3. oktober 2026)*
- [ ] Sælger kan give køber en **delvis refusion/rabat** i handlen, hvis de bliver enige (fx ved en lille skade) *(flyttet fra fase 1 af Filip, 3. oktober 2026)*
- Samlet fragt, når man vinder flere auktioner fra samme sælger
- Ægthedstjek af dyre mærkevarer (som Vinteds "Artikelbekræftelse")
- Brugerforum/fællesskab
- "Topsælger"-mærke til sælgere med mange gode handler
- Velgørenhedsauktioner (dele af beløbet går til en organisation)
- Automatisk deling af auktioner på Facebook/Instagram
- Automatisk risikoscoring, der fanger mistænkelige auktioner og beskeder
- "Køb nu" (se nedenfor)
- **Virksomheder som sælgere** (se åbne spørgsmål). Stripe-delen er klar, fordi Stripes onboarding allerede håndterer både private og virksomheder (CVR, ejere). Det, der mangler, er forretningsreglerne:
  - [ ] Filip: idéer til, hvordan virksomheder skal bruge platformen (fx genbrugsbutikker, dødsbo, overskudslager)
  - [ ] Filip: afklar med rådgiver, hvad der gælder, når en virksomhed sælger til en privatperson: købeloven, forbrugeraftaleloven (14 dages fortrydelsesret ved fjernsalg), reklamationsret, moms på salget og priser vist inkl. moms
  - [ ] Bygges ud fra rådgiverens svar: markering af erhvervssælgere på auktionen, deres egne vilkår og fortrydelsesret, moms på varen og evt. andre gebyrer

## Åbne spørgsmål
- BidHamr Beskyttelse: bedre prismodel end fast 5%
- Virksomheder som sælgere: hvilke typer virksomheder, samme gebyrer som private, og hvordan fortrydelsesret og moms håndteres
- "Køb nu": IKKE med ved lancering – BidHamr er en ren auktionsside. Kan tages op igen senere.
