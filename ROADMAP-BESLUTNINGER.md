# BidHamr – Produktbeslutninger (kladde til roadmap)

> **VIGTIGT – gælder hele dokumentet:**
> - **Stripe holder brugernes penge (Stripe Connect), ikke BidHamr.**
> - **Der er INGEN købersaldo/wallet.** Køber gemmer et kort ved oprettelse, og kortet trækkes automatisk, når han vinder. Fejler betalingen, har han 24 timer. Hvor der står "wallet" nedenfor, er det forældet.
> - Ordet "forsikring"/"købsforsikring" bruges IKKE. Det hedder **"BidHamr Beskyttelse"** overalt (ikke "garanti" og ikke "forsikring").

Truffet sammen med Filip, 24. september 2026. Bruges som grundlag for ROADMAP.md og PRODUKT.md.

## 1. Frigivelse af penge
- Uret starter, når sporingen viser, at køberen har **hentet** pakken.
- Køberen har **48 timer** til at oprette en sag. Derefter frigives pengene automatisk til sælgeren.
- Oprettes en sag inden fristen: pengene **fryses**, og sagen vises automatisk på Sager-siden.
- ~~Henter køberen ikke pakken inden 7 dage: sælgeren får sine penge.~~ ERSTATTET af reglen nedenfor.
- **Ikke-afhentet pakke (model 3):** GLS sender automatisk pakken retur til sælgeren efter 7 kalenderdage i pakkeshoppen. Afhentning udløser IKKE udbetaling – den starter kun 48-timers uret. Pengene udbetales først, når køberen trykker "Bekræft, varen er som den skal være" (eller når 48 timer er gået uden sag). Ved retur: sælgeren beholder varen og får dækket sin fragt. Køberen refunderes købsbeløbet **minus gebyrer og fragt begge veje**. Køberen kan ikke oprette en sag.
- Man kan **ikke fortryde** et køb.
- Forudsætning: fragtintegration, så sporing læses automatisk.

## 2. Fragt
- Sælgeren får en **fragtlabel/QR-kode via BidHamr**, og sporingen kommer automatisk (fx Shipmondo).
- **Køberen betaler fragten** og ser prisen, før han byder.
- **Afhentning hos sælger** er en valgmulighed. Køberen viser en kode ved afhentning, og pengene frigives med det samme. Ingen klagefrist bagefter.

## 3. Gebyrer
- **5% for sælger og 5% for køber**, altid. Intet minimum eller maksimum.
- Koden skal rettes: sælgergebyret er i dag 10% (wallet_udbetal_saelger og admin_frigiv_handel).

## 4. Købsforsikring (tilkøb for køber)
- Frivilligt tilkøb på **3%** oveni købergebyret, **minimum 20 kr og maksimum 250 kr**.
- Dækker, hvis varen er **gået i stykker under forsendelsen**: køberen kan oprette en sag og sende varen retur.
- Uden forsikring: en vare, der går i stykker undervejs, kan ikke sendes retur.
- Prisen på 3% er midlertidig. Der skal laves et bedre prissystem senere.
- **Uden forsikring hjælper BidHamr ikke med retur**, heller ikke hvis varen ikke er som beskrevet. Så må køber og sælger selv løse det.
- **Med forsikring** går BidHamr ind og håndterer sagen for køberen.
- **Svindel-undtagelse:** Åbenlys svindel (tom pakke, helt anden vare, falsk kopi solgt som ægte, vare aldrig sendt) giver altid en sag, med eller uden forsikring. Pengene fryses.
- **Køber-svindel:** Køber skal uploade billeder af pakke, label og indhold inden for 48 timer for at oprette en sag. BidHamr vurderer ud fra beviser og historik. Står ord mod ord, og sporingen viser levering: sælger får pengene, og køber henvises til politiet.
- Svindlere (køber eller sælger) får kontoen lukket permanent. MitID forhindrer ny profil.
- **Pakkebilleder (krævet):** I "Send pakke"-trinnet tager sælgeren billeder med kameraet direkte i appen/på siden (ikke fra kamerarullen) af varen pakket ind i den åbne kasse og af den lukkede kasse med label. Formålet er at dokumentere **indpakningen** – billederne beviser ikke, at varen blev i kassen.
- **Sælgeren har altid ansvaret for at pakke varen forsvarligt** (fx bobleplast om en telefon).
- Skadet vare **uden forsikring**: køber og sælger må selv blive enige. BidHamr blander sig ikke.
- Skadet vare **med forsikring**: BidHamr løser sagen for køberen. Det er præcis det, forsikringen betales for. Pakkebillederne bruges til at vurdere, om sælgeren har pakket ordentligt.
- Ingen af parterne hæftes for ekstra penge.
- **Advarselssystem for dårlig indpakning:** 1. gang = påmindelse til sælgeren. 2. gang og derefter = en advarsel hver gang. **3 advarsler = profilen lukkes permanent.**
- ÅBENT: Kan GLS' målte vægt bruges som bevis? Spørges på møde med GLS/Shipmondo.
- NOTE: Tjek med advokat, om platformen alligevel har pligt til at gribe ind ved åbenlys svindel.
- ÅBENT: Hvad gør vi ved sælgere, der **bevidst lyver** i deres auktion (svindel)? Ikke besluttet endnu.

## 5. Notifikationer
Brugeren får besked når:
- De bliver **overbudt**
- En sælger, de **følger**, lægger en ny auktion op (NY FEATURE: følg sælgere)
- Nogen **byder på deres egen** auktion
- De har **vundet** en auktion
- **Pakken er kommet frem** efter et køb (mail)

- Eksisterende mails (vundet, pakke sendt, ny handel) **bliver**.
- Alle notifikationer kan fås **både på mail og i appen**.
- NY SIDE: **Notifikationsindstillinger**, hvor brugeren selv vælger for hver type, om den skal komme på mail, i appen, begge eller slet ikke.
- Standard: alle typerne ovenfor er slået til.

## 7. Lancering og jura
- **Mål for lancering: juni 2027.**
- Cookie-banner skal laves.
- **MitID virker ikke endnu** og skal på plads før lancering (verificering ved oprettelse af profil, via Criipto).
- Handelsbetingelser og privatlivspolitik skrives af **advokat/jurist**, når CVR-nummeret er på plads. Det er noget af det sidste før lancering.
- Claude laver et kort uddrag/oplæg af forretningsreglerne, som Filip kan tage med til rådgiver og advokat.

## 8. Design og forside
- Forsiden skal være bygget op om **ét stort billede** (hero), der fanger med det samme.
- Inspiration: **Vinted og Etsy**. Der laves en kort sammenligning af de to forsider, og det bedste fra hver bruges.
- Hele hjemmesiden skal have **mere struktur**. Den føles i dag rodet og ikke indbydende for nye sælgere.
- Målet: pæn, visuel og troværdig, så fremmede får lyst til at sælge deres ting.
- **Fire kerneord for designet: troværdigt, professionelt, trygt, moderne.**
- Referencer (screenshots fra Filip): Etsy, Vinted og Tradera. Forsiden skal være en blanding:
  - **Header (Vinted/Etsy):** logo, stor søgebar i midten, "Sælg nu"-knap i brandfarve, log ind. Kategorilinje under.
  - **Hero (Vinted + Tradera):** stort billede i fuld bredde med en hvid boks/overskrift ovenpå, fx "Sælg det, du ikke bruger – trygt" + "Sælg nu" + "Sådan virker det". Evt. søgefelt og populære søgninger som hos Tradera.
  - **Kategorier med ikoner (Tradera):** vandret række under hero.
  - **Store billedkort (Etsy):** "Udvalgte" og "Slutter snart" som flotte kort med store billeder.
  - **Tryghed synligt (eget):** en stribe om købersikring, MitID-verificerede brugere og at pengene holdes af BidHamr, til varen er godkendt.
- **VALGT RETNING: Mockup D** (blanding af B og C) i `mockups/forside-mockups.html`:
  - Delt hero: skovgrøn flade (#1E5E4A) til venstre med overskrift, stort søgefelt, populære søgninger og et link til sælgere. Billede til højre.
  - Knapper og accenter i varm orange (#E8772E). Lys grøn (#E8F2EE) bag tryghedsstribe og kategori-ikoner.
  - Overskrift i serif (Fraunces), resten i Inter.
  - Under hero: tryghedsstribe, kategorier med ikoner og store kort med "Slutter snart".
  - Dette bliver grundlaget for designsystemet, som alle sider og agenter skal følge.
- **VALGT LOGO:**
  - Hjemmeside: logo **nr. 8** – grøn firkant med orange/hvid auktionshammer + "BidHamr" i grøn, med et lille orange flueben over "r" lidt til højre. Fil: `public/brand/bidhamr-logo.svg`.
  - App-ikon: **7B** – grøn firkant med hammeren og det lille orange flueben oppe i højre hjørne inde i firkanten. Fil: `public/brand/bidhamr-app-ikon.svg`.
  - TODO: få en designer til at finpudse og konvertere teksten til kurver, så logoet ser ens ud overalt uanset skrifttype. Lav favicon og PNG-størrelser til app stores.
- Tidligere note (overhalet af valget ovenfor): **Brandfarven er IKKE fastlagt.** Den nuværende røde (#E63946) er måske for tæt på største danske konkurrent, som også er rød. Tre retninger afprøves i `mockups/forside-mockups.html`: nordisk blå, skovgrøn, blæk + orange.
- Brandfarven bruges sparsomt (knapper, highlights). Resten roligt: hvidt/lys baggrund, afrundede hjørner, meget luft.

## 9. Hele flowet efter auktionen (lanceringsklart)
- Alt fra auktionen slutter til handlen er afsluttet skal være **helt færdigt og lanceringsklart**.
- **Sikkerheden skal i top**: ingen huller i pengestrømmen, ingen handlinger en bruger kan lave på andres vegne. Gennemgås af reviewer-agent.
- Pengene skal flyde korrekt igennem hele vejen (køb, gebyrer, forsikring, frigivelse, refusion). **Vi kører stadig med testpenge.**
- Mails ved alle trin skal være på plads og hænge sammen med notifikationsindstillingerne (punkt 5).
- **Appen** skal have det samme flow som hjemmesiden, inkl. **statistikker** for brugeren.
- **Live statistikker under profilen** (web og app):
  - Antal auktioner oprettet gennem tiden
  - Indtjening for **uge, måned, år og lifetime**
  - Liste over auktioner man har **budt på**, med hurtigt link ind til dem

## 6. Bedømmelser
- Findes allerede på web (ratings-tabel, 1-5 stjerner + kommentar, submitRating.ts) og i appen.
- NYT FLOW: Når køberen godkender varen, skal han **først give sælgeren 1-5 stjerner**, før godkendelsen går igennem.
- **Kun køberen bedømmer sælgeren.** Sælgeren kan ikke bedømme køberen.
- Bedømmelse kan **kun** gives i forbindelse med godkendelse af en handel. Ingen andre steder eller tidspunkter.
- Frigives pengene automatisk (køber godkender aldrig), får sælgeren **ingen bedømmelse** for den handel.
- FEJL at rette: submitRating tjekker ikke, at man faktisk var køber i handlen. I dag kan enhver bedømme enhver. Skal låses, så kun køberen på en handel kan bedømme den handels sælger, én gang.
