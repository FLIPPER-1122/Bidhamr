# Spørgsmål til revisor – BidHamr ApS (CVR 46836219)

Samlet 10. okt. 2026 til mødet med revisor. Numrene i parentes henviser til `jura/noter-til-advokat.md`, hvor den fulde baggrund står.

## Kort om BidHamr

- Dansk auktionsplatform, hvor privatpersoner (og senere firmaer) sælger brugte ting til hinanden.
- **Stripe holder alle penge.** BidHamr har ingen saldo eller wallet.
  - Køberen betaler på checkout-siden. Pengene lander på **sælgerens egen Stripe-konto** (Stripe Connect Express, "destination charge").
  - BidHamrs indtægt trækkes fra som et **application fee** = købergebyr + sælgergebyr + fragt + BidHamr Beskyttelse.
- **Ingen udbetaling, før handlen er helt afsluttet.** Udbetalingen sker først, når køberen har godkendt varen, eller når fristen for en sag er udløbet. Er der en sag eller indsigelse, fryses pengene.
- **Fragt (DAO):** køberen betaler en fast pris.
  - Pakkeshop: 40, 50 eller 65 kr.
  - Hjemlevering: 60 eller 85 kr.
  - BidHamr har aftalen med DAO og betaler selv forskellen, hvis DAOs pris er højere.
- **BidHamr Beskyttelse** er BidHamrs egen ydelse: hjælp med sagen, hvis varen går i stykker under forsendelse. Det er ikke en forsikring.
- **Fakturaer:**
  - BidHamr fakturerer **kun egne ydelser** (gebyrer, fragt, Beskyttelse, erhvervsabonnement) via Dinero, alle inkl. 25 % moms.
  - Firmaer fakturerer selv deres varer.
- **Erhvervsabonnement** betales via Stripe Billing.

## 1. Moms

1. **Moms på vores ydelser:** Er købergebyr, sælgergebyr, fragt og BidHamr Beskyttelse alle momspligtige med 25 %? (88, 99)
2. **Fragten:** Køberen betaler fragten til BidHamr, og BidHamr køber fragten hos DAO. Er fragten BidHamrs egen momspligtige ydelse? Hvordan behandles det, at vi giver tilskud, når DAOs pris er højere end køberens pris? (afsnit 5)
3. **Hvem er kunden?** Stripe trækker formelt hele application fee fra sælgerens Stripe-konto. Skal fakturaen for købergebyr, fragt og Beskyttelse stiles til **køberen** (som i dag) eller til sælgeren? (93, 98)
4. **Momsregistrerede firmaer:** Skal et firma opgøre moms af hele beløbet inkl. købergebyr og fragt, fordi firmaet står som "forretning" over for kortnetværket? (94)

## 2. Fakturaer og bogføring

5. **Dinero:** Er Dinero et registreret digitalt bogføringssystem? Er det i orden, at fakturaerne laves automatisk via Dineros API og vises som PDF på BidHamr? (104)
6. **Tidspunkt:** Fakturaen dateres på betalingsdagen (momsloven § 23, stk. 3, forudbetaling), og en refusion giver en kreditnota. Er det rigtigt, eller skal fakturaen først laves, når handlen er afsluttet? Hvad med fragten, der leveres efter betalingen? (97)
7. **Bogføring af Stripe:** Hvordan bogføres:
   - gebyrerne (application fee)
   - Stripes egne gebyrer
   - udbetalingerne fra Stripe til BidHamrs bank
   Skal der være en egen "Stripe"-konto i Dinero? Sælgernes penge går aldrig gennem BidHamr. (89, 101)
8. **BidHamr Beskyttelse ved medhold:** Må BidHamr beholde Beskyttelsen uden kreditnota, når køberen får medhold i en sag og får alt andet refunderet? (99)
9. **Tabt indsigelse (chargeback):** Får køberen pengene tilbage via sin bank, og BidHamr bærer tabet, skal der så laves en kreditnota, eller bogføres det som et tab? (102)
   Ved en indsigelse efter udbetaling bærer BidHamr hele tabet, og køberen sender varen til BidHamr. Hvordan bogføres det, og hvordan bogføres et eventuelt videresalg af varen?
10. **Fakturaer til private:** Er en forenklet faktura uden adresse nok under 3.000 kr.? Hvad gør vi over 3.000 kr., hvis vi ikke har adressen? Fakturaer gemmes i 5 år, også hvis brugeren sletter kontoen. (103)
11. **Erhvervsabonnement:** Stripe udsteder fakturaen med moms og CVR. Vi bogfører Stripe-fakturaen som bilag i Dinero i stedet for at lave en ny faktura. Er det korrekt? Hvordan håndteres en refusion? (100)
12. **Firmasalg:** Bekræft at BidHamr som platform **ikke** skal fakturere varen, når et firma sælger, fordi firmaet selv fakturerer. Hvilke købsoplysninger må eller skal vi give firmaet? Vi viser i dag købers navn og adresse fra handlen. (95)

## 3. DAC7 (indberetning af sælgere til Skattestyrelsen)

13. **Vederlag og tidspunkt:** Vi indberetter sælgere med mindst 30 salg eller over 2.000 EUR pr. år. Vederlag regnes som bud minus sælgergebyr, og salget tæller på betalingsdagen. Refunderede salg tæller ikke. Er det rigtigt? Hvilken EUR-kurs skal bruges? Vi bruger i dag 7,46, og chefen kan rette den pr. år. (111)
14. **Gebyrer:** Vi indberetter kun sælgergebyret som "gebyrer tilbageholdt af platformen", ikke købergebyr, fragt og Beskyttelse. Er det rigtigt? (111)
15. **Bankkonto:** Kontonummeret ligger hos Stripe, og vi kender kun de sidste 4 cifre. Derfor indberetter vi det ikke. Er det i orden? (112)
16. **Registrering og frist:** Hvornår skal BidHamr registreres med pligtkode 242 (blanket 03.091)? Er 31. januar fristen både for indberetningen og for sælgerens kopi? (111)
17. **Opbevaring:** Hvor længe skal sælgeroplysninger og indberetningsfiler gemmes: 5 eller 10 år? (111)
18. **Sanktion:** Mangler en sælgers oplysninger efter 60 dage og 2 påmindelser, spærrer vi for nye auktioner, men udbetalinger fortsætter. Er det nok, eller skal udbetalinger tilbageholdes? (111, 113)
19. **Sælgere uden for Danmark:** Må vi nøjes med sælgere med bopæl i Danmark? (113)
20. **Firmakonti:** Indberettes de efter samme grænser med CVR? Skal vi indhente momsnummer? (111)

## 4. Selskab og drift (forslag til ekstra spørgsmål)

21. Skal BidHamr momsregistreres med det samme, selv om omsætningen er lav i starten (grænse 50.000 kr.)?
22. Hvordan bogføres opstartsudgifter som Stripe, Idura (MitID), Vercel, Supabase og domæne?
23. Hvad koster revisorens hjælp, og hvad kan BidHamr selv klare i Dinero?
24. Apple (App Store Connect): vi har udfyldt W-8BEN-E som "Corporation", FATCA "Active NFFE", dobbeltbeskatningsaftale Danmark-USA artikel 12 (royalties) 0 %, og "active trade or business" under limitation on benefits. Er det korrekt for BidHamr ApS?
25. Køb af boost-point i appen via Apple og Google: Apple og Google er sælger over for køberen og opkræver selv momsen. BidHamr modtager beløbet efter gebyr (15 %). Hvordan bogføres det (omsætning brutto eller netto, moms, EU-ydelse)? Se docs/IAP.md.

## 5. Faktura fra firma til køber (Filip, 27. okt. 2026 – bygget 28. okt. 2026)
Når køberen har betalt, laver BidHamr en fakturakladde i firmaets navn (firmanavn, CVR, adresse, evt. logo, køber, vare, pris og leveringsdato). Firmaet ser den igennem og trykker selv "Send" – intet sendes automatisk. Mailen sendes som "Firmanavn via BidHamr" med firmaets e-mail som svaradresse og PDF'en vedhæftet. Detaljer: docs/FIRMA-FAKTURA.md. Dette ændrer svaret på spørgsmål 12.

26. **Hvem udsteder?** BidHamr laver kladden, men firmaet trykker "Send" og står som udsteder (firmaets navn og CVR, "udstedt af ... – lavet med BidHamr"). Er det firmaets egen faktura efter momsloven og bogføringsloven, eller bliver BidHamr "udsteder på vegne af" firmaet (momsbekendtgørelsens regler om selvfakturering/fakturering ved tredjemand), som i så fald kræver en skriftlig aftale med firmaet og en procedure for godkendelse?
27. **Nummerserien.** Hvert firma får sin egen fortløbende serie hos BidHamr med eget præfiks og startnummer (fx "BH-0001"). Nummeret gives først ved "Send", så der ikke opstår huller, og kreditnotaer får nummer i samme serie. Er det i orden, at firmaet har en separat serie hos BidHamr ved siden af serien i sit eget regnskabsprogram, når præfikset er forskelligt? Eller skal firmaet fortsætte sin egen serie (det kan det ved at sætte startnummeret)?
28. **Brugtmoms-teksten.** *(Rettet 28. okt. 2026.)* Ved brugtmoms står der ingen moms på fakturaen, men lovens ordlyd **"Fortjenstmargenordning – brugte genstande"** (momssystemdirektivets art. 226, nr. 14 / momsbekendtgørelsen § 58), og på linjen under: "Varen sælges efter brugtmomsordningen. Momsen står ikke på fakturaen og kan ikke trækkes fra." (Før stod der "Brugtmoms – særordning for brugte varer"; fakturaer, der allerede er sendt, ændres ikke.) Firmaet vælger selv momsordningen pr. auktion og kan rette den på fakturakladden, indtil den sendes. Vælges brugtmoms på en vare med stand "ny" eller "ny med mærke", viser vi en advarsel om, at brugtmoms kun gælder brugte varer købt uden moms – men vi blokerer ikke. Spørgsmål: Er teksten og forklaringen rigtige og nok? Er det i orden kun at advare (ikke blokere) ved nye varer, når firmaet selv har ansvaret for momsen? Ved almindelig moms viser hver linje nu enhedspris og beløb ekskl. moms, momssats og beløb inkl. moms (§ 58, stk. 1) – er det nok?
29. **Fuld faktura.** Fakturaen har udstedelsesdato, fortløbende nummer, sælgers CVR, navn og adresse, købers navn og adresse (fra købers konto, ellers fra checkout, ellers kan firmaet udfylde), varebeskrivelse, mængde (1), leveringsdato, beløb ekskl. moms, momssats (25 %) og momsbeløb – samt "Betalt via BidHamr". Mangler der noget? Er leveringsdatoen rigtig, når vi bruger datoen, hvor køberen bekræftede modtagelsen (ellers afsendelsesdatoen, ellers betalingsdatoen), og firmaet kan rette den i kladden?
30. **Fragt og gebyrer.** Fragten betales til BidHamr (og videre til fragtfirmaet), og BidHamrs gebyrer faktureres af BidHamr. Derfor står kun varen på firmaets faktura. Er det korrekt, eller skal fragten med på firmaets faktura, fordi firmaet "sender" varen?
31. **Opbevaring.** Sendte fakturaer og kreditnotaer gemmes hos BidHamr i 5 år og kan ikke ændres eller slettes (kun krediteres). Firmaet kan hente alle som CSV og PDF (ZIP) til sit eget regnskab. Er firmaet stadig selv ansvarlig for at opbevare dem efter bogføringsloven, eller kan BidHamrs opbevaring tælle med? Hvad med firmaer, der lukker deres konto?
32. **Kreditnota.** I dag kan der kun laves én fuld kreditnota pr. faktura (hele beløbet). Er det nok, eller skal delvis kreditering være muligt (fx ved delvis refusion)?
