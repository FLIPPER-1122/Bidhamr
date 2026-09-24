# BidHamr – Roadmap mod lancering

**Mål: hjemmeside og app er teknisk færdige inden udgangen af 2026.** Hele 2027 går til marketing og møder. Lancering juni 2027.
Faserne tages i rækkefølge. Fase 6 afhænger af CVR-nummer og advokat og kan først lukkes, når de er på plads.

Bygget ud fra `ROADMAP-BESLUTNINGER.md`. Agenterne tager altid det øverste åbne punkt i den aktive fase.
Afkryds med `[x]`, når Filip har godkendt og pushet. Intet må pushes af agenter.

Status: `[ ]` ikke startet · `[~]` i gang · `[x]` færdig

---

## Fase 0 – Fundament
Formål: rydde op, så agent-teamet kan arbejde sikkert og ens.

- [ ] Erstat den ødelagte `CLAUDE.md` i hamr (indeholder PDF-data) med en ren markdown-fil
- [ ] Skriv `PRODUKT.md` (produktretning: Tradera for auktionen, Vinted for handlen, egne regler)
- [ ] Skriv `DESIGN.md` (designsystem ud fra mockup D: farver, skrifttyper, knapper, kort, afstande)
- [ ] Sæt agent-team op i `.claude/agents/` (backend, frontend, reviewer, tester) + chef-rolle i CLAUDE.md
- [ ] Agenterne arbejder på egne git-branches – Filip merger og pusher
- [ ] Ret fejl: bedømmelser kan i dag gives af alle til alle (kun køber → sælger efter handel)
- [ ] Ret gebyr i koden: sælgergebyr fra 10% til 5% (`wallet_udbetal_saelger`, `admin_frigiv_handel`)
- [ ] **Filip – afklar TIDLIGT med rådgiver/advokat (kan ændre hvordan pengeflowet bygges):**
  - BESLUTTET: **Stripe holder pengene (Stripe Connect), ikke BidHamr. Ingen købersaldo – køber betaler med gemt kort, når han vinder.** Stripe har bekræftet det overordnede (se chat-udskrift på mail). Afventer svar fra Stripes team på den præcise opsætning. Tag derefter svaret med til rådgiveren, så han kan bekræfte, at BidHamr ikke selv skal have tilladelse
  - BESLUTTET: Det hedder **"BidHamr Beskyttelse"** – aldrig "forsikring" nogen steder på siden, i mails eller i koden
  - **Hvidvaskloven**: gælder den for BidHamr, når I håndterer betalinger (kundekendskab ved store beløb)?

## Fase 1 – Handelsflowet færdigt og sikkert
Formål: alt efter auktionen virker hele vejen, med testpenge. Sikkerheden i top.

- [ ] **Ny betalingsmodel: betal når du vinder – ingen saldo** (stort punkt – tages først i fasen). Stripe har bekræftet, at en købersaldo ikke passer til Stripe Connect og kan kræve e-penge-tilladelse. Derfor:
  - Den nuværende wallet med indbetaling før bud, låsning af beløb og wallet-tabel **fjernes**
  - Køber **gemmer et betalingskort** hos Stripe ved oprettelse af profil (intet trækkes). Man kan ikke byde uden gemt kort
  - Når auktionen slutter, **trækkes vinderens kort automatisk** (bud + købergebyr + fragt + evt. BidHamr Beskyttelse)
  - Pengene ligger på BidHamrs Stripe-konto (manuelle udbetalinger), indtil køber bekræfter / 48 timer uden sag / sag er afgjort
  - Sælger oprettes som **Stripe Connect-konto** (Express), og Stripe tjekker sælgerens identitet. Pengene overføres minus sælgergebyr, og Stripe udbetaler til sælgerens bank
  - Opsætning: destination charges eller separate charges and transfers – afventer endelig anbefaling fra Stripes team
- [ ] **Testmiljøet flyttes til Stripe**: al test af penge sker i **Stripes testmiljø** (test mode), ikke med testsaldoer i BidHamrs egen database
  - Opret Stripe-testnøgler (`sk_test_` / `pk_test_`) på Filips Stripe-konto og læg dem i Vercel + `.env.local` i stedet for de gamle nøgler
  - Test med Stripes testkort (fx 4242 4242 4242 4242) og testkort, der bliver afvist eller kræver 3D Secure
  - Opret falske sælgerkonti i Stripe Connect test mode til at teste udbetalinger
  - **Fjern** admin-værktøjerne "Sæt saldo" og "Justér saldo" og siden med wallet-transaktioner – de hører til den gamle model
  - **Fjern** wallet-tabellerne og wallet-funktionerne i databasen (`wallets`, `wallet_entries`, `bid_reservations`, `wallet_*`-funktionerne) med en migration, når det nye flow virker
- [ ] **Hvis betalingen fejler** (spærret kort, ingen dækning, banken kræver godkendelse med MitID/3D Secure): køber får besked og **24 timer** til at betale. Betaler han ikke, annulleres handlen, køber får en advarsel (tæller med i 3-advarsler-reglen), og sælger kan tilbyde varen til næsthøjeste byder eller sætte den op igen
- [ ] Gennemgang af hele pengestrømmen (reviewer): køb, gebyrer, frigivelse, refusion, ingen huller
- [ ] Gebyrer: 5% køber + 5% sælger, altid
- [ ] **BidHamr Beskyttelse**: 3% tilkøb for køber (min 20 / maks 250 kr), vælges ved køb
- [ ] Sag inden for 48 timer efter afhentning – pengene fryses og sagen vises på Sager-siden
- [ ] Uden BidHamr Beskyttelse: ingen retur via BidHamr. Med beskyttelse: BidHamr håndterer sagen
- [ ] Bedømmelse: køber skal give sælger 1-5 stjerner, før godkendelse går igennem
- [ ] Afhentning hos sælger: køber giver stjerner og viser koden → pengene frigives med det samme
- [ ] Krævede pakkebilleder i "Send pakke" (kamera direkte, ikke kamerarulle): varen indpakket i åben kasse + lukket kasse med label
- [ ] Sag kræver billeder fra køber (pakke, label, indhold) inden for 48 timer
- [ ] Svindel-undtagelse: åbenlys svindel giver altid en sag, med eller uden beskyttelse
- [ ] Permanent lukning af konti ved svindel (køber eller sælger)
- [ ] Advarselssystem: dårlig indpakning giver påmindelse første gang, derefter en advarsel pr. gang. 3 advarsler = permanent lukning (byg videre på den eksisterende advarsel-funktion i admin)
- [ ] Mails ved alle trin i handlen
- [ ] **Udbetaling til sælgers bankkonto** via Stripe Connect (testmiljø – ingen rigtige penge endnu)
- [ ] **DAC7**: brug Stripes "Platform Tax Reporting" til at indsamle og indberette sælgeroplysninger
- [ ] Kvittering til køber og sælger efter handel med opdeling af pris, gebyr, BidHamr Beskyttelse og fragt
- [ ] Sælger kan redigere eller annullere sin auktion, så længe der ikke er bud
- [ ] **Startpris = mindstepris**: sælger sætter én synlig startpris, som alle kan se. Første bud skal mindst være startprisen. Ingen skjult mindstepris
- [ ] Ved oprettelse vises en tydelig anbefaling: "Sæt startprisen lidt under det, du regner med at få – er den for høj, byder ingen"
- [ ] Oprydning: behandlede rapporter slettes efter 48 timer (cron)
- [ ] Oprydning: afsluttede auktioner **skjules/arkiveres** 48 timer efter afsluttet handel – de må IKKE slettes, fordi kvitteringer, bedømmelser, DAC7 og bogføringsloven kræver, at handelsdata gemmes i 5 år
- [ ] **Afsendelsesfrist**: sælger skal sende inden 5 dage. Sendes der ikke, annulleres handlen, og køber refunderes fuldt (som Vinted/Tradera)
- [ ] **Bindende bud**: bud kan ikke trækkes tilbage – vises tydeligt, før man byder
- [ ] **Autobud (maksimalbud)**: køber angiver sit maksimum, og BidHamr byder automatisk op til det (som Tradera). Maksimum kan sænkes, men ikke under nuværende bud
- [ ] Minimum budstigning (fx +10 kr / +5%) og valg af auktionsvarighed ved oprettelse
- [ ] Efter første bud kan sælger ikke redigere, kun tilføje et synligt **tillæg** til beskrivelsen
- [ ] Sælger kan give køber en **delvis refusion/rabat** i handlen, hvis de bliver enige (fx ved en lille skade)
- [ ] **Anke**: den, der taber en sag, kan anke. **Anke-knappen åbner først 24 timer efter afgørelsen** (afkølingsperiode), og derefter er der **3 dage** til at anke. Kræver begrundelse og gerne ny dokumentation. Behandles af en anden medarbejder end den, der afgjorde sagen (admin/chef). Afgørelsen på anken er endelig. Pengene er frosset, til ankefristen er udløbet (i alt 4 dage efter afgørelsen). Gælder kun handler med en sag

## Fase 2 – Fragt og automatisk frigivelse
Formål: sporing kører af sig selv, og sælgerne får deres penge uden manuel indgriben.

- [ ] Byg og test fragt mod **GLS' testmiljø** (kræver ikke firmaaftale) – skal være færdigt inden nytår
- [ ] Filip: møde med Shipmondo om den bedste løsning
- [ ] Filip: spørg GLS/Shipmondo, om fragtfirmaet selv **vejer pakken**, og om den målte vægt kan hentes via API (bruges som bevis i svindelsager)
- [ ] Byg koden, så fragtfirmaet kan skiftes (GLS nu, evt. Shipmondo senere) uden at omskrive handelsflowet
- [ ] Sælger får fragtlabel/QR-kode direkte i BidHamr
- [ ] Køber betaler fragt og ser prisen, før han byder
- [ ] Sporing hentes automatisk – status "afhentet" registreres
- [ ] Auto-frigivelse 48 timer efter afhentning, hvis ingen sag
- [ ] Sælger kan annullere/ændre en fragtbooking, så længe pakken ikke er afleveret
- [ ] Fragtberegner: sælger vælger pakkestørrelse (Lille/Mellem/Stor) ved oprettelse, prisen hentes fra GLS og vises på auktionssiden. Findes også som selvstændig side
- [ ] Vælger sælger en for lille pakkestørrelse, og fragtfirmaet opkræver ekstra, betaler sælgeren forskellen
- [ ] Ikke-afhentet pakke (GLS returnerer efter 7 dage): sælger beholder varen og får fragten dækket, køber refunderes minus gebyrer og fragt begge veje. Afhentning udløser aldrig udbetaling – kun købers bekræftelse (eller 48 timer uden sag) gør

## Fase 3 – Nyt design og forside
Formål: siden bliver troværdig, professionel, tryg og moderne.

- [ ] Nyt logo (nr. 8) og app-ikon (7B) ind på web og i appen
- [ ] Skift fra rød til den grønne/orange stil fra mockup D på hele siden
- [ ] Ny forside: delt hero med søgefelt, tryghedsstribe, kategorier med ikoner, "Slutter snart"-kort
- [ ] Ny menu/topbar med bedre struktur
- [ ] Gennemgå alle øvrige sider, så de følger `DESIGN.md`
- [ ] Hele hjemmesiden mobilvenlig
- [ ] "Sådan virker det"-side og hjælp/FAQ (købersikring, gebyrer, fragt, sager)
- [ ] Søgning og filtre: pris, kategori, slutter snart, afstand
- [ ] Forbudte varer: liste + kontrol ved oprettelse af auktion
- [ ] Blokering af brugere – inkl. at sælger kan spærre bestemte brugere fra at byde på sine auktioner
- [ ] Rapportér en besked/bruger i chatten + automatisk spamfilter i beskeder
- [ ] SEO (titler, beskrivelser, sitemap) og besøgsstatistik (cookie-venlig)
- [ ] Footer og faste sider: Om BidHamr, Kontakt/kundeservice, Handelsbetingelser, Privatlivspolitik, Cookies
- [ ] Kontaktformular til kundeservice, som lander i admin
- [ ] Pæne fejlsider (404/500) og loading-tilstande overalt
- [ ] **Spørg sælger**: købere kan stille spørgsmål til sælgeren, mens auktionen kører. **Sælger vælger selv ved oprettelse, om det er slået til eller fra** (kan ændres undervejs). Er det slået fra, vises "Sælgeren modtager ikke spørgsmål – læs beskrivelsen grundigt"
- [ ] Tilgængelighedserklæring i footeren + "Rapportér en fejl"-knap
- [ ] **Stand på varen** som faste valg ved oprettelse (Ny med mærke / Som ny / God / Brugt / Defekt) – gør "ikke som beskrevet"-sager lettere at afgøre
- [ ] Billeder: op til 10 pr. auktion, understøt iPhone-formatet HEIC, automatisk komprimering
- [ ] Pakkeguide i FAQ: "Sådan pakker du din vare" (hænger sammen med reglen om, at sælger har ansvaret for indpakning)
- [ ] "MitID-verificeret"-mærke på alle profiler
- [ ] Sælgerens adresse og telefonnummer vises aldrig offentligt – kun det nødvendige deles med køberen efter handlen
- [ ] Opret auktion: gennemgå hele flowet, så det er hurtigt og nemt (billeder, kategorier, fragtvalg, forhåndsvisning)

## Fase 4 – Brugerens egne ting
Formål: brugerne har overblik og styr på deres beskeder.

- [ ] Live statistikker under profil: antal auktioner, indtjening (uge/måned/år/lifetime), auktioner man har budt på
- [ ] Følg sælgere
- [ ] **Gemte søgninger med besked**: få besked, når der kommer nye auktioner, der matcher en søgning (fx "Omega ur")
- [ ] Notifikationer: overbudt, ny auktion fra fulgt sælger, bud på egen auktion, vundet, pakke kommet frem
- [ ] Side med notifikationsindstillinger (mail / app / begge / fra, pr. type)
- [ ] Notifikations-indbakke på siden (klokke i topbaren)
- [ ] Bekræftelse af e-mail ved oprettelse
- [ ] GDPR: brugeren kan slette sin konto og downloade sine data
- [ ] Kontosikkerhed: mail ved login fra ny enhed, mulighed for to-trins-login, krav til stærk adgangskode
- [ ] **Feriemodus**: sælger kan sætte sin profil på pause, så nye auktioner ikke kan oprettes, og købere kan se, at sælger er væk
- [ ] Sælger kan skrive ét offentligt svar på en bedømmelse. BidHamr kan fjerne bedømmelser, der bryder reglerne (fx grove ord)

## Fase 5 – Appen
Formål: appen og hjemmesiden er ens 1:1. **Appen er det primære produkt** – de fleste brugere skal bruge appen frem for hjemmesiden.

**Appen kodes af Filip selv på MacBook'en (ingen app-agent).** Når den er færdig, flyttes koden til den stationære computer, og agent-teamet hjælper med at få app og hjemmeside til at matche.

- [ ] Filip: flyt den færdige app-kode fra MacBook til den stationære (via GitHub)
- [ ] Sammenlign app og hjemmeside skærm for skærm – lav en liste over forskelle
- [ ] Ret forskellene, så funktioner, tekster og design er ens (DESIGN.md gælder også appen)
- [ ] Appen bruger samme Supabase-database og samme Stripe-betalingsflow som hjemmesiden (gemt kort, ingen saldo)
- [ ] Push-notifikationer
- [ ] Statistikker i appen
- [ ] Nyt design og app-ikon (7B)

## Fase 6 – Klar til lancering
Formål: alt det juridiske og praktiske er på plads.

- [ ] CVR-nummer
- [ ] MitID-verificering ved oprettelse (Criipto) – virker ikke i dag
- [ ] Cookie-banner
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
- [ ] **EU's Digital Services Act (DSA)**: markedspladser skal have en måde at anmelde ulovligt indhold, give brugeren en begrundelse, når en auktion fjernes, og udgive en årlig gennemsigtighedsrapport (Tradera og Vinted gør det begge). Afklar omfanget med advokat – det meste bygger videre på det eksisterende rapport-system
- [ ] Fejlovervågning (fx Sentry) og besked til Filip, hvis siden går ned
- [ ] Backup af databasen er slået til og testet
- [ ] **Beta-test med 10-20 rigtige, fremmede personer**, der køber og sælger med testpenge. Ret det, de støder på
- [ ] Endelig sikkerhedsgennemgang og test af hele flowet
- [ ] Erstat coming-soon-siden med den rigtige forside
- [ ] Logo finpudset af designer, favicon og app store-billeder
- [ ] **Lancering**

---

## Senere – efter lancering
Fundet i gennemgang af Tradera, Vinted og Etsy. Gode, men ikke nødvendige for at lancere.
- Samlet fragt, når man vinder flere auktioner fra samme sælger
- Ægthedstjek af dyre mærkevarer (som Vinteds "Artikelbekræftelse")
- Brugerforum/fællesskab
- "Topsælger"-mærke til sælgere med mange gode handler
- Velgørenhedsauktioner (dele af beløbet går til en organisation)
- Automatisk deling af auktioner på Facebook/Instagram
- Automatisk risikoscoring, der fanger mistænkelige auktioner og beskeder
- "Køb nu" (se nedenfor)

## Åbne spørgsmål
- BidHamr Beskyttelse: bedre prismodel end fast 3%
- "Køb nu": IKKE med ved lancering – BidHamr er en ren auktionsside. Kan tages op igen senere.
