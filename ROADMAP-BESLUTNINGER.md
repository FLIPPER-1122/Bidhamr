# BidHamr – Produktbeslutninger (kladde til roadmap)

> **VIGTIGT – gælder hele dokumentet:**
> - **Stripe holder brugernes penge (Stripe Connect), ikke BidHamr.**
> - **Der er INGEN købersaldo/wallet.** Vinderen betaler selv inden for **48 timer** efter auktionen (ændret fra 24 timer af Filip 5. okt. 2026; sælger kan forlænge til højst 7 dage) (kort, MobilePay, Apple Pay, Google Pay – og de øvrige metoder Stripe tilbyder, fx Klarna, Revolut Pay og Link; Filip 1. okt. 2026: må gerne være slået til). Som **tilvalg** kan brugeren gemme et kort og slå automatisk betaling til, så kortet trækkes med det samme, når han vinder. Betaler han ikke inden fristen: handlen annulleres, han får en advarsel, og sælger kan tilbyde varen til næsthøjeste byder eller sætte den op igen. Hvor der står "wallet" nedenfor, er det forældet.
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
  - **Afhentningsfrist (Filip, 5. oktober 2026):** køberen har **7 dage** fra betalingen til at hente varen. Fristen vises på handelssiden for begge, og begge får en påmindelse på dag 5. Sælger kan forlænge fristen (fx efter aftale i chatten), højst til 14 dage efter betalingen. Er varen ikke hentet inden fristen, får staff besked og afgør handlen. Har staff ikke gjort noget **14 dage** efter betalingen – og mindst 7 dage efter en forlænget frist – får køberen automatisk alle pengene tilbage, og sælger beholder varen.
  - **Grænser (Filip, 5. oktober 2026):** 5 forkerte koder låser koden i 1 time; 15 forkerte forsøg i alt låser den permanent, og staff tager over. Er varen ikke hentet, får staff besked efter 7 og igen efter 14 dage.

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
- **Advarselssystem for dårlig indpakning:** 1. gang = påmindelse til sælgeren. 2. gang og derefter = en advarsel hver gang. **3 advarsler = profilen lukkes permanent.** En staff skal altid godkende lukningen – den sker aldrig automatisk (Filip, 3. oktober 2026).
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
- **Links i kommentarer er tilladt** (Filip, 3. oktober 2026). Kommentaren må højst være 1000 tegn.
- FEJL at rette: submitRating tjekker ikke, at man faktisk var køber i handlen. I dag kan enhver bedømme enhver. Skal låses, så kun køberen på en handel kan bedømme den handels sælger, én gang.
- **Svar fra sælger** (foreslået af Claude 5. oktober 2026 – afventer Filips godkendelse):
  - Kun sælgeren på den bedømte handel kan svare – **ét offentligt svar pr. bedømmelse**, højst 1000 tegn. Vises under bedømmelsen som "Svar fra sælger".
  - Svaret kan **rettes eller slettes i 48 timer** efter det er skrevet, derefter er det låst. Et slettet svar kan ikke skrives igen (der er kun ét svar).
  - Svaret må **ikke indeholde kontaktinfo** (samme filter som "Spørg sælger": links, e-mail, telefon, MobilePay, beskedtjenester) og **ingen grove ord** (kort liste over entydige skældsord og trusler). Køberens kommentar må stadig indeholde links.
  - Køberen får en notifikation, når sælgeren svarer (valgfri type "Svar på dine bedømmelser").
- **Rapportér og fjern** (foreslået af Claude 5. oktober 2026 – afventer Filips godkendelse):
  - Alle indloggede brugere kan rapportere en bedømmelse eller et svar (grove ord/chikane, personoplysninger, kontaktinfo, ikke om handlen, stødende, spam, andet). Rapporterne ligger i admin under **Bedømmelser → Til gennemsyn**.
  - Medarbejdere (og op) kan **skjule** en bedømmelse og/eller et svar med en fast begrundelse: grove ord/chikane, personoplysninger, kontaktinfo, ikke relateret til handlen, andet (+ fritekst). Eller vælge **Behold**, som lukker rapporterne.
  - Bedømmelser **slettes aldrig** – de skjules (arkiveres), kan vises igen, og en skjult bedømmelse **tæller ikke med i sælgerens gennemsnit**. Alt logges i medarbejder-loggen.
  - Den, der skrev teksten, får en notifikation med begrundelsen (påkrævet, så den altid når frem – DSA).

## Midlertidige beslutninger (1. oktober 2026)
- **Fragt: fast 35 kr** pr. handel, når auktionen tilbyder forsendelse (køber kan ikke vælge afhentning i stedet; kun-afhentning-auktioner = 0 kr), betalt af køber, indtil priser er forhandlet med fragtfirmaerne. Fragten udbetales IKKE til sælger – den bliver hos BidHamr og går videre til fragtfirmaet, som Filip laver aftale med (Filip, 1. oktober 2026). Sælger får bud minus 5 %. Sælgergebyret på 5% beregnes kun af buddet, ikke af fragten.
- **Udbetaling til sælger** sker automatisk via Stripe (dagligt; nye konti har Stripes ventetid på ca. 7 dage).
- **Cron**: kører hvert 5. minut via pg_cron + pg_net i Supabase (gratis). Vercel Pro overvejes tættere på lancering.
- **Moms:** Alle beløb, køberen ser, er **inkl. moms**. BidHamr afregner selv moms af sine gebyrer; køberen betaler aldrig moms oveni (Filip, 1. oktober 2026).
- **Mindste startpris (Filip, 5. oktober 2026): 1 kr.**
- **Gratis at oprette en auktion (Filip, 6. oktober 2026).** Der betales kun gebyr, når en vare bliver solgt.
- **Forbudte varer (Filip, 6. oktober 2026):** alle ulovlige varer blokeres med det samme ved oprettelse (fx skydevåben inkl. almindelig "pistol", narkotika, ulovlige knive). **Levende dyr må ikke sælges** og blokeres. Lovlige men følsomme varer (fx billetter, alkohol, tobak, mulige kopivarer) giver en rapport til staff. **Billetter giver altid en rapport til staff.**
- **Filips navn vises ikke offentligt** (Filip, 6. oktober 2026) – "Om BidHamr" nævner kun BidHamr.
- **Sælger markerer selv pakken sendt (Filip, 6. oktober 2026):** også når fragtfirmaet melder pakken afleveret, skal sælger selv trykke "Send pakke" (med pakkebilleder). Afsendelsesfristen gælder uændret.
- **Driftsdata (Filip, 5. oktober 2026):** fejllog (drift_fejl) og cron-log (drift_cron_koersler) slettes automatisk efter 90 dage. pg_cron-historikken (cron.job_run_details) slettes efter 14 dage (Filip, 6. oktober 2026). Det er ikke handelsdata.
- **Første bud** må være lig startprisen.
- **Budstigning (Filip, 4. oktober 2026)** – trappe efter det nuværende højeste bud: under 100 kr: +5 kr · 100–999 kr: +10 kr · 1.000–4.999 kr: +50 kr · fra 5.000 kr: +100 kr. Erstatter de 10 %.
- **Auktionsvarighed (Filip, 4. oktober 2026):** sælger vælger 3, 5, 7 eller 10 dage ved oprettelse. 7 dage er forvalgt.
- **Startpris = mindstepris:** én synlig startpris; ingen skjult mindstepris.
- **Bindende bud:** et bud kan ikke trækkes tilbage. Det vises tydeligt, før man byder.
- **Redigér/annullér auktion:** kun så længe der ikke er bud. Annullerede auktioner arkiveres, slettes aldrig.
- **Afsendelsesfrist:** sælger skal markere pakken sendt inden 5 dage efter betaling. Ellers annulleres handlen automatisk, og køber refunderes fuldt (inkl. fragt og BidHamr Beskyttelse).
- **Medarbejdere** må gerne kunne se alle handler (beløb og status), fordi de skal bruge det til sager. Pengetal og indtjening er stadig kun for chef.
- **Behandlede rapporter** (Filip, 5. oktober 2026): slettes aldrig. Efter 48 timer flyttes de fra den aktive liste til rapportarkivet (rapporter_arkiv), hvor de gemmes permanent.

## Vinderen betaler ikke (Filip, 2. oktober 2026)
- **Betalingsfrist (Filip, 5. oktober 2026):** vinderen har **48 timer** til at betale. Sælger kan på handelssiden forlænge fristen (fx efter aftale i chatten), men højst til **7 dage** efter, at betalingsfristen startede (auktionens afslutning – eller når næste byder siger ja til et tilbud). Køberen får besked om den nye frist.
- Efter fristen uden betaling annulleres handlen automatisk (og Stripe-betalingen annulleres).
- **Sælger gør intet (Filip, 5. oktober 2026):** har sælger hverken tilbudt varen til næste byder eller sat den op igen 14 dage efter annulleringen, arkiveres auktionen. Sælger kan stadig sætte varen op igen fra Mine handler.
- **Advarsel til køberen gives IKKE automatisk.** Der oprettes en sag "Ubetalt vinder", som en medarbejder skal godkende eller afvise. I admin-menuen vises et ! med antallet af sager, der venter (fx "! 11").
- **Sælger bestemmer selv** næste skridt på handelssiden:
  - **Tilbyd til næsthøjeste byder** – til byderens eget højeste bud. Byderen har 24 timer til at sige ja/nej. Siger han ja, oprettes en ny handel med ny 48-timers betalingsfrist. Siger han nej, eller går tiden, kan sælger vælge at sende tilbuddet videre til den næste byder i rækken.
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
- **Returfragt** (ændret af Filip, 3. oktober 2026): når køberen får medhold og skal sende varen retur, **betaler køberen selv returfragten**. Den refunderes ikke.
- **Retur før refusion:** ved skadet / ikke som beskrevet sender køberen varen retur for egen regning (se Returfragt), og refunderes, når pakken er afleveret. Ved svindel (tom pakke, aldrig sendt, helt anden vare) og bortkommet pakke refunderes straks.
- **Hvem afgør:** medarbejder, admin og chef må afgøre sager, også når pengene flyttes. Alt logges; admin kan genåbne.
- **Bortkommet / aldrig sendt** kan meldes 7 dage efter afsendelse.
- **Automatisk frigivelse:** 48 timer efter "modtaget" uden sag frigives pengene til sælger. Har køberen hverken trykket "modtaget" eller oprettet en sag **14 dage efter afsendelse**, frigives pengene også (indtil GLS-sporing erstatter det). Staff tjekker sporingsnummeret hos GLS før medhold i "bortkommet".
- **Ankefrist:** efter en afgørelse flyttes pengene (refusion eller udbetaling) først **4 dage** efter afgørelsen. Staff kan genåbne sagen imens.
- **Anke:** den, der taber sagen, kan anke. Knappen åbner 24 timer efter afgørelsen og er åben i 3 dage (i alt 4 dage = ankefristen). Kræver begrundelse, gerne ny dokumentation. Behandles af en anden medarbejder (admin/chef) end den, der afgjorde sagen. Afgørelsen på anken er endelig. Pengene er frosset, til ankefristen er udløbet – og mens en anke behandles.
- **Alle afgørelser kan ankes (Filip, 5. oktober 2026)** – også en sag, der er lukket uden at penge blev flyttet. Den part, der fik afvist sin sag, kan anke. **Én anke pr. sag** (Filip, 5. oktober 2026): afgøres en anket sag senere igen (fx fordi køberen ikke sender returen), kan den nye afgørelse ikke ankes.
- **Ventetid før afgørelse til sælger ved retur (Filip, 5. oktober 2026):** når køberen har fået besked om at sende varen retur, skal der gå mindst **7 dage**, før staff kan afgøre til sælger eller lukke sagen, fordi returen ikke er kommet.

## Konto og GDPR (chefen, 7. oktober 2026 – til Filips godkendelse)
- **Bekræftelse af e-mail:** en ny konto skal bekræfte sin e-mail via et link, før man kan logge ind ("Confirm email" i Supabase). Efter oprettelse vises "Tjek din indbakke" med "Send mailen igen" (ventetid 60 sek. + grænser pr. e-mail og IP). Udløbet link giver mulighed for en ny mail. Oprettelse er stadig lukket indtil launch (åbnes med `TILMELDING_AABEN=true`; altid åben på testdatabasen).
- **Stærk adgangskode:** mindst 10 tegn (højst 72), ikke en af de mest almindelige adgangskoder (indbygget liste inkl. danske), ikke e-mailen eller navnet. Gælder ved oprettelse, ny adgangskode og skift af adgangskode. Styrkemåler vises.
- **Skift adgangskode** kræver den nuværende adgangskode. Bagefter logges man ud på alle andre enheder og får en mail.
- **To-trins-login** er frivilligt (app-kode/TOTP). Slås til med QR-kode + kode og fra med en kode. Er det slået til, skal koden bruges ved hvert login – også databasen afviser en session uden koden. Mistet telefon: support bekræfter identiteten og fjerner to-trins-login. Medarbejdere skal have to-trins-login for at bruge admin (kan slås fra med STAFF_KRAEVER_TO_TRIN=false).
- **Nyt login fra ny enhed:** mail "Nyt login på din BidHamr-konto" med tidspunkt og enhed (fx "Chrome på Windows"). Enheden kendes på en tilfældig cookie; kun en hash gemmes, aldrig IP-adressen. Første login efter oprettelse giver ingen mail. På Min konto ses enhederne; man kan fjerne en enhed (den logges ud) og "Log ud alle andre steder".
- **Sikkerhedsmails** (nyt login, ændret adgangskode, to-trins-login til/fra, konto slettet) kan ikke slås fra.
- **Download dine data:** én JSON-fil med alt om brugeren (profil, auktioner, bud, handler med egne beløb, beskeder i egne handler, samtaler med BidHamr, bedømmelser givet/modtaget og egne svar, notifikationer og indstillinger, favoritter, følger, gemte søgninger, rapporter, kontakthenvendelser, enheder). Andre brugere står kun med fornavn. Ingen interne staff-noter, ingen andres kontaktoplysninger. Højst 1 gang i timen.
- **Slet konto** kan ikke ske, mens brugeren har: auktioner i gang med bud, bud på auktioner i gang, handler der ikke er afsluttet/annulleret (inkl. manglende betaling), åbne sager eller sager hvor pengene ikke er flyttet (ankefrist), anker der venter, tilbud til næste byder der venter, penge undervejs (betaling, udbetaling, tilbagebetaling, indsigelse) eller en uafklaret sag om manglende betaling. Siden viser præcis hvad og linker dertil. Medarbejderkonti kan ikke slettes, før en chef har fjernet rollen.
- **Sletningen** bekræftes med adgangskode og ved at skrive "SLET". Auktioner i gang uden bud afsluttes og arkiveres. Navn → "Slettet bruger"; e-mail, telefon, adresse, profilbillede (også i storage), push-tokens, gemt kort og automatisk betaling fjernes. Favoritter, følg (begge veje), gemte søgninger, notifikationer, blokeringer, skabeloner og enheder slettes. **Handelsdata bevares** (handler, betalinger, gebyrer, sager, anker, beskeder, moderation_log) pga. bogføringsloven/DAC7. Bedømmelser og sælgersvar bevares, men står som fra "Slettet bruger". Stripe-kunde- og kontoreferencer bevares som handelsdata (gemte kort i Stripe ryddes, når Stripe-arbejdet genoptages).
- Login-brugeren soft-slettes i Supabase (e-mail sløres, kan ikke logge ind). E-mailen kan bruges til en ny konto senere. Kvitteringsmail "Din konto er slettet". Sletningen logges i moderation_log uden persondata.

## DSA – forordning om digitale tjenester (foreslået af Claude 6. oktober 2026 – afventer advokat)
Bygget i `20261009010000_dsa.sql`, `src/lib/dsa/` og `/admin/dsa`. Alt nedenfor er Claudes forslag og skal godkendes af advokaten.
- **Anmeld ulovligt indhold (art. 16):** knappen "Anmeld" på auktioner, profiler, spørgsmål, sælgers svar på spørgsmål, bedømmelser og sælgers svar på bedømmelser – også uden login – samt `/dsa/anmeld` (indsæt et link; link i footeren). Kategorier: forbudt/ulovlig vare, falske varer/varemærke, svindel, ophavsret, personoplysninger, hadefuld/truende tale, seksuelt misbrug af børn, bryder BidHamrs regler, andet. Formularen kræver begrundelse (10–2000 tegn), navn (højst 100 tegn) og e-mail (undtagen ved misbrug af børn, art. 16(2)(c)) og en erklæring om god tro. Placeringen udfyldes af serveren. Indloggede bruger kontoens navn og e-mail.
- **Samlet system:** hjemmesidens gamle "Anmeld opslag" (reports) og "Rapportér bedømmelse/bruger" (bruger_rapporter) er erstattet af den nye anmeldelse, så brugerne kun har ét sted at anmelde og staff én liste. Rapportér af chatbeskeder (private beskeder i en handel) er uændret. De gamle tabeller og automatiske rapporter (forbudte varer, spamfilter) kører videre og tælles med i rapporten.
- **Spam uden tredjeparts-CAPTCHA:** honeypot-felt, tidsfælde (mindst 3 sek.), rate limit pr. IP (10/time uden login, 30/time med login – tjekkes før indholdet slås op), e-mail (10/time), bruger (20/time) og særskilte fælles lofter for anmeldere uden login (300/time) og med login (500/time), plus højst 20 pr. anmelder pr. døgn og fælles lofter i databasen. Anmeldelser om misbrug af børn tæller ikke med i de fælles lofter (IP-loftet gælder stadig). Appens POST /api/dsa/anmeld har samme lofter (login er valgfrit, DSA kræver anonym anmeldelse). Anmeldelser oprettes kun via serveren (service_role) – ingen direkte adgang til tabellen.
- **Uden login afsløres intet (foreslået af Claude 6. okt. 2026):** en anmelder uden login får altid samme svar ("Tak – vi har sendt en kvittering til din e-mail") – aldrig sagsnummer eller link på skærmen, og intet dublettjek på e-mail. Svaret er det samme, når indholdet ikke findes, og når e-mailen tilhører den, der ejer indholdet – i det tilfælde oprettes ingen sag (ejeren skal ikke kunne følge eller klage over en "anmeldelse" af sig selv). Indloggede ser deres egen sag.
- **Kvittering og svar (art. 16(4)–(5)):** mail med sagsnummer og et signeret link til at følge sagen (kvitteringen viser kun et link, BidHamr selv har bygget – aldrig anmelderens fritekst; højst 3 kvitteringer pr. modtager pr. døgn og 100 i alt pr. time uden login). Svar på mail, når sagen er afgjort, med mulighed for at klage. Mails markeres først sendt, når de er sendt, så cron'en prøver igen.
- **Interne frister:** anmeldelser 7 dage (24 timer ved misbrug af børn og hadefuld tale), klager 14 dage. Vises rødt i admin, når fristen er overskredet.
- **Hurtige handlinger:** Fjern/skjul (eller suspendér/luk ved profiler), Behold (ingen overtrædelse / indholdet findes ikke) og Videresend til admin. Fjerne auktioner og lukke konti kræver admin, resten medarbejder. Et indgreb lukker alle åbne anmeldelser af samme indhold. Staff kan markere, at politiet er underrettet (art. 18).
- **Begrundelse ved indgreb (art. 17):** én fælles databasefunktion (`dsa_indgreb`) for alle indgreb: skjul/fjern/stop auktion, skjul spørgsmål/svar, skjul bedømmelse/svar, suspendér og luk konto (også fra sager og kontolukning efter 3 advarsler). Staff vælger regel/lov fra en fast liste og skriver fakta til brugeren. Brugeren får mail (altid, også selvom mail er slået fra – ny påkrævet notifikationstype "Afgørelser og klager") med hvad, hvorfor, regel/lov, om det blev opdaget automatisk eller via anmeldelse, og hvordan man klager. Anmelderens identitet afsløres aldrig. Begrundelserne gemmes og slettes aldrig.
- **Varer, som forbudte-varer-filteret blokerer ved oprettelse,** bliver aldrig offentliggjort – sælgeren får fejlbeskeden med det samme. Det registreres ikke som en afgørelse.
- **Klage (art. 20):** inden for 6 måneder via linket i mailen eller Min konto → Afgørelser (linket virker også ved suspenderet/lukket konto). Anmelderen kan klage, når vi ikke greb ind. Ét klagetrin pr. afgørelse. Klagen behandles af en anden medarbejder end den, der traf afgørelsen (og aldrig af en, der er part eller har handlet med brugeren). Klager over auktioner og lukkede konti kræver admin. Medhold ophæver indgrebet med det samme (skjult auktion vises igen, suspension ophæves, lukket konto genåbnes); medhold til en anmelder genåbner anmeldelsen. En fjernet eller stoppet (annulleret) auktion genåbnes aldrig (Filip, 6. okt. 2026): afgørelsen ophæves, men buddene gælder ikke, og sælgeren får en undskyldning og kan sætte varen op igen med ét klik (se "Skjult auktion sættes på pause"). En suspension, der er udløbet af sig selv, fjerner ikke klageretten. Skjules et spørgsmål med svar, får både spørgeren og sælgeren en begrundelse.
- **Gennemsigtighedsrapport (art. 15/24):** `/admin/dsa/rapport` (admin og chef) med tal for en valgt periode og CSV-download.
- **Persondata:** anmelderens navn, e-mail, konto-kobling og fritekst (også svaret til anmelderen og anmelderens klage) anonymiseres 12 måneder efter afgørelsen (eget cron-job `dsa_oprydning`). Interne noter bevares, men e-mail og telefonnumre fjernes. Statistikken bevares.
- **Kontaktpunkt (art. 11–12):** `/dsa` med e-mail `dsa@bidhamr.dk` (pladsholder – Filip skal oprette den).

## Skjult auktion sættes på pause (Filip, 6. oktober 2026)
Bygget i `20261009040000_skjult_auktion_pause.sql` (testdatabasen rettet med `20261009041000_skjult_auktion_pause_rettelser.sql`).
- **En skjult auktion sættes på pause, indtil den er oppe igen** (Filip). Når BidHamr skjuler en igangværende auktion (admin "Skjul", DSA "Fjern/skjul" → "Auktion skjult", rapporter), stopper uret: den kan ikke afsluttes, og der kan ikke bydes, så længe den er skjult. Der oprettes aldrig handel eller betaling på en pauset auktion.
- **Vises den igen** (staff "Vis igen", medhold i en klage over skjulningen, genåbnet rapport), fortsætter den med den tid, der var tilbage, da den blev skjult – **dog mindst 24 timer, så byderne kan nå at reagere** (foreslået af Claude). Bud og førende bud bevares. Forlængelse ved bud i de sidste 2 minutter virker som normalt bagefter. Auktionen tæller ikke som "ændret af sælgeren".
- **En auktion, som BidHamr har fjernet (annulleret), genåbnes ALDRIG** (Filip, 6. okt. 2026) – heller ikke ved medhold i en klage eller en genåbnet rapport. Buddene gælder ikke. Sælgeren får medhold (begrundelse + undskyldning) og kan **sætte varen op igen med ét klik**: der oprettes en ny auktion med samme titel, beskrivelse, billeder, startpris og varighed. Fjernes en auktion, mens den er på pause, lukkes pausen. Databasen afviser at give en annulleret auktion en anden status. Knappen "Sæt varen op igen" vises kun, når auktionen er annulleret, og ikke mens en klage er i gang; med ét klik kun når afgørelsen er ophævet, eller auktionen blev annulleret automatisk (ellers et link til "Opret en ny auktion").
- **Maks pause** (Filip, 6. okt. 2026): efter **3 dage** på pause får staff en påmindelse (drift-alarm og en rød markering på /admin/auktioner med "annulleres automatisk om X dage"). Efter **14 dage** annulleres auktionen automatisk (pg_cron `pause-udloeb`, hver time). Det gemmes som en DSA-afgørelse ("Din auktion er stoppet", automatisk afgjort, samme regel som skjulningen), så sælgeren får begrundelsen og kan klage. Byderne får "Auktionen blev ikke åbnet igen, og dit bud gælder ikke længere. Du skal ikke betale noget." Sælgeren kan sætte varen op igen med ét klik.
- **En skjult auktion kan sælgeren ikke ændre** (heller ikke direkte fra appen), og der kan ikke bydes på en pauset auktion. Billeder, sælgeren fjerner ved redigering, slettes ikke, mens der er en åben anmeldelse eller rapport om auktionen.
- **Beskeder** (ny valgfri notifikationstype "Auktion på pause", foreslået af Claude): byderne får "Auktionen er sat på pause, mens BidHamr kigger på den. Dit bud gælder stadig." Sælgeren får den sædvanlige begrundelse. Når den åbner igen, får sælger og bydere "Auktionen er åben igen og slutter [dato/tid]." Pause-beskeden sendes kun, hvis auktionen stadig er aktiv og på pause.
- **Visning:** auktionssiden (sælger, bydere og staff) viser "På pause – resterende tid X" i stedet for nedtællingen. Profil og Min statistik viser den som "På pause"; admin-listen viser "På pause" og den resterende tid.
- **Teknik (foreslået af Claude):** `auctions.pauset_kl` og `auctions.pause_resterende` sættes og nulstilles af en trigger på `auctions.skjult`, så det virker uanset hvilken staff-funktion der skjuler. Kun systemet kan ændre felterne. Pauserne logges i `auktion_pauser` (slettes aldrig; en auktion med pauser kan ikke slettes). En auktion er "på pause", når `status = 'aktiv'` og `pauset_kl` er sat.
- **Eksisterende skjulte, aktive auktioner** blev sat på pause med deres resterende tid (0, hvis tiden allerede var gået uden handel – så får de 24 timer, når de vises igen). Der var 0 i både produktion og test 6. oktober 2026.

## Accept af brugerbetingelser (foreslået af Claude 6. oktober 2026 – afventer Filip)
- **Nye brugere** skal sætte flueben ved "Jeg accepterer BidHamrs brugerbetingelser" for at oprette en konto på hjemmesiden. Versionen og tidspunktet gemmes på brugeren (`users.vilkaar_version`, `users.vilkaar_accepteret_kl`); tidspunktet sættes altid af databasen.
- **Appen** skal vise samme flueben og sende `vilkaar_version` i signup-metadata. Sender den ikke versionen, oprettes kontoen stadig, men uden gemt accept.
- **Eksisterende brugere** (og brugere uden gemt accept) ser en venlig bjælke på Min konto: "Vi har lavet brugerbetingelser – læs dem her" med knappen "Jeg har læst og accepterer". Den blokerer ikke noget, indtil videre.
- **Ved lancering** kan accept af den aktuelle version gøres påkrævet, før man kan byde eller oprette en auktion (fx en side "Accepter de nye brugerbetingelser" i stedet for buddet). Det gælder også, når betingelserne ændres væsentligt (se betingelsernes afsnit 25).
- Betingelserne og privatlivspolitikken vises som **UDKAST – skal godkendes af advokat** (version 0.1), indtil advokaten har godkendt dem i fase 6. Advokatens noter og interne noter vises aldrig på siderne; manglende oplysninger vises som "[udfyldes inden lancering]".
