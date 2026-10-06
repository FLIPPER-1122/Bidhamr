# Noter til advokaten – samlet liste over åbne spørgsmål

> UDKAST – til mødet med advokaten. Skrevet 6. oktober 2026 ud fra `jura/brugerbetingelser-udkast.md`, `jura/privatlivspolitik-udkast.md` og `ROADMAP-BESLUTNINGER.md`. Opdateret samme dag med: Vercel-region i EU (dub1), GPS fjernes fra sags- og pakkebilleder, gemt accept af brugerbetingelser, daglig oprydning af IP-tællere, og pause/annullering af skjulte og fjernede auktioner (spm. 21, 34, 45, 46 og 52).
> Henvisninger i parentes: **B** = brugerbetingelser (afsnitsnummer), **P** = privatlivspolitik (afsnitsnummer), **RB** = ROADMAP-BESLUTNINGER.md.

## Kort om BidHamr (til advokaten)

- C2C-auktionsplatform: kun privatpersoner sælger til privatpersoner. BidHamr er formidler, ikke sælger.
- Gebyrer: 5 % for køber og 5 % for sælger af buddet. Frivilligt tilkøb for køber: "BidHamr Beskyttelse" (5 % af buddet, min. 25 / maks. 250 kr). Fragt betales af køber (i dag fast 35 kr, som går til fragtfirmaet). Alle beløb inkl. moms.
- Betaling via Stripe Connect, "separate charges and transfers": køber betaler til BidHamrs platformskonto hos Stripe. Beløbet holdes, til handlen er afsluttet (køber godkender, 48 timer uden sag, eller sag afgjort + 4 dages ankefrist), og overføres så minus sælgergebyr til sælgers Stripe Express-konto. BidHamr har ingen saldo/wallet.
- Sager med frosne penge, anke, advarsler (3 = lukning, altid godkendt af en medarbejder) og DSA-anmeldelse/begrundelse/klage er bygget.
- Database (Supabase) og serverkode (Vercel, region dub1) kører i EU (Irland). Leverandørerne er amerikanske virksomheder.

---

## 1. Betaling, Stripe og tilladelser

1. **Tilladelse ved tilbageholdelse af penge.** Stripe har svaret: "separate charges and transfers" er understøttet i Danmark, og beløb kan holdes i op til 90 dage. Stripe siger samtidig, at det skal afklares med en rådgiver, om BidHamr skal have tilladelse (betalingstjeneste/e-penge), og foreslår at overveje "funds segregation". Kræver BidHamrs opsætning tilladelse fra Finanstilsynet, eller er BidHamr dækket af Stripe (fx undtagelsen for handelsagenter)? Hvad skal "funds segregation" konkret indebære? (B 6, RB øverst)
2. **Formuleringen om pengene.** Forretningsreglen er, at teksterne aldrig må sige, at BidHamr modtager, opbevarer eller holder pengene – "betalingen håndteres af vores betalingspartner Stripe". Teknisk lander betalingen på BidHamrs platformskonto hos Stripe. Er formuleringen korrekt og ikke vildledende? (B 6.1, 6.5)
3. **Hvidvaskloven.** Gælder den for BidHamr (kundekendskab ved store beløb), eller dækker Stripes kontrol det? (ROADMAP fase 0)
4. **Stripes betingelser.** Sælgere skal acceptere Stripes Connected Account Agreement, når de opretter udbetalingskonto. Skal det stå på en bestemt måde i vores betingelser? (B 3.7)
5. **Chargeback efter udbetaling.** BidHamr bærer selv tabet og trækker aldrig penge tilbage fra sælger. Skal betingelserne sige noget mere om det (fx mod køberen)? (B 15)

## 2. Forbrugerret og handelsbetingelser

6. **Kun private sælgere.** Er det nok at forbyde erhvervsmæssigt salg i betingelserne? Skal sælger erklære at være privat ved oprettelse af auktion, og skal hver auktion vise, at sælger er privatperson (Omnibus/markedsføringsloven)? Hvad gør vi med brugere, der reelt handler erhvervsmæssigt? (B 2.3, ROADMAP fase 6)
7. **Købers rettigheder over for en privat sælger.** Skabelonen skrev "ingen 2 års reklamationsret". Hvad må vi skrive om købeloven (mangler, frister, "købt som beset")? Vi har bevidst ikke nævnt frister. (B 2.4)
8. **BidHamrs sagsafgørelser og købeloven.** Er det korrekt at skrive, at sagsafgørelser kun bestemmer, hvad der sker med betalingen på BidHamr, og ikke ændrer parternes rettigheder efter loven? (B 2.5, 13.6)
9. **Hvornår er købsaftalen indgået** (ved auktionens slutning)? Skal det stå i betingelserne? (B 4)
10. **Gebyrer og BidHamr Beskyttelse over for forbrugere.** Hvilke forbrugerregler gælder for BidHamrs egne ydelser (oplysningspligt, prisoplysning, fortrydelsesret på selve ydelsen)? Opfylder visningen af totalpris før buddet kravene? (B 5, ROADMAP fase 6)
11. **Ubetalt vinder.** Bud er bindende. Kan sælger kræve erstatning? Kan BidHamr give advarsel/lukke konto pga. manglende betaling? (B 7)
12. **Ikke-afhentet pakke.** Køber får købsbeløbet minus gebyrer og fragt begge veje. Er det rimeligt over for forbrugere, og hvilke gebyrer skal præciseres? (B 11, RB 1)
13. **Hjælp kun med BidHamr Beskyttelse.** Uden Beskyttelse hjælper BidHamr ikke med skadede varer eller varer, der ikke er som beskrevet. Er det rimeligt? Og reglen "står det ord mod ord, og viser sporingen levering, får sælger pengene"? (B 12.4, 12.7)
14. **Platformens pligt ved svindel.** Har BidHamr pligt til at gribe ind ved åbenlys svindel, uanset betingelserne? (B 12, RB 4 NOTE, ROADMAP fase 6)
15. **BidHamr Beskyttelse – forsikring eller garanti?** Kan ydelsen blive anset som et forsikringsprodukt (lov om forsikringsdistribution/finansiel virksomhed) eller en garanti? Hvordan beskrives den, så den ikke bliver det? Er det rimeligt, at prisen ikke refunderes ved medhold ("ydelsen er brugt")? (B 14)
16. **Ansvarsbegrænsning.** Skabelonens "under ingen omstændigheder ansvarlig" er fjernet. Foreslået: ansvar begrænset til de gebyrer og den Beskyttelse, der er betalt for handlen, undtagen grov uagtsomhed/forsæt. Gyldigt over for forbrugere? Indirekte tab? (B 23.5)
17. **Ægte bedømmelser.** Er det nok at oplyse, at kun købere efter en gennemført handel kan bedømme (Omnibus)? (B 16)
18. **Rangering.** Opfylder beskrivelsen af sortering kravet om at oplyse de vigtigste parametre? (B 24)
19. **Brugernes billeder i markedsføring.** Må BidHamr bruge auktionsbilleder i egen markedsføring (fx sociale medier), og kræver det samtykke? (B 22.3)
20. **Lukket konto.** Hvad skal der ske med en lukket brugers igangværende auktioner, handler og ventende udbetalinger? (B 20.5)
21. **Accept og ændring af betingelserne.** Nye brugere skal sætte flueben ved oprettelse; vi gemmer version og tidspunkt for accept (`users.vilkaar_version`, `users.vilkaar_accepteret_kl` – tidspunktet sættes af databasen). Eksisterende brugere ser en bjælke på Min konto og kan acceptere der, men det blokerer ikke noget endnu. Ved lancering kan accept gøres påkrævet, før man kan byde eller oprette en auktion. Er det nok som dokumentation for aftalen? 30 dages varsel ved væsentlige ændringer; igangværende bud følger de gamle betingelser. Rigtig overgangsregel? Hvordan skal accept af nye betingelser ske? (B 1.3, 25, RB "Accept af brugerbetingelser")
22. **Lukning af BidHamr.** Hvilket varsel, og hvad med igangværende handler? (B 26.5)
23. **Klageadgang.** Er henvisningen til Forbrugerklagenævnet (kun for BidHamrs egne ydelser) korrekt? EU's ODR-platform er lukket i juli 2025, så den er udeladt – bekræft. Bekræft, at handler mellem to private ikke hører under Forbrugerklagenævnet. (B 28.4, ROADMAP fase 6)
24. **Værneting og lovvalg.** Dansk ret og danske domstole; forbrugere kan sagsøge ved eget hjemting. Formulering? (B 28.5)
25. **Firmaoplysninger** (e-handelsloven): navn, adresse, CVR og e-mail i betingelser og sidefod – nok? (B 1.2, ROADMAP fase 6)
26. **Aldersgrænse.** 18 år (følger af MitID og bindende bud). Rigtig grænse? Hvad med 15–17-årige med MitID? (B 3.1, ROADMAP fase 6)
27. **Tilgængelighedsloven** (European Accessibility Act): er BidHamr som mikrovirksomhed undtaget? (ROADMAP fase 6)

## 3. DSA (forordning om digitale tjenester)

Alt i RB-afsnittet "DSA" er Claudes forslag og afventer advokatens godkendelse. Konkrete spørgsmål:

28. **Omfang.** Hvilke regler gælder for BidHamr som mikro-/lille virksomhed? Art. 16–17 (anmeldelse og begrundelse) gælder alle hostingtjenester. Art. 20–28 (bl.a. klagesystem og udenretslig tvistbilæggelse) og art. 15/24 (gennemsigtighedsrapport) er efter art. 19 og 15(2) undtaget for mikro- og små virksomheder. Skal vi beholde det byggede frivilligt, og skal betingelserne så love det? (B 21)
29. **Anmeldelsesformularen (art. 16).** Opfylder den kravene: kategorier, begrundelse 10–2000 tegn, navn og e-mail (ikke ved misbrug af børn), erklæring om god tro, placering udfyldt af serveren?
30. **Spamværn og lofter.** Er lofterne for anmeldelser (pr. IP, e-mail, bruger, døgn og fælles lofter) forenelige med retten til at anmelde? Er det i orden, at anmeldere uden login altid får samme svar, og at der ikke oprettes en sag, når anmelderens e-mail tilhører ejeren af indholdet?
31. **Frister.** Interne frister: anmeldelser 7 dage (24 timer ved misbrug af børn og hadefuld tale), klager 14 dage. Opfylder det "rettidigt" og "uden unødig forsinkelse"?
32. **Begrundelse (art. 17).** Indeholder mailen det, den skal? Er lovhenvisningerne i regel-listen rigtige (fx straffeloven § 279, §§ 266 og 266 b, § 235, våbenloven, varemærkeloven, ophavsretsloven, dyrevelfærdsloven)? Se `src/lib/dsa/regler.ts`.
33. **Forbudte-varer-filteret.** Varer, som filteret blokerer ved oprettelse, bliver aldrig offentliggjort og registreres ikke som en afgørelse – sælger får kun en fejlbesked. Kræver det alligevel en begrundelse efter art. 17?
34. **Klage (art. 20) og auktioner på pause.** 6 måneders frist, ét klagetrin, behandles af en anden medarbejder, medhold ophæver indgrebet. For auktioner gælder nu (Filips beslutninger 6. oktober 2026): en skjult auktion sættes på pause (uret stopper, ingen kan byde, buddene gælder stadig); vises den igen, fortsætter den med den resterende tid, dog mindst 24 timer; efter 14 dage på pause annulleres den automatisk; en fjernet auktion annulleres og genåbnes aldrig – heller ikke ved medhold i en klage – men sælgeren kan sætte varen op igen. Spørgsmål: (a) Er det foreneligt med art. 20(4), at medhold over en fjernet eller annulleret auktion ikke genåbner den? (b) Er det rimeligt over for bydere, at deres bud er bindende under en pause, og over for sælgeren, at auktionen annulleres efter 14 dage, selvom klagefristen er 6 måneder? (B 20.7, 21.5)
35. **Udenretslig tvistbilæggelse (art. 21).** Skal vi henvise til et certificeret organ – og hvilket? (B 21.7)
36. **Misbrug (art. 23).** Skal reglen om at stoppe behandling af åbenlyst grundløse anmeldelser/klager med i betingelserne, og hvordan? (B 21.6)
37. **Underretning af politiet (art. 18).** Hvornår har vi pligt til at underrette politiet, og hvem?
38. **Beskrivelse af moderation i betingelserne (art. 14).** Er afsnit 21.3 nok om automatiske filtre og menneskelig vurdering?
39. **Persondata i DSA-sager.** Anmelderens navn, e-mail, konto-kobling og fritekst anonymiseres 12 måneder efter afgørelsen; begrundelser og statistik gemmes permanent. I orden?
40. **Kontaktpunkt (art. 11–12).** dsa@bidhamr.dk på `/dsa`, på dansk og engelsk. Nok?
41. **Erhvervsdrivende sælgere (art. 30–31).** Gælder sporbarhedskravene ikke, så længe kun private må sælge? (se også spm. 6)

## 4. Persondata (GDPR)

42. **Databeskyttelsesrådgiver (DPO).** Skal BidHamr have en? (P 2)
43. **Retsgrundlag.** Bekræft især: legitim interesse for svindelforebyggelse og for at medarbejdere kan læse beskeder i handler; litra c for DSA-behandling; om push-beskeder kræver samtykke; aftale/legitim interesse for at gemme version og tidspunkt for accept af brugerbetingelserne. (P 4)
44. **Venteliste.** Samtykke eller legitim interesse – og må listen bruges til nyheder ved lancering? (P 3.7, 4)
45. **Automatiske beslutninger (art. 22).** Filtre, automatisk annullering ved overskredne frister, automatisk frigivelse og automatisk annullering af en auktion efter 14 dage på pause – er nogen af dem omfattet? (P 4)
46. **Opbevaring.** Forretningsreglen er, at handelsdata, samtaler med BidHamr, kontakthenvendelser, rapporter, advarsler og begrundelser "slettes aldrig". Bogføringsloven kræver 5 år efter regnskabsårets udløb. Hvor længe må vi gemme de enkelte typer, og skal vi bygge automatisk sletning/anonymisering? Gælder også version og tidspunkt for accept af brugerbetingelserne: foreslået så længe kontoen findes og derefter som dokumentation for brugerens handler. IP-tællere (login og anti-spam) slettes nu af et dagligt oprydningsjob efter ca. et døgn. (P 8)
47. **Bedømmelser efter sletning.** Bedømmelser bevares som fra "Slettet bruger". I orden? (P 9)
48. **MitID.** Hvilke oplysninger fra MitID (via Criipto) må vi gemme for at forhindre, at en lukket bruger opretter en ny konto? Må vi gemme en hash af CPR eller et MitID-id? (P 3.10)
49. **DAC7.** Bekræft grænserne (30 salg / 2.000 euro), hvilke oplysninger vi skal indsamle, hvordan sælgerne skal informeres, og hvor længe oplysningerne skal gemmes. Skal revisor også inddrages? (P 5, ROADMAP fase 6)
50. **Stripes rolle.** For hvilke dele er Stripe databehandler, og for hvilke selvstændigt dataansvarlig (KYC, svindel, hvidvask)? (P 6.4)
51. **Apple og Google** (push): databehandlere eller selvstændigt dataansvarlige? (P 6.3)
52. **Overførsel til USA.** Supabase, Vercel, Resend, Expo og Stripe er amerikanske virksomheder. Database (Supabase, eu-west-1) og serverkode (Vercel, region dub1 i Dublin) kører nu i EU, men overførsel eller adgang fra USA kan stadig forekomme (support, drift, logs og evt. Vercels globale netværk). Bekræft grundlaget pr. leverandør (EU-US Data Privacy Framework eller standardkontraktbestemmelser), og om vi skal lave en overførselsvurdering (TIA). (P 6.3, 7)
53. **Databehandleraftaler.** Bekræft, at standardaftalerne fra Supabase, Vercel, Resend, Expo (og senere GLS/Shipmondo, Criipto, Dinero) er tilstrækkelige. (P 6.3, ROADMAP fase 6)
54. **Nødvendige cookies.** Må disse regnes som nødvendige (intet samtykke): `bh_enhed` (genkendelse af enhed til mail ved nyt login, 400 dage), kladden til auktioner i local storage, og Stripes svindel-cookies `__stripe_mid`/`__stripe_sid`? (RAPPORT 6. okt., `/cookies`)

## 5. Til revisor (ikke advokat, men samme møde-runde)

- Moms på fragten: fragten (i dag 35 kr) betales af køber, bliver hos BidHamr og går videre til fragtfirmaet. Er det BidHamrs egen momspligtige ydelse?
- Regnskabsprogram (Dinero?) og automatisk fakturering af gebyrer og BidHamr Beskyttelse.
- DAC7-indberetning i praksis (se spm. 49).

---

**I alt: 54 spørgsmål til advokaten** (27 om betaling og handelsbetingelser, 14 om DSA, 13 om persondata) + 3 punkter til revisor.
