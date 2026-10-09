# Noter til advokaten – samlet liste over åbne spørgsmål

> **VIGTIGSTE SPØRGSMÅL (8. okt. 2026) – tag det først:** BidHamr vil bygge betalingen om, så købers penge ALDRIG står på BidHamrs egen Stripe-saldo. I stedet sker betalingen *på sælgerens vegne* (Stripe Connect, `on_behalf_of`/destination charge): pengene lander direkte på sælgerens egen Stripe-konto (en Express-konto, som Stripe har identitetstjekket), BidHamrs gebyr trækkes fra med det samme, og sælgerens konto står på *manuel udbetaling*, så pengene først kan udbetales til sælgers bank, når handlen er afsluttet (eller refunderes til køberen ved en sag/fortrydelse). **Fjerner den model kravet om tilladelse som betalingsinstitut/e-pengeinstitut (spørgsmål 76–77)?** Hvem hæfter ved en dispute, når sælgerens Stripe-konto er tom? Hvad skal stå i vilkårene?


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
55. **Cookie-banner: eget eller Cookiebot?** BidHamr har sit eget cookie-banner: "Accepter alle" og "Kun nødvendige" er lige store, intet er forvalgt, valget gemmes i 12 måneder i cookien `bh_samtykke` (kun i brugerens browser, ikke en central log), og man kan altid ændre det via "Cookieindstillinger" i footeren. I dag bruges kun nødvendige cookies. Er vores eget banner nok, eller anbefales et certificeret værktøj som Cookiebot (pris ca. 100-400 kr./md.) med automatisk cookie-scanning og central dokumentation af samtykker – nu eller først, når vi tager statistik- eller marketingværktøjer i brug? (`/cookies`, `src/components/samtykke/CookieBanner.tsx`)

## 5. Til revisor (ikke advokat, men samme møde-runde)

- Moms på fragten: fragten (i dag 35 kr) betales af køber, bliver hos BidHamr og går videre til fragtfirmaet. Er det BidHamrs egen momspligtige ydelse?
- Regnskabsprogram (Dinero?) og automatisk fakturering af gebyrer og BidHamr Beskyttelse.
- DAC7-indberetning i praksis (se spm. 49).

---

**I alt: 55 spørgsmål til advokaten** (27 om betaling og handelsbetingelser, 14 om DSA, 14 om persondata og cookies) + 3 punkter til revisor.

## Erhvervskonti (fase 7, besluttet 7. okt. 2026 – se ROADMAP-BESLUTNINGER.md "Erhvervskonti" og ERHVERV-OVERBLIK.md)

Kort om modellen: kun firmaer med aktivt dansk CVR, månedligt abonnement (aktiveres af BidHamr efter et møde), kun auktion, erhverv må sælge nye varer, erhverv kan ikke købe, ingen BidHamr Beskyttelse ved køb fra erhverv, BidHamr håndterer fortrydelse i appen, og erhvervssælgeren får først udbetalt efter fortrydelsesfristen.

56. **Fortrydelsesret ved netauktion.** Bekræft, at undtagelsen for "offentlig auktion" (forbrugeraftaleloven § 18, stk. 2, nr. 11) ikke gælder BidHamr, så forbrugere har 14 dages fortrydelsesret ved køb fra erhvervssælgere.
57. **Refusion ved fortrydelse.** Skal BidHamrs købergebyr og fragt refunderes, når en køber fortryder et erhvervskøb (accessoriske aftaler)? Hvem bærer omkostningen – BidHamr eller sælger?
58. **Fortrydelse af BidHamrs egne tjenester.** Har forbrugeren 14 dages fortrydelsesret over for BidHamrs gebyr og BidHamr Beskyttelse – også ved køb fra private?
59. **Mærkning af private sælgere.** Hvordan skal mærkningen formuleres, så BidHamr ikke anses som sælger efter købeloven § 4 a, stk. 2? (Gælder allerede nu, før erhverv.)
60. **DSA art. 30–32.** Er BidHamr undtaget efter art. 29 (mikro/lille virksomhed), og fra hvornår gælder kravene, hvis vi vokser?
61. **Produktsikkerhed (GPSR).** Hvilke pligter har BidHamr som markedsplads (kontaktpunkt, Safety Gate, felter ved oprettelse), når erhverv sælger nye og brugte varer?
62. **Ingen BidHamr Beskyttelse ved erhverv.** Vi tilbyder ikke BidHamr Beskyttelse ved køb fra erhverv, fordi køberen har lovens rettigheder. Er det i orden, og hvordan forklarer vi det uden at vildlede?
63. **Ansvar ved reklamation.** Har BidHamr noget ansvar ved reklamation (2 år), hvis erhvervssælgeren ikke betaler eller er gået konkurs, og pengene er udbetalt? Vi hjælper kun med kontaktoplysninger.
64. **Oplysninger før buddet.** Hvilke oplysninger skal erhvervssælgeren vise, og er det nok med mærket "Erhvervssælger" og ét klik til profilen?
65. **Dødsboer og bobestyrere.** Skal de oprettes som erhverv, når de sælger på BidHamr?
66. **Private, der sælger fra et firma.** Reglen er: sælger du fra et firma, skal du oprette dig som erhverv. Må vi lukke en privat konto, der i virkeligheden sælger som firma, og skal vi aktivt kontrollere det?
67. **Faktura og brugtmoms.** Skal erhvervssælgere kunne udstede faktura gennem BidHamr, og hvad kræver brugtmomsordningen af faktura og prisvisning?
68. **Klageoplysning.** Hvilke krav gælder for henvisning til Nævnenes Hus nu, hvor EU's ODR-platform er lukket – for BidHamr og for erhvervssælgerne?
69. **Vilkår for erhverv.** Skal brugerbetingelserne have et særskilt afsnit for erhvervssælgere (pligter, ansvar, skadesløsholdelse af BidHamr, abonnement og opsigelse)?
70. **Producentansvar.** Har BidHamr producentansvar (elektronik, batterier, emballage), når erhverv sælger nye varer?
71. **DAC7 for erhverv.** Skal vi indsamle momsnummer og fast forretningssted, og må vi stole på Stripes indsamling?
72. **Abonnementet.** Hvad skal abonnementsvilkårene indeholde (binding, opsigelse, prisændring, grænse på antal auktioner pr. uge og tilkøb)?
73. **Mindstepris/reserve.** Må erhvervssælgere sætte mindstepris på auktioner, og skal det oplyses særskilt over for forbrugere?
74. **Opbevaring af erhvervshenvendelser.** Formularen på /erhverv gemmer kontaktperson, telefon, e-mail, adresse og besked. Afviste og arkiverede henvendelser, der ikke blev til en firmakonto, anonymiseres automatisk 12 måneder efter sidste behandling (firmanavn, CVR, status og datoer bevares). Er 12 måneder passende efter GDPR art. 5, stk. 1, litra e, eller skal det være kortere/længere? Skal det stå i privatlivspolitikken?
75. **Telefonnummer.** Skal BidHamr oplyse et telefonnummer over for forbrugere (forbrugeraftaleloven § 8 efter Omnibus-direktivet / e-handelsloven § 7), eller er e-mail og kontaktformular nok? Og skal erhvervssælgere på BidHamr oplyse telefonnummer til købere? I dag viser firmaprofilen firmaets telefonnummer, men BidHamr selv har kun e-mail (support@ og erhverv@). Filip har et andet arbejde i hverdagene: er det nok med en kort telefontid (fx hverdage kl. 17–18 eller lørdag) og ellers telefonsvarer med opkald tilbage inden for 1–2 hverdage?

## Fra Niels' gennemgang af betalingsdelen (Ankerdigital, 8. okt. 2026)

Sådan virker koden i dag: Stripe Connect, "separate charges and transfers". Køberen betaler til BidHamrs egen Stripe-konto (platformskontoen) uden `on_behalf_of`, så BidHamr står som sælger over for kortnetværket. Købers penge står på BidHamrs Stripe-saldo sammen med BidHamrs egne, til handlen er afsluttet (typisk 19–32 dage; ved afhentning frigives de med det samme). Ved frigivelse overføres buddet minus 5 % til sælgerens Express-konto, og Stripe udbetaler derfra til sælgerens bank. Ved en dispute trækker Stripe beløbet fra BidHamrs saldo. Fem tilstande har ingen øvre tidsgrænse: åben sag, anke, ventende retur, åben dispute og penge til en sælger uden konto. Stripe har oplyst, at pengene må holdes i op til 90 dage.

76. **Tilladelse.** Kræver det en tilladelse (fx betalingsinstitut eller e-pengeinstitut), at BidHamr holder købers penge på sin egen Stripe-saldo, til handlen er afsluttet?
77. **Alternativer.** Ændrer svaret sig, hvis pengene holdes adskilt fra BidHamrs egne (Stripes "funds segregation" – dækker kun kort, ikke MobilePay), hvis betalingen sker på sælgerens vegne (`on_behalf_of`), eller hvis den går direkte til sælgerens konto?
78. **Hvor længe må pengene stå?** Og hvad skal der ske med sager, anker og disputes uden slutdato?
79. **Dække en dispute.** Må BidHamr midlertidigt dække en dispute med sælgernes penge på saldoen, eller skal der altid stå egne midler som reserve?
80. **Hvidvask.** Skal BidHamr selv kende og kontrollere sine sælgere, eller er Stripes identitetskontrol nok?
81. **Formuleringen om Stripe.** Hjemmesiden skriver "betalingen håndteres af vores betalingspartner Stripe" (og internt: "Stripe holder pengene"). Er den formulering dækkende, når pengene står på BidHamrs Stripe-saldo?
82. **Disputes efter udbetaling.** BidHamr bærer tabet ved disputes efter udbetaling. Kan BidHamr kræve beløbet tilbage fra sælgeren, og hvad skal der stå i sælgervilkårene?
83. **Afhentning.** Afhentning frigiver pengene med det samme, uden klagefrist. Hvad skal vilkårene sige om det?
84. **Ikke-betalende vinder.** Bud er bindende, men der betales først efter auktionen. En køber, der ikke betaler, kan få kontoen lukket permanent. Kan det håndhæves, og hvordan skal det stå?
85. **Beskyttelse, sager og anke i betingelserne.** Fx at refusion efter en vundet sag sker uden BidHamr Beskyttelse (gebyret for Beskyttelse refunderes ikke).
86. **Databehandleraftaler** med Supabase, Stripe, Vercel og Resend.
87. **Opbevaring af beviser.** Sletning af brugere og opbevaringstid – også for chatbeskeder og billeder, der bruges som bevis i sager.

### Til revisor
88. **Moms** på købergebyr, sælgergebyr, fragt og BidHamr Beskyttelse. Der er ingen momslogik i koden i dag (undtagen erhvervsabonnementet: 25 % oven i).
89. **Bogføring.** Sælgernes penge på saldoen er ikke omsætning. Hvordan bogføres de, gebyrerne, Stripes gebyrer og tab på disputes?

## Den nye betalingsmodel (pengene på sælgerens Stripe Connect-konto) – spørgsmål fra planen 8. okt. 2026

90. **Kontrol over frigivelsen.** Pengene står på sælgerens egen Stripe-konto, men det er BidHamr, der bestemmer, hvornår de udbetales til sælgerens bank og hvornår de refunderes. Er BidHamr så fri for kravet om tilladelse (nr. 76–77), eller kan kontrollen over frigivelsen i sig selv kræve tilladelse?
91. **Sælgeren som "forretning" over for kortnetværket.** Med betaling på sælgerens vegne står sælgeren (også en privatperson) formelt som forretning for HELE beløbet, inkl. købergebyr, fragt og BidHamr Beskyttelse. Hvordan skal det beskrives over for køberen, og passer det med, at BidHamr Beskyttelse er BidHamrs ydelse?
92. **Hæftelse.** Ved denne model (Express-konti) hæfter BidHamr over for Stripe, hvis sælgerens Stripe-konto går i minus (fx dispute efter udbetaling). Kan BidHamr kræve beløbet af sælgeren, og hvad skal stå i vilkårene?

### Til revisor
93. **Moms på gebyrer som "application fee".** BidHamrs omsætning er gebyrerne, der trækkes fra betalingen. Hvem er kunden for købergebyret, når sælgeren står som forretning for hele beløbet – køber eller sælger? Hvem skal BidHamrs faktura stiles til?
94. **Momsregistrerede erhvervssælgere.** Skal de opgøre moms af hele beløbet (inkl. købergebyr og fragt), når de står som forretning? Alternativet er to betalinger (varen til sælgeren + gebyrerne til BidHamr), som er en dårligere oplevelse for køberen.

95. **Faktura på varen ved firmasalg (til revisor).** Når et firma (erhvervskonto) sælger en vare til en forbruger på BidHamr, skal køberen have en faktura på varen med firmaets navn, CVR og moms. Hvem skal lave den: må/skal BidHamr udstede fakturaen automatisk på firmaets vegne (selvfakturering/fakturering på vegne af – kræver det en aftale med firmaet?), eller skal firmaet selv sende den fra sit eget regnskabsprogram? Hvad skal fakturaen indeholde, og hvordan spiller det sammen med brugtmomsordningen (nr. 67) og med, at alle BidHamrs gebyrer er inkl. moms og faktureres separat til både køber og sælger?


## Fakturaer på BidHamrs ydelser i Dinero – spørgsmål til revisor (9. okt. 2026)

Bygget i Dineros testregnskab (docs/FAKTURA.md). BidHamr laver ved hver betaling en faktura til køberen (købergebyr, fragt, BidHamr Beskyttelse) og en til sælgeren (sælgergebyr), alle inkl. 25 % moms, og en kreditnota ved refusion.

96. **Tidspunktet.** Fakturaen dateres og bogføres på betalingsdagen (når BidHamrs gebyr er trukket hos Stripe), og en refusion giver en kreditnota. Vi har valgt det, fordi momsen efter vores forståelse forfalder ved modtagelsen af en forudbetaling (momsloven § 23, stk. 3). Er det korrekt – eller skal fakturaen først laves, når handlen er afsluttet (pengene udbetalt til sælger)? Hvad med fragten, som leveres efter betalingen?
97. **Hvem er kunden for købergebyr, fragt og BidHamr Beskyttelse** (se også nr. 93): fakturaen stiles i dag til køberen, selv om Stripe formelt trækker gebyret fra sælgerens Stripe-konto (application fee). Er det rigtigt, eller skal hele gebyret faktureres til sælgeren?
98. **BidHamr Beskyttelse er momspligtig** (Filip: alle BidHamrs ydelser er momspligtige; BidHamr Beskyttelse er BidHamrs egen ydelse – BidHamr hjælper med sagen, hvis varen går i stykker under forsendelsen). Er det korrekt – og må BidHamr beholde den uden kreditnota, når køberen får medhold i en sag og refunderes alt andet?
99. **Erhvervsabonnementet** faktureres af Stripe Billing (Stripes faktura med moms og firmaets CVR). Vi bogfører den betalte Stripe-faktura som et finansbilag i Dinero (Stripe-PDF'en vedhæftet) i stedet for at lave en ny faktura i Dinero, så firmaet ikke får to fakturaer med moms for samme ydelse. Er det korrekt bogføring? Refunderes en abonnementsfaktura, laver vi en modpostering i Dinero – skal firmaet også have en kreditnota (fra Stripe)?
100. **Konto for Stripe.** Betalingerne registreres i Dinero på en likvid konto. Pengene står på BidHamrs Stripe-saldo, indtil Stripe udbetaler til banken. Skal der være en egen "Stripe"-konto (og hvordan bogføres Stripes gebyrer og udbetalingerne fra Stripe til banken)? Se også nr. 89.
101. **Tabt indsigelse (chargeback).** Taber BidHamr en indsigelse, får køberen hele beløbet tilbage gennem sin bank, og BidHamrs gebyr er reelt tabt. Vi laver IKKE automatisk en kreditnota i det tilfælde. Skal der laves en kreditnota (momsen tilbage), eller bogføres det som et tab?
102. **Private kunders oplysninger.** Fakturaen til private har navn og e-mail (adresse kun over 3.000 kr., hvis vi har den). Er en forenklet faktura nok under 3.000 kr., og hvad gør vi over 3.000 kr., hvis vi ikke har adressen? Fakturaen gemmes i 5 år (bogføringsloven), også hvis brugeren sletter sin konto – skal det stå i privatlivspolitikken?
103. **Er Dinero et registreret digitalt bogføringssystem**, og er det i orden, at fakturaerne laves automatisk via Dineros API (personlig integration) og vises/hentes som PDF på BidHamr? (ROADMAP fase 1: Filips spørgsmål til revisor.)
