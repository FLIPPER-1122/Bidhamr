# BidHamr – Produktbeslutninger (kladde til roadmap)

> **VIGTIGT – gælder hele dokumentet:**
> - **Stripe holder brugernes penge (Stripe Connect), ikke BidHamr.**
> - **Der er INGEN købersaldo/wallet.** Vinderen betaler selv inden for **24 timer** efter auktionen (kort, MobilePay, Apple Pay, Google Pay – og de øvrige metoder Stripe tilbyder, fx Klarna, Revolut Pay og Link; Filip 1. okt. 2026: må gerne være slået til). Som **tilvalg** kan brugeren gemme et kort og slå automatisk betaling til, så kortet trækkes med det samme, når han vinder. Betaler han ikke inden 24 timer: handlen annulleres, han får en advarsel, og sælger kan tilbyde varen til næsthøjeste byder eller sætte den op igen. Hvor der står "wallet" nedenfor, er det forældet.
> - **Stripe-opsætning: "separate charges and transfers"** med manuelle udbetalinger. Køber betaler til BidHamrs platformskonto; beløbet minus sælgergebyr overføres til sælgerens Stripe Connect Express-konto, når pengene frigives (bekræftelse, 48 timer uden sag, eller afgjort sag + ankefrist). Valgt fordi pengene ofte skal holdes i dage og kunne fryses ved sager.
> - **Faktura og kvittering:** BidHamr laver kun faktura på sine egne gebyrer (købergebyr, sælgergebyr, BidHamr Beskyttelse) – med moms. Selve varen sælges mellem private, så køber og sælger får en kvittering/handelsbekræftelse, ikke en faktura. Fakturaerne oprettes automatisk i et dansk regnskabsprogram (sandsynligvis Dinero – afventer revisor) og vises også på brugerens profil.
> - **Admin-dashboard:** Kun rollen **chef** må se pengetal og indtjeningsstatistik. Medarbejdere og admins ser alt andet. Forsiden fokuserer på brugere (antal i alt og nye brugere).
> - Tilkøbet for køberen hedder **"BidHamr Beskyttelse"** overalt.
> - **Formulering om betaling (Filip, 1. oktober 2026):** BidHamr er ikke en betalingsplatform og hæfter ikke økonomisk. Tekster må aldrig sige, at BidHamr modtager, opbevarer eller holder pengene. Skriv i stedet, at betalingen håndteres af vores betalingspartner **Stripe**.

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
- Rettet: sælgergebyret er nu 5% i koden.

## 4. BidHamr Beskyttelse (tilkøb for køber)
- Frivilligt tilkøb på **5%** oveni købergebyret, **minimum 25 kr og maksimum 250 kr** (Filip, 1. oktober 2026). Vælges af køber på auktionssiden, når han byder (ikke forvalgt). Er den valgt, indgår den i betalingen – også ved automatisk betaling. Valget låses ved buddet og kan ikke ændres bagefter.
- Dækker, hvis varen er **gået i stykker under forsendelsen**: køberen kan oprette en sag og sende varen retur.
- Uden BidHamr Beskyttelse: en vare, der går i stykker undervejs, kan ikke sendes retur.
- Prisen på 5% er midlertidig. Der skal laves et bedre prissystem senere.
- **Pakke kommer ikke frem** (bortkommet under forsendelse): BidHamr hjælper altid – med eller uden BidHamr Beskyttelse (Filip, 1. oktober 2026).
- **Visning (Filip, 1. oktober 2026):** Procentsatser for gebyr og BidHamr Beskyttelse vises IKKE ved budfeltet. Der vises beløb i kroner (fx "+ 25 kr") og den samlede pris. Afkrydsningen for BidHamr Beskyttelse har kun et "Læs mere"-link til en egen side, der forklarer, hvad BidHamr hjælper med uden og med BidHamr Beskyttelse.
- **Uden BidHamr Beskyttelse hjælper BidHamr ikke med retur**, heller ikke hvis varen ikke er som beskrevet. Så må køber og sælger selv løse det.
- **Med BidHamr Beskyttelse** går BidHamr ind og håndterer sagen for køberen.
- **Svindel-undtagelse:** Åbenlys svindel (tom pakke, helt anden vare, falsk kopi solgt som ægte, vare aldrig sendt) giver altid en sag, med eller uden BidHamr Beskyttelse. Pengene fryses.
- **Køber-svindel:** Køber skal uploade billeder af pakke, label og indhold inden for 48 timer for at oprette en sag. BidHamr vurderer ud fra beviser og historik. Står ord mod ord, og sporingen viser levering: sælger får pengene, og køber henvises til politiet.
- Svindlere (køber eller sælger) får kontoen lukket permanent. MitID forhindrer ny profil.
- **Pakkebilleder (krævet):** I "Send pakke"-trinnet tager sælgeren billeder med kameraet direkte i appen/på siden (ikke fra kamerarullen) af varen pakket ind i den åbne kasse og af den lukkede kasse med label. Formålet er at dokumentere **indpakningen** – billederne beviser ikke, at varen blev i kassen.
- **Sælgeren har altid ansvaret for at pakke varen forsvarligt** (fx bobleplast om en telefon).
- Skadet vare **uden BidHamr Beskyttelse**: køber og sælger må selv blive enige. BidHamr blander sig ikke.
- Skadet vare **med BidHamr Beskyttelse**: BidHamr løser sagen for køberen. Det er præcis det, beskyttelsen betales for. Pakkebillederne bruges til at vurdere, om sælgeren har pakket ordentligt.
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

**Udvidet (Filip, 2. oktober 2026):**
- Kanaler: klokke på siden (rødt tal), mail og push i appen. Brugeren vælger selv kanal(er) **pr. type** (fx "overbudt: kun push").
- **Påkrævede** (kan ikke slås helt fra, men kanal kan vælges – mindst én skal være til): du har vundet, betalingsfrist og påmindelser, køber har betalt/send varen, pakke sendt/leveret, udbetaling, sager, advarsler, tilbud til næste byder.
- **Valgfrie** (til/fra): overbudt, bud på egen auktion, nogen har liket din auktion, fulgt auktion slutter snart, ny auktion fra fulgt sælger, nye beskeder.
- Bygges samlet **før** staff-chatten og sagerne, så de kan bruge det.

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
  - **Tryghed synligt (eget):** en stribe om købersikring, MitID-verificerede brugere og at Stripe holder pengene, til varen er godkendt.
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
- Pengene skal flyde korrekt igennem hele vejen (køb, gebyrer, BidHamr Beskyttelse, frigivelse, refusion). **Vi kører stadig med testpenge.**
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

## Midlertidige beslutninger (1. oktober 2026)
- **Fragt: fast 35 kr** pr. handel, når auktionen tilbyder forsendelse (køber kan ikke vælge afhentning i stedet; kun-afhentning-auktioner = 0 kr), betalt af køber, indtil priser er forhandlet med fragtfirmaerne. Fragten udbetales IKKE til sælger – den bliver hos BidHamr og går videre til fragtfirmaet, som Filip laver aftale med (Filip, 1. oktober 2026). Sælger får bud minus 5 %. Sælgergebyret på 5% beregnes kun af buddet, ikke af fragten.
- **Udbetaling til sælger** sker automatisk via Stripe (dagligt; nye konti har Stripes ventetid på ca. 7 dage).
- **Cron**: kører hvert 5. minut via pg_cron + pg_net i Supabase (gratis). Vercel Pro overvejes tættere på lancering.
- **Moms:** Alle beløb, køberen ser, er **inkl. moms**. BidHamr afregner selv moms af sine gebyrer; køberen betaler aldrig moms oveni (Filip, 1. oktober 2026).
- **Første bud** må være lig startprisen. Budstigningen derefter (i dag 10 %) er ikke fastlagt endnu – Filip beslutter senere.
- **Medarbejdere** må gerne kunne se alle handler (beløb og status), fordi de skal bruge det til sager. Pengetal og indtjening er stadig kun for chef.

## Vinderen betaler ikke (Filip, 2. oktober 2026)
- Efter 24 timer uden betaling annulleres handlen automatisk (og Stripe-betalingen annulleres).
- **Advarsel til køberen gives IKKE automatisk.** Der oprettes en sag "Ubetalt vinder", som en medarbejder skal godkende eller afvise. I admin-menuen vises et ! med antallet af sager, der venter (fx "! 11").
- **Sælger bestemmer selv** næste skridt på handelssiden:
  - **Tilbyd til næsthøjeste byder** – til byderens eget højeste bud. Byderen har 24 timer til at sige ja/nej. Siger han ja, oprettes en ny handel med ny 24-timers betalingsfrist. Siger han nej, eller går tiden, kan sælger vælge at sende tilbuddet videre til den næste byder i rækken.
  - **Sæt varen op igen** – gratis. Ny auktion med samme titel, billeder og beskrivelse; sælger kan rette startpris og varighed.

## Chat mellem staff og brugere (Filip, 2. oktober 2026)
- Kun staff (medarbejder/admin/chef) kan åbne en samtale med en bruger ("Åbn chat"). Brugeren kan først skrive, når chatten er åbnet, og kun indtil staff lukker den. Staff har til hver en tid en knap "Afslut chat" i samtalen (også i sagschats); derefter kan brugeren ikke skrive mere, men kan stadig læse samtalen. Brugere kontakter selv BidHamr via mail.
- Ved sager: separate interne samtaler med køber og sælger knyttet til sagen + admin kan skrive en markeret fællesbesked i køber/sælger-chatten.
- Beskeder fra BidHamr markeres tydeligt. Alle samtaler gemmes og slettes aldrig.
- **Admin annullerer en ikke-betalt handel manuelt (Filip, 2. oktober 2026):** sælgeren får de samme to knapper som ved ubetalt vinder ("Tilbyd til næsthøjeste byder" og "Sæt varen op igen (gratis)"). Køberen får ingen knapper og ser kun "Handlen er annulleret af BidHamr." Der oprettes ingen advarselssag – admin har allerede taget stilling.

## Udbetalingskonto og advarsler fra admin (Filip, 2. oktober 2026)
- **Man skal have oprettet en udbetalingskonto (Stripe Connect) og sendt sine oplysninger ind for at oprette en auktion.** Man må gerne sætte varer til salg, mens Stripe behandler kontoen – udbetalingen venter, til Stripe har godkendt. Uden konto kan man byde og købe, men ikke sælge.
- På admin-siden "Betalinger" har hver sag to knapper: **"Markér som løst"** (ingen advarsel) og **"Giv advarsel"** (begrundelse påkrævet, tæller med i 3-advarsler-reglen, lukker sagen). Admin vælger, om advarslen gives til køber eller sælger.
- Ved annullerede handler vises fragten som "(refunderes ved annullering)" – køberen får altid hele beløbet inkl. fragt tilbage ved refusion.

## Indsigelse fra køberens bank efter udbetaling (Filip, 2. oktober 2026)
- Før udbetaling: indsigelsen blokerer udbetaling og refusion, til den er afgjort (bygget).
- Udbetaling sker først, når køberen har godkendt pakken (eller fristen er udløbet). Opretter køberen en sag, refunderes køberen direkte – pengene når aldrig sælgeren.
- Indsigelse **efter** udbetaling: **BidHamr bærer tabet.** En udbetaling trækkes aldrig tilbage fra sælgeren. BidHamr forsvarer sagen over for banken med sporing og leveringskvittering.
- Viser indsigelsen sig at være falsk (køberen fik varen), kan staff give køberen en advarsel via "Giv advarsel".

## Advarsler og begrundelse (Filip, 2. oktober 2026)
- Når staff giver en advarsel, skrives **to tekster**: en **intern note** (kun staff ser den) og en **begrundelse til brugeren** (kræves). Brugeren ser begrundelsen i notifikationen/mailen og på sin konto (DSA: brugeren skal vide hvorfor, da 3 advarsler giver permanent lukning).
- Gælder alle steder, hvor advarsler gives (ubetalte vindere, Betalinger, brugersiden i admin).
- **Pakken er kommet frem:** køberen får besked, når GLS melder pakken leveret (bygges med GLS-integrationen).

## Sager (Filip, 3. oktober 2026)
- **48-timers uret** starter, når køberen trykker "modtaget" (indtil GLS-sporing er bygget – derefter ved GLS-afhentning). Trykker køberen aldrig, gælder den eksisterende automatiske frigivelse.
- **Refusion ved medhold:** køberen får alt retur **undtagen BidHamr Beskyttelse** (vare, købergebyr og fragt refunderes; Beskyttelsen er "brugt").
- **Returfragt** ved skadet vare med BidHamr Beskyttelse: **BidHamr betaler altid**.
- **Retur før refusion:** ved skadet / ikke som beskrevet sender køberen varen retur (label fra BidHamr), og refunderes, når pakken er afleveret. Ved svindel (tom pakke, aldrig sendt, helt anden vare) og bortkommet pakke refunderes straks.
- **Hvem afgør:** medarbejder, admin og chef må afgøre sager, også når pengene flyttes. Alt logges; admin kan genåbne.
- **Bortkommet / aldrig sendt** kan meldes 7 dage efter afsendelse.
- **Automatisk frigivelse:** 48 timer efter "modtaget" uden sag frigives pengene til sælger. Har køberen hverken trykket "modtaget" eller oprettet en sag **14 dage efter afsendelse**, frigives pengene også (indtil GLS-sporing erstatter det). Staff tjekker sporingsnummeret hos GLS før medhold i "bortkommet".
- **Ankefrist:** efter en afgørelse flyttes pengene (refusion eller udbetaling) først **4 dage** efter afgørelsen. Staff kan genåbne sagen imens. Anke-knappen bygges senere.
