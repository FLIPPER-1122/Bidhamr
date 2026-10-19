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
  - BESLUTTET: **Stripe holder pengene (Stripe Connect), ikke BidHamr. Ingen købersaldo – vinderen betaler selv inden for 48 timer (sælger kan forlænge til højst 7 dage), og gemt kort er et tilvalg, der kun forudfylder checkout (ingen automatisk betaling, Filip 9. okt. 2026).** Stripe har bekræftet det overordnede (se chat-udskrift på mail). Opsætningen er besluttet: separate charges and transfers. Tag Stripes svar med til rådgiveren, så han kan bekræfte, at BidHamr ikke selv skal have tilladelse
  - BESLUTTET: Det hedder **"BidHamr Beskyttelse"** – aldrig "forsikring" nogen steder på siden, i mails eller i koden
  - **Hvidvaskloven**: gælder den for BidHamr, når I håndterer betalinger (kundekendskab ved store beløb)?

## Fase 1 – Handelsflowet færdigt og sikkert
Formål: alt efter auktionen virker hele vejen, med testpenge. Sikkerheden i top.

- [x] **Ny betalingsmodel: betal når du vinder – ingen saldo** (stort punkt – tages først i fasen). Stripe har bekræftet, at en købersaldo ikke passer til Stripe Connect og kan kræve e-penge-tilladelse. Derfor:
  - Den nuværende wallet med indbetaling før bud, låsning af beløb og wallet-tabel **fjernes**
  - Når auktionen slutter, har vinderen **48 timer til selv at betale** (sælger kan forlænge til højst 7 dage) (bud + købergebyr + fragt + evt. BidHamr Beskyttelse) med kort, **MobilePay**, Apple Pay eller Google Pay. Påmindelser 24 og 8 timer før fristen
  - ~~**Valgfrit: automatisk betaling.**~~ **Fjernet (Filip, 9. okt. 2026):** ingen automatisk betaling – alle vindere betaler selv på checkout-siden. Man kan gemme et kort under Min konto, men kun til at forudfylde checkout
  - Pengene ligger på BidHamrs Stripe-konto (manuelle udbetalinger), indtil køber bekræfter / 48 timer uden sag / sag er afgjort
  - Sælger oprettes som **Stripe Connect-konto** (Express), og Stripe tjekker sælgerens identitet. Pengene overføres minus sælgergebyr, og Stripe udbetaler til sælgerens bank
  - Opsætning: **ÆNDRET 8. okt. 2026 – destination charges** (docs/BETALINGSMODEL-PLAN.md, trin 1–5 bygget 8.–9. okt.): køber betaler på sælgerens vegne, pengene står på sælgerens Connect-konto med manuel udbetaling, og BidHamr udbetaler til sælgerens bank, når handlen er helt færdig. Den gamle model ("separate charges and transfers") er fjernet
- [x] **Testmiljøet flyttes til Stripe**: al test af penge sker i **Stripes testmiljø** (test mode), ikke med testsaldoer i BidHamrs egen database
  - Opret Stripe-testnøgler (`sk_test_` / `pk_test_`) på Filips Stripe-konto og læg dem i Vercel + `.env.local` i stedet for de gamle nøgler
  - Test med Stripes testkort (fx 4242 4242 4242 4242) og testkort, der bliver afvist eller kræver 3D Secure
  - Opret falske sælgerkonti i Stripe Connect test mode til at teste udbetalinger
  - **Fjern** admin-værktøjerne "Sæt saldo" og "Justér saldo" og siden med wallet-transaktioner – de hører til den gamle model
  - **Fjern** wallet-tabellerne og wallet-funktionerne i databasen (`wallets`, `wallet_entries`, `bid_reservations`, `wallet_*`-funktionerne) med en migration, når det nye flow virker
- [x] **Hvis vinderen ikke betaler inden 48 timer** (eller den automatiske betaling fejler og han ikke betaler selv inden for fristen): handlen annulleres, køber får en advarsel (tæller med i 3-advarsler-reglen), og sælger kan tilbyde varen til næsthøjeste byder eller sætte den op igen
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
- [~] **DAC7**: brug Stripes "Platform Tax Reporting" til at indsamle og indberette sælgeroplysninger *(bygget 9. okt. 2026 – Stripes produkt er i lukket beta og laver ikke Danmarks CSV, så BidHamr beregner og laver selv Skattestyrelsens fil; CPR krypteret. `20261014010000_dac7.sql`, docs/DAC7.md; mangler nøgle i Vercel, migration i produktion og revisor/advokat nr. 111–113)*
- [x] Kvittering til køber og sælger efter handel med opdeling af pris, gebyr, BidHamr Beskyttelse og fragt (kvittering/handelsbekræftelse for selve varen – IKKE en faktura, fordi varen sælges mellem private)
- [ ] Filip: spørg revisor, om **Dinero** er et godkendt digitalt bogføringssystem, og vælg regnskabsprogram (Dinero, Billy eller e-conomic)
- [~] **Automatiske fakturaer på BidHamrs egne gebyrer** med moms: køber får faktura på købergebyr + evt. BidHamr Beskyttelse, sælger får faktura på sælgergebyr. Oprettes automatisk i det valgte regnskabsprogram via API, så alle fakturaer ligger samlet ét sted. Fakturaerne vises også under brugerens profil. **Venter på Filips valg af regnskabsprogram** – byg kvitteringen først *(bygget 9. okt. 2026 i Dinero-sandbox – `20261012080000_fakturaer.sql`, docs/FAKTURA.md; mangler Dinero-live + revisor)*
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

- [~] Byg og test fragt mod **Shipmondos testmiljø** (Filip 8. okt. 2026: i stedet for GLS direkte – Filip får adgang ca. 9. okt.) – skal være færdigt inden nytår *(bygget 9. okt. 2026 – erstattes af DAO direkte)*
- [ ] Filip: møde med Shipmondo om den bedste løsning
- [ ] Filip: skaf API-adgang (kunde-id + kode) og testmiljø hos DAO – vi integrerer **direkte med DAO** i stedet for Shipmondo (sparer Shipmondo Pro 200 kr./md., labelgebyr og integrationsgebyr; DAO's API har booking, labelfri kode, pakkeshops, sporing, annullering og retur). Shipmondo-adapteren bliver liggende til evt. flere fragtfirmaer senere *(Filip 9. okt. 2026)*
- [~] DAO-adapter (`src/lib/fragt/dao.ts`) mod DAO's testmiljø, sporing via cron – når Filip har API-adgang *(bygget 13. okt. 2026 mod egne eksempelsvar: Shop2Shop/Shop2Home, labelfri kode, PDF, pakkeshops, annullering, token-feed i cron; mangler nøgler og DAO's hændelseskoder – se docs/DAO-API.md)*
- [~] Ingen leveringsmelding fra DAO 14 dage efter afsendelse: ingen automatisk frigivelse – opret efterlysning/sag hos DAO (via API, hvis muligt) og en opgave til staff; pengene holdes tilbage, til sagen er afgjort (Filip, 11. okt. 2026) *(bygget 13. okt. 2026: én efterlysning pr. forsendelse via createclaim.php bag FRAGT_EFTERLYSNING_AKTIV, ellers manuel; markering til staff under Fragt; mangler nøgler)*
- [ ] Filip: spørg GLS/Shipmondo, om fragtfirmaet selv **vejer pakken**, og om den målte vægt kan hentes via API (bruges som bevis i svindelsager)
- [ ] Filip: spørg GLS/Shipmondo om **reklamation ved transportskade**: kan BidHamr reklamere på sælgers vegne (fragten er på BidHamrs aftale), hvad er maks. erstatning pr. pakke, er elektronik/glas undtaget, og findes der tillægsforsikring?
- [ ] **Reklamation hos fragtfirma**: når en sag om transportskade afgøres til købers fordel, og sælger har pakket ordentligt, opretter staff (eller systemet via fragtfirmaets API) en reklamation med pakkebilleder, købers skadebilleder og sporingsdata. Status vises på sagen for sælger. Erstatning fra fragtfirmaet udbetales til sælger. Afvises den, lukkes reklamationen, og sælger får besked (se ROADMAP-BESLUTNINGER.md afsnit 4)
- [~] Når GLS melder pakken leveret: notifikation "Pakken er kommet frem" til **køberen** (type pakke_leveret, påkrævet) – sælgeren får fortsat besked, når køberen bekræfter *(bygget 13. okt. 2026 for DAO via sporingsfeedet; mangler nøgler og DAO's "leveret"-kode i daoKoder.ts)*
- [x] Byg koden, så fragtfirmaet kan skiftes (GLS nu, evt. Shipmondo senere) uden at omskrive handelsflowet
- [~] Sælger får fragtlabel/QR-kode direkte i BidHamr *(bygget: labelfri kode + PDF)*
- [~] **Returlabel i sager**: når en sag afgøres med retur, får køberen et returlabel fra BidHamr via fragtfirmaet (køberen betaler returfragten). Sagsflowet med retur er bygget, men selve labelen mangler, indtil Filips aftale med fragtfirmaet er på plads – derfor er sagsretur kun delvist færdig *(bygget 13. okt. 2026 med DAO: labelfri Shop2Shop-returkode, køber → pakkeshop nær sælgeren; stadig slået fra (FRAGT_RETURLABEL_AKTIV), fordi opkrævningen af returfragten hos køberen mangler en beslutning; mangler nøgler)*
- [~] Køber betaler fragt og ser prisen, før han byder *(bygget: låst pris på auktionen + checkout)*
- [~] Sporing hentes automatisk – status "afhentet" registreres *(bygget 13. okt. 2026: DAO Track & Trace V2-feed i fragt-cron'en; ukendte koder ændrer ikke status; mangler nøgler og hændelseskoder)*
- [ ] Auto-frigivelse 48 timer efter afhentning, hvis ingen sag
- [~] Sælger kan annullere/ændre en fragtbooking, så længe pakken ikke er afleveret *(bygget; DAO via Shipmondo kan ikke annullere – højst 2 labels. DAO direkte (13. okt. 2026): en label, DAO har bekræftet annulleret, tæller ikke – loft 10; mangler nøgler)*
- [ ] Filip: aftal vægtgrænse med fragtfirmaet – alt over grænsen kan kun afhentes
- [~] Håndhæv vægtgrænsen ved opret auktion: over grænsen kan kun "afhentning" vælges *(bygget: BHT01–05)*
- [~] Fragtberegner: sælger vælger pakkestørrelse (Lille/Mellem/Stor) ved oprettelse, prisen hentes fra GLS og vises på auktionssiden. Findes også som selvstændig side *(bygget med faste priser 40/50/65 og 60/85 kr.)*
- [ ] Vælger sælger en for lille pakkestørrelse, og fragtfirmaet opkræver ekstra, betaler sælgeren forskellen
- [~] Ikke-afhentet pakke (GLS returnerer efter 7 dage): sælger beholder varen og får fragten dækket, køber refunderes minus gebyrer og fragt begge veje. Afhentning udløser aldrig udbetaling – kun købers bekræftelse (eller 48 timer uden sag) gør *(logikken bygget 10. okt. 2026; DAO's returhændelse koblet på 13. okt. 2026, men slået fra (DAO_RETUR_ER_IKKE_AFHENTET), til koden er set på en rigtig pakke; mangler nøgler)*

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
- [~] "MitID-verificeret"-mærke på alle profiler *(bygget 9. okt. 2026: profil, auktionsside (sælger), Min konto – se docs/MITID.md)*
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
- [x] Bekræftelse af e-mail ved oprettelse med en 6-cifret kode i mailen (ikke link, ikke SMS) *(bygget på hjemmesiden 7. okt. 2026 – "Confirm email" i Supabase slås først til, når appen håndterer koden (`verifyOtp` type `signup`), og en egen mailserver (SMTP, fx Resend) er sat op i Supabase)* *(Supabase sat op 7. okt. 2026: Resend-SMTP fra noreply@bidhamr.dk, kode-skabelon, Confirm email til. Oprettelse åbnes ved lancering)*
- [x] GDPR: brugeren kan slette sin konto og downloade sine data
- [x] Kontosikkerhed: mail ved login fra ny enhed, krav til stærk adgangskode, e-mail-kode ved oprettelse *(to-trins-login er udgået – fjernet 7. okt. 2026, Filip)*
- [x] Sælger kan skrive ét offentligt svar på en bedømmelse. BidHamr kan fjerne bedømmelser, der bryder reglerne (fx grove ord)

## Fase 5 – Appen
Formål: appen og hjemmesiden er ens 1:1. **Appen er det primære produkt** – de fleste brugere skal bruge appen frem for hjemmesiden.

**Appen er bygget forfra på pc'en i `Desktop/bidhamr-app` (Expo SDK 57, 15.–16. okt. 2026).** Agent-teamet hjælper med at få app og hjemmeside til at matche. Sådan prøver du appen på din telefon: docs/APP-TEST-PAA-TELEFON.md.

- [x] Filip: flyt den færdige app-kode fra MacBook til den stationære (via GitHub) *(udgået 13. okt. 2026 – appen er bygget forfra på pc'en)*
- [~] Sammenlign app og hjemmeside skærm for skærm – lav en liste over forskelle *(i gang 19. okt. 2026)*
- [~] Ret forskellene, så funktioner, tekster og design er ens (DESIGN.md gælder også appen) *(i gang 19. okt. 2026)*
- [ ] Filip: opret privat GitHub-repo til appen, kør `eas init`, og lav en development build (Android først; iOS når Apple Developer er på plads)
- [~] Appen bruger samme Supabase-database og samme Stripe-betalingsflow som hjemmesiden (vinderen betaler selv inden for 48 timer, valgfrit gemt kort, ingen saldo) *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] **Appen: opret konto via serveren** (docs/APP-SIGNUP.md). Appen må ikke kalde `supabase.auth.signUp` længere – databasen afviser det efter `20261018010000_signup_billet_altid.sql`, og "Allow new users to sign up" er altid slået fra i Supabase. Brug `POST /api/konto/opret` (`{ fornavn, efternavn, email, password, vilkaar_version }`, svarer altid `{ ok: true }` ved gyldigt input, samme kald igen = "Send ny kode") og `POST /api/konto/bekraeft` (`{ email, kode, password, fornavn, efternavn, vilkaar_version }`, svarer med en session – gem den med `setSession`). Adgangskode, navn og vilkår sendes igen ved bekræftelsen og sættes først efter `verifyOtp`. Vis "Vælg adgangskode" ved `adgangskode_sat: false`, bed om navnet igen ved `navn_sat: false`, og vis accept-vinduet ved `vilkaar_sat: false`. Danske fejlkoder står i docs/APP-SIGNUP.md. *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] Appen: ubekræftet e-mail håndteres (indtast koden fra mailen via `POST /api/konto/bekraeft`, ny kode via `POST /api/konto/opret` – se punktet ovenfor; ikke `verifyOtp`/`resend` direkte), og kontosletning direkte i appen (Apples krav 5.1.1(v)) via et sikkert endpoint (POST /api/konto/slet er bygget på hjemmesiden: Bearer-token, adgangskode + "SLET"). *(To-trins-login/AAL2 i appen er udgået – to-trins-login er fjernet 7. okt. 2026, og 20261007032000_mfa_database_haandhaevelse.sql er slettet.)* *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] Appen: følgere tælles med `antal_foelgere()` og kun insert/delete på `seller_follows` *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [ ] Filip: kør `20261007012000_seller_follows_stramning.sql` i produktion, når den nye app er udgivet og ikke længere bruger de gamle mønstre (i dag kan alle se, hvem der følger hvem)
- [~] Appen kender fase 4: `stand`, `idempotens_noegle` ved opret auktion (+ `min_auktion_for_noegle`), fejlkoden BHN02 (navn), `blokeret_grund = 'socialt_medie'`, `profil_offentlige_tal()`, svar på bedømmelser (`skriv_bedoemmelse_svar`, `bedoemmelse_svar`) og notifikationstypen `bedoemmelse`. *(Gemte søgninger er fjernet helt (Filip 10. okt. 2026, `20261016010000_fjern_gemte_soegninger.sql`): tabellen `gemte_soegninger` og notifikationstypen `gemt_soegning` findes ikke længere og skal ikke med i appen. Bruger appen dem allerede, skal det fjernes fra appen.)* *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [ ] Appen: tjek brugen af `auction_views`, `reports` og `messages` (update/delete/upsert), så den passer til `20261010060000_niels_m02_m03.sql` og `20261010061000_niels_m03_vinder_id_app_afhaengig.sql` *(Filip 8. okt. 2026: gøres, når app-koden er flyttet hertil)*
- [ ] Filip: kør `20261010060000_niels_m02_m03.sql` og derefter `20261010061000_niels_m03_vinder_id_app_afhaengig.sql` i produktion, når den nye app er udgivet og ikke længere bruger de gamle mønstre
- [~] Appen: brugerbetingelserne er et hårdt krav i databasen (`20261017030000_vilkaar_efternavn_chat.sql`): bud, maksimum, nye auktioner og "tilbud til næste byder" afvises med fejlkoden `BHV02` (`vilkaar_mangler: …`), hvis brugeren ikke har accepteret den aktuelle version. Appen skal vise accept-vinduet (som `src/components/vilkaar/VilkaarDialog.tsx`: læs `rpc("mine_vilkaar")`, accepter med `rpc("accepter_vilkaar", { p_version })`), sende `vilkaar_version` ved oprettelse og vise en dansk besked ved `BHV02`. Gælder også firmakonti. *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] Appen: efternavn er påkrævet ligesom fornavn (Filip, 11. okt. 2026) – både ved oprettelse og når navnet rettes på profilen. Feltet må ikke være tomt efter trim og højst 100 tegn; dansk fejlbesked "Skriv dit efternavn.". Send `fornavn`, `efternavn` og `navn` (= "fornavn efternavn") i signup-metadata, og opdatér alle tre, når navnet ændres. Hjemmesiden gør det samme (`SignupForm.tsx`, `opretKonto` i `actions/auth.ts`, `SettingsForm.tsx`). Databasen afviser allerede et tomt efternavn på private konti, når navnet ændres (`BHN03`, `efternavn_mangler: …`, `users_kraev_efternavn` i `20261017030000_vilkaar_efternavn_chat.sql`) – vis "Skriv dit efternavn." ved `BHN03`. *(Efter `20261018010000_signup_billet_altid.sql` oprettes nye konti bevidst uden navn – navnet sættes først efter koden – så `handle_new_user` kan ikke kræve efternavn ved oprettelsen. Kravet håndhæves, når navnet sættes: på serveren efter koden og af `users_kraev_efternavn`.)* *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] Appen: chatten kender `blokeret_grund = 'bank'` (reg.nr./kontonr./IBAN) og viser samme tekst som `spamForklaring` i `src/lib/tryghed.ts`; gerne samme advarsel ved betaling uden om BidHamr (`erMistaenkeligBesked`). *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] Appen må ikke bruge `select('*')` på `trades` (heller ikke indlejret `trades(*)`) – skriv altid en kolonneliste. Efter `20261017020000_sikkerhed_grants.sql` kan `authenticated` læse alle kolonner på `trades` undtagen `sag_note` og `sag_aabnet_af` (staffs interne felter), så `select('*')` fejler med "permission denied". Appen kan heller ikke skrive direkte i `trades` (det har den aldrig kunnet pga. RLS). *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] Appen: retur i sager - køberen betaler returfragten før returkoden (`POST /api/fragt/app/returfragt` → PaymentSheet, se docs/FRAGT.md). Status, pris, adresse og kode læses KUN via `supabase.rpc("min_returfragt", { p_trade })` - aldrig `select('*')` på `returfragt_betalinger` (authenticated har kun kolonne-grants på de viste felter, så `select('*')` fejler med "permission denied"). *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] Appen: kunst er forbudt (`20261023010000_kunst_forbudt.sql`). Appens nuværende insert i `auctions` virker uændret – databasen markerer selv kunst og sender auktionen til staff-tjek, uanset hvad appen sender. Appen skal vise samme advarsel som hjemmesiden (`src/components/opret/KunstAdvarsel.tsx`, tekster i `KUNST_TEKST` i `src/lib/kunstForbud.ts`), når titel eller beskrivelse ligner kunst: tjek med `supabase.rpc("kunst_tekst_tjek", { p_tekst: titel + " " + beskrivelse })` (svar `{ resultat: "ok" }` eller `{ resultat: "kunst", ord, nr }`), kræv afkrydsningen "Det er ikke kunst", og send `kunst_bekraeftet: true` i insert'en (kun ved træf). Ved ret auktion (`rediger_auktion`) vises advarslen kun, når teksten er ændret; bekræftelsen gemmes ikke. En auktion, der ligner kunst, afventer staff-tjek: andre kan ikke se den (RLS – den kommer ikke med i lister og søgning), og bud/maksimum afvises med errcode `BHK01` (`kunst_kontrol: …`) – vis `KUNST_TEKST.budAfvist`. Sælgeren ser sin egen auktion og skal vise "Afventer kontrol – BidHamr tjekker, at det ikke er kunst" (`KUNST_TEKST.afventerTitel`/`afventerSaelger`); status læses med `rpc("min_kunst_kontrol", { p_auktion })` (kun sælgerens egne auktioner; `null`, `'afventer'`, `'godkendt'` eller `'afvist'`). Kolonnerne `kunst_bekraeftet`, `kunst_markeret_kl`, `kunst_kontrol` og `kunst_tekst_md5` kan ikke læses af brugere – brug ikke `select('*')` på `auctions`. Ny anmeldelseskategori `kunst` ("Kunst") i `POST /api/dsa/anmeld`. *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] Appen: brugerbetingelser version **0.2** (15. okt. 2026, `20261023010000_kunst_forbudt.sql`). Den aktive version styres af databasen (`vilkaar_indstilling`) og skiftes fra 0.1 til 0.2, når Filip trykker "Slå brugerbetingelser 0.2 til" under Admin → Drift. Appen må derfor ALDRIG hardkode versionen: vis accept-vinduet, når `rpc("mine_vilkaar")` giver en `version` under `aktuel_version`, accepter med `rpc("accepter_vilkaar", { p_version: aktuel_version })`, og send ved oprettelse `vilkaar_version` = `rpc("vilkaar_aktuel_version")` (kan kaldes uden login) til `POST /api/konto/opret`/`bekraeft`. Vis den danske besked ved `BHV02`. Gælder også firmakonti. (Appen bygges af en anden agent i `Desktop/bidhamr-app` - dette er kravet til den.) *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] Appen: **"Populær sælger"** og **månedens lodtrækning** (`20261023020000_badge_konkurrence.sql`). Badget (mindst 50 gennemførte salg til mindst 20 forskellige købere, bud mindst 50 kr.) er offentligt og kun ja/nej: `supabase.rpc("populaer_saelger", { p_bruger })` → `true | false` på profilen og ved sælgeren på auktionssiden, og til auktionskort `supabase.rpc("populaere_saelgere", { p_brugere: [uuid, ...] })` → liste af de bruger-id'er, der har badget (højst 200 pr. kald; send `auctions.bruger_id`). Grænsen: `rpc("populaer_saelger_graense")` → `50`. Mærket ser ud som "MitID-verificeret": lys grøn flade, stjerne-ikon, teksten "Populær sælger" (`src/components/PopulaerSaelgerMaerke.tsx`). Min konto: `supabase.rpc("mine_konkurrence_lod")` → `{ maaned: "YYYY-MM", antal_lod, deltager, grund: null | "erhverv" | "staff" | "konto" }` (kun egne tal, kræver login). Samme tekster som hjemmesiden (`src/lib/tekster/konkurrence.ts`, `KONKURRENCE_KONTO`). Lodtrækningen og deltagerlisten findes kun i admin (chef) og skal ikke i appen. *(bygget 15.–16. okt. 2026 i den nye app – mangler test på telefon)*
- [~] Push-notifikationer *(bygget, men kræver `eas init` og en development build)*
- [ ] Statistikker i appen
- [ ] Nyt design og app-ikon (7B)

## Fase 6 – Klar til lancering
Formål: alt det juridiske og praktiske er på plads.
- [~] **Kunst er forbudt** (Filip, 14. okt. 2026): forbudt vare i brugerbetingelserne, ingen kunst-kategori, opret auktion fanger kunst-ord og sender til staff-tjek, anmeldelsesgrund "Kunst er ikke tilladt" – se ROADMAP-BESLUTNINGER *(bygget og i prod 15. okt. 2026 – mangler advokatens svar på spørgsmål 135–137)*

- [~] **Overskueligt og brugervenligt admin** (Filip, 12. okt. 2026): ny grupperet menu, ens opbygning af alle undersider (filtre, lister der bliver til kort på mobil, tydelige handlinger), plan i docs/ADMIN-REDESIGN.md – bygges efter sikkerhedsnettet *(bygget og i prod 13. okt. 2026: grupperet menu, kontrolpanel, søgning, hurtighandlinger, Tag sagen, sælgerens forside – `20261020010000_admin_hurtig.sql`)*
- [~] **Admin-kontrolpanel**: én forside i admin med penge (Stripe-saldo, sælgernes penge, hvad der kan trækkes ud, nødstop – Reserve bygges IKKE (Filip, 12. okt. 2026)), "kræver handling" (sager, indsigelser, godkendelser, hængende refusioner, beta-fejl, firmaklager), drift (alarmer, cron, afstemning) og dagens aktivitet, øverst en grøn/gul/rød statuslinje ("skal vi tage stilling til noget?") – bygges efter sikkerhedsnettet for pengene (Filip, 12. okt. 2026) *(bygget og i prod 13. okt. 2026 sammen med sikkerhedsnet A+B)*
- [ ] Medarbejder-loggen: filtrér på bruger-id i stedet for e-mail, så ingen e-mail havner i adresselinjen (`src/app/admin/medarbejder-log/page.tsx`, `?bruger=`) (Filip, 13. okt. 2026)
- [ ] **Admin på egen adresse**: flyt admin til `admin.bidhamr.dk` (separat Vercel-projekt fra samme kode), luk `/admin` på bidhamr.dk, og kræv 2-trins-login (app-kode/passkey) for alle staff-roller; evt. kun adgang fra egne IP'er – lige før lancering (Filip, 12. okt. 2026)
- [ ] CVR-nummer
- [~] MitID-verificering (Idura/Criipto) før første bud og første auktion *(bygget 9. okt. 2026 i testmiljøet – `20261013010000_mitid.sql`, docs/MITID.md. Testet på bidhamr.dk med test-MitID 10. okt. 2026 – virker, også "én MitID = én konto". Mangler: Idura-produktionsaftale + Vercel-variabler, appen)*
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
- [ ] **Sikker signup for alle, før tilmeldingen åbnes** (`TILMELDING_AABEN=true`): samme model som beta-testen. "Allow new users to sign up" forbliver slået fra i Supabase. Kontoen oprettes på serveren med en tilfældig adgangskode, og den valgte adgangskode sættes først, når e-mailen er bekræftet med koden. Appen skal oprette konti via et server-endpoint i stedet for at kalde `signUp` direkte. Hvorfor: ved direkte `signUp` kan en fremmed oprette kontoen først med offerets e-mail og sin egen adgangskode og overtage den, når offeret bekræfter (se docs/BETA-TEST.md, "Kendte begrænsninger") *(bygget 11. okt. 2026: én kodevej for åben og lukket tilmelding og for appen (`src/lib/kontoOprettelse.ts`, forskellen er kun invitationstjekket), appens endpoints `POST /api/konto/opret` og `/api/konto/bekraeft` (docs/APP-SIGNUP.md), og databasen kræver altid en billet med engangs-nonce fra serveren, så `signUp` med anon-nøglen afvises uanset dashboard-indstillingen; navn og vilkårsaccept sættes først efter koden, af den, der har den (`20261018010000_signup_billet_altid.sql`, ikke kørt endnu). Mangler: Filip kører migrationen (test, så produktion), slår "Allow new users to sign up" fra i Supabase (og lader den være slået fra), og appen skifter til endpointene (fase 5))*
- [ ] Erstat coming-soon-siden med den rigtige forside
- [ ] Logo finpudset af designer, favicon og app store-billeder
- [ ] **Lancering**

---

## Fase 7 – Erhvervskonti
Formål: firmaer med CVR kan sælge på BidHamr med abonnement – og det skal være MEGET nemt (primært ældre brugere). Regler: `ROADMAP-BESLUTNINGER.md`, "Erhvervskonti". Research: `ERHVERV-OVERBLIK.md`.

- [ ] Filip: fastsæt abonnementspakker og priser (månedspris og antal auktioner pr. uge)
- [ ] Filip: send erhvervsspørgsmålene til advokaten (`jura/noter-til-advokat.md` nr. 56 ff.)
- [~] Siden **Erhverv** (knap i menuen øverst): hvad man kan som erhverv, hvad BidHamr tilbyder – ingen priser – og knappen **Formular**
- [~] Erhvervsformularen: firmanavn, CVR, kontaktperson, telefon, e-mail, hvad de sælger m.m. Spamværn. Lander i admin
- [~] Ny staff-rolle **sælger**. Admin → Erhverv (kun chef og sælger): henvendelser (læs, noter, godkend/afvis), firmaer, opret firmakonto med pakke (velkomstmail med link til at vælge adgangskode). Pakker oprettes/ændres kun af chef
- [~] Firmakonti kan ikke oprettes af firmaet selv – håndhæves i databasen
- [~] Salg kræver aktivt abonnement; antal auktioner pr. uge efter pakke – håndhæves i databasen (også fra appen). Firmakonti kan ikke byde
- [~] Profilmenuen viser kun **Firma oversigt** for firmakonti
- [~] **Firma oversigt** (dashboard, sat op som admin – Filip 8. okt. 2026): eget layout (`src/app/(firma)/firma`) uden den almindelige header/footer – top med logo, firmanavn, "Se din butik" og "Log ud", menu i siden (mobil: én stor "Menu"-knap). Undersider: **Overblik** (nøgletal + "Venter på dig"), **Auktioner** (Aktive/Solgte/Usolgte/Annullerede; opret og redigér inde i dashboardet), **Salg** (status + handelssiden med "Send pakke", uden chat), **Statistik** (pr. måned og pr. auktion), **Udbetalinger**, **Abonnement** (alle pakker med priser), **Regninger**, **Firmaoplysninger**, **Hjælp og kontakt**. Firmaer sendes altid fra "min konto"-siderne (/mine-handler, /opret-auktion, /beskeder, /konto …) til dashboardet. Migration `20261010040000_firma_dashboard.sql` (firma_auktioner, firma_statistik, firma_salg)
- [~] **Ingen beskeder med erhvervssælgere**: ingen chat i handlen og ingen "Spørg sælger" på erhvervsauktioner – i UI og i databasen (BHE05). Køberen ser firmaets mail/telefon og et link til firmaprofilen på handelssiden
- [~] Mærke "Erhvervssælger" på auktioner og i søgning + offentlig firmaprofil med CVR, adresse, kontakt, vilkår og fortrydelsesret
- [~] Nye varer for erhverv: stand "Ny" + GPSR-felter (producent, sikkerhedsoplysninger)
- [~] Ingen BidHamr Beskyttelse ved køb fra erhverv
- [ ] Fortrydelsesret 14 dage: "Fortryd køb", returlabel, refusion via Stripe ved modtagelse, udbetaling til erhverv først efter fristen *(venter på Stripe/Niels og fragt)*
- [~] Abonnementsbetaling med **Stripe Billing** (testmiljø, Filip 8. okt. 2026 – Niels gennemgår): "Betal for din pakke" (Checkout, kort), opgradering med det samme med betaling af forskellen (faktura, 3DS via Stripes fakturaside), nedgradering fra næste periode (Subscription Schedule), opsigelse kun via admin (chef, ved periodens slut), mislykket betaling → pause efter 7 dage → genaktivering ved betaling, regninger med moms og PDF, "Skift betalingskort" (kundeportal). Priser ekskl. moms + fast Tax Rate 25 %. Migration `20261010050000_erhverv_stripe.sql`. Kode: `src/lib/erhverv/betaling.ts`, webhook `src/app/api/webhooks/stripe/route.ts`. Tjekliste til Niels: `STRIPE-ERHVERV-NOTE.md`. Valg af regnskabsprogram mangler stadig
- [~] **Faktura på varen ved firmasalg**: firmaet fakturerer selv (Filip, 9. okt. 2026). Firma oversigt → Salg viser pr. salg de oplysninger, firmaet skal bruge til fakturaen (købers navn, adresse, e-mail, vare, pris inkl. moms, dato), evt. med "Kopiér"/CSV-eksport, og erhvervsvilkårene siger, at firmaet selv fakturerer
- [ ] Reklamation: køber kan se virksomhedens kontaktoplysninger og klage; gentagne klager → advarsel/lukning
- [~] Brugerbetingelser og FAQ for erhverv (indhold + advokat) *(udkast 10. okt. 2026: jura/erhvervsvilkaar-udkast.md, brugerbetingelser afsnit 29, FAQ-gruppe; advokat nr. 114–121)*
- [ ] Appen: samme erhvervsfunktioner (Filip)

---

## Senere – efter lancering
Fundet i gennemgang af Tradera, Vinted og Etsy. Gode, men ikke nødvendige for at lancere.
- [ ] **Eget fragtfirma for erhverv**: BidHamr kan slå det til for det enkelte firma i admin. Firmaet skal angive et sporingsnummer fra et kendt fragtfirma, så leveringen kan følges; udbetaling først når sporingen viser leveret og fortrydelsesfristen er udløbet *(Filip, 8. okt. 2026 – kun hvis store firmaer efterspørger det)*
- [ ] **Feriemodus**: sælger kan sætte sin profil på pause, så nye auktioner ikke kan oprettes, og købere kan se, at sælger er væk *(flyttet hertil af Filip 6. okt. 2026 – rart at have, ikke nødvendigt til lancering)*
- [x] **Autobud (maksimalbud)**: køber angiver sit maksimum, og BidHamr byder automatisk op til det (som Tradera). Maksimum kan sænkes, men ikke under nuværende bud *(flyttet fra fase 1 af Filip, 3. oktober 2026)*
- [~] **Auktionen låses efter første bud**: sælger kan hverken redigere, tilføje noget eller slette/annullere auktionen – intet kan ændres *(flyttet fra fase 1 af Filip, 3. oktober 2026; ændret af Filip 7. okt. 2026: intet tillæg, helt låst)*
- [ ] Sælger kan give køber en **delvis refusion/rabat** i handlen, hvis de bliver enige (fx ved en lille skade) *(flyttet fra fase 1 af Filip, 3. oktober 2026)*
- Samlet fragt, når man vinder flere auktioner fra samme sælger
- Ægthedstjek af dyre mærkevarer (som Vinteds "Artikelbekræftelse")
- Brugerforum/fællesskab
- "Topsælger"-mærke til sælgere med mange gode handler
- Velgørenhedsauktioner (dele af beløbet går til en organisation)
- Automatisk deling af auktioner på Facebook/Instagram
- Automatisk risikoscoring, der fanger mistænkelige auktioner og beskeder
- "Køb nu" (se nedenfor)
- **Virksomheder som sælgere**: flyttet til *Fase 7 – Erhvervskonti* (Filip, 7. okt. 2026)

## Åbne spørgsmål
- BidHamr Beskyttelse: bedre prismodel end fast 5%
- Virksomheder som sælgere: besluttet 7. okt. 2026 – se Fase 7 og ROADMAP-BESLUTNINGER.md "Erhvervskonti"
- "Køb nu": IKKE med ved lancering – BidHamr er en ren auktionsside. Kan tages op igen senere.
