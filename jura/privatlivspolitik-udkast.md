# UDKAST – skal godkendes af advokat

# Privatlivspolitik for BidHamr

> **Til Filip og advokaten (fjernes, før siden går live):**
> - Udkastet er skrevet ud fra Filips skabelon (`jura/privatlivspolitik-skabelon.md`), `ROADMAP-BESLUTNINGER.md` og en gennemgang af koden og databasen pr. 6. oktober 2026 (`src/`, `supabase/migrations/`, `src/lib/tekster/sider/cookies.ts` og navnene på miljøvariablerne – ingen værdier er læst ud).
> - Opdateret 6. oktober 2026 med dagens ændringer: serverkoden hos Vercel kører i EU (dub1, Dublin), skjulte oplysninger (fx GPS) fjernes nu også fra billeder i sager og fra pakkebilleder, accept af brugerbetingelserne gemmes (version og tidspunkt), og IP-tællerne ryddes af et dagligt oprydningsjob.
> - Politikken beskriver, hvad BidHamr gør **i dag**. MitID (Idura) er bygget (afsnit 3.10) - testmiljø, indtil Filip har en produktionsaftale. Ting, der ikke er bygget endnu (fragtfirma, regnskabsprogram, DAC7-indsamling), står som markerede afsnit, der skal rettes, når de er i drift.
> - `[TODO Filip: …]` = oplysninger eller tjek, Filip skal lave. `[ADVOKAT: …]` = juridiske spørgsmål. Alle spørgsmål er samlet i `jura/noter-til-advokat.md`.
> - Siden skal ligge på `/privatliv` (linket findes allerede i footeren).

**Version:** udkast 2 · **Senest opdateret:** [TODO Filip: dato ved offentliggørelse]

---

## 1. Kort fortalt

- Vi bruger dine oplysninger til at drive BidHamr: din konto, dine auktioner, bud og handler, og til at hjælpe, når noget går galt.
- Din e-mail, dit telefonnummer og din adresse vises aldrig offentligt. Andre ser dit navn, dit profilbillede, dine auktioner og dine bedømmelser.
- Betalingen håndteres af vores betalingspartner Stripe. Vi ser eller gemmer aldrig dine kortoplysninger.
- Vi bruger ingen cookies til statistik eller reklame, og vi sælger aldrig dine oplysninger.
- Handelsdata gemmer vi, fordi loven kræver det – også hvis du sletter din konto.
- Du kan selv hente alle dine data og slette din konto under Min konto.

---

## 2. Hvem er dataansvarlig?

Dataansvarlig for behandlingen af dine personoplysninger på bidhamr.dk og i BidHamr-appen er:

- [TODO Filip: firmanavn]
- CVR-nr.: [TODO Filip: CVR-nummer]
- Adresse: [TODO Filip: adresse]
- E-mail: support@bidhamr.dk [TODO Filip: overvej en særskilt adresse, fx privatliv@bidhamr.dk]

[ADVOKAT: Skal BidHamr have en databeskyttelsesrådgiver (DPO)? Vi antager nej, men vurdér det i lyset af svindelforebyggelse og moderation.]

---

## 3. Hvilke oplysninger behandler vi?

### 3.1 Din konto

- **Navn og e-mail**, når du opretter en konto. Din adgangskode gemmes kun krypteret (som en hash) hos vores leverandør Supabase – vi kan ikke se den.
- **Accept af brugerbetingelserne**: når du opretter en konto, gemmer vi, hvilken version af brugerbetingelserne du har accepteret, og hvornår. Har du accepteret senere (fx via bjælken på Min konto), gemmer vi det tidspunkt.
- **Telefonnummer og adresse til afhentning**, hvis du selv skriver dem under Min konto (frivilligt).
- **Profilbillede**, hvis du lægger et op.
- **Sikkerhedskode ved oprettelse**: når du opretter en konto, sender vi en 6-cifret kode til din e-mail for at bekræfte, at e-mailen er din. Koden gemmes kun i kort tid (højst 1 time) hos Supabase.
- **Kontostatus**: fx om din e-mail er bekræftet, om kontoen er suspenderet eller lukket, og din rolle (bruger eller medarbejder).
- **Udbetalingskonto**: hvis du sælger, gemmer vi id'et på din udbetalingskonto hos Stripe og status for den (fx om Stripe har godkendt dine oplysninger). Selve dine oplysninger til Stripe (fx ID og bankkonto) giver du direkte til Stripe.
- **Gemt kort (tilvalg)**: hvis du gemmer et kort, gemmer vi kun kortets mærke, de sidste 4 cifre og udløbsdatoen, så du kan genkende det. Selve kortet ligger hos Stripe. Har du tidligere slået automatisk betaling til (findes ikke længere), gemmer vi fortsat, hvornår du sagde ja, hvilken version af teksten du så, og hvornår det blev slået fra – som dokumentation for de betalinger, der blev lavet. [ADVOKAT: Er det et gyldigt grundlag at gemme denne samtykkehistorik (art. 6, stk. 1, litra c/f), og hvor længe må den gemmes?]

### 3.2 Auktioner, bud og handler

- **Auktioner**: titel, beskrivelse, billeder, stand, kategori, startpris, postnummer og by, og om varen kan sendes eller hentes. Auktioner er offentlige.
- **Bud**: beløb og tidspunkt. Andre brugere ser ikke, hvem der har budt – i budhistorikken står bydere uden navn (fx "Byder 3"). [TODO Filip: bekræft, at migrationen `20261001035000_privatliv_bud_foelgere.sql` er kørt i produktion, når appen er tilpasset. Indtil da kan appen læse andres bud direkte.]
- **Handler og betalinger**: hvem der er køber og sælger, beløb (bud, gebyrer, fragt, BidHamr Beskyttelse, udbetaling), status, frister og tidspunkter. Vi får besked fra Stripe om betalinger, refusioner, udbetalinger og indsigelser fra din bank.
- **Forsendelse og afhentning**: sporingsnummer, status fra fragtfirmaet og fragtlabel. Ved afhentning gemmer vi afhentningskoden (og forkerte forsøg) og fristen.
- **Pakkebilleder**: billeder, sælgeren tager af indpakningen, når pakken sendes.
- **Sager og anker**: hvad sagen handler om, begrundelser, billeder og dokumentation, du uploader, afgørelser og interne noter fra vores medarbejdere.
- **Bedømmelser**: stjerner, kommentar og sælgerens svar. Bedømmelser er offentlige.
- **Statistik for dig**: fx antal auktioner, salg og indtjening, som du kan se på din profil.

### 3.3 Beskeder

- **Chat i handler** mellem køber og sælger.
- **Spørgsmål og svar** på auktioner ("Spørg sælger"). De kan være synlige for andre.
- **Samtaler med BidHamr** (når en medarbejder har åbnet en chat med dig).
- **Kontaktformularen**: din e-mail, emne, besked og evt. handels-id.

Vi gemmer også beskeder, som vores filter har stoppet (fx fordi de indeholdt et telefonnummer). Modtageren ser dem ikke, men vores medarbejdere kan se dem.

### 3.4 Dine valg og indstillinger

- Favoritter, sælgere du følger, gemte søgninger og skabeloner til auktioner.
- Notifikationer og dine indstillinger for, hvilke notifikationer du vil have på mail, i appen og som push.
- **Push-token**: hvis du slår push til i appen, gemmer vi en kode, der gør det muligt at sende beskeder til din telefon.
- Brugere, du har blokeret.
- Dit cookievalg (gemt i din browser, se `/cookies`).

### 3.5 Sikkerhed og misbrug

- **Enheder**: når du logger ind, får din browser en tilfældig kode i en cookie (`bh_enhed`). Vi gemmer kun en sløret udgave (en hash) af koden, en kort beskrivelse som "Chrome på Windows" og tidspunkter. Vi gemmer ikke din IP-adresse sammen med enheden. Det bruger vi til at give dig besked ved login fra en ny enhed. Vi gemmer højst de 30 seneste enheder.
- **IP-adresse til at stoppe misbrug**: for at forhindre fx gætteri af adgangskoder og spam tæller vi forsøg pr. IP-adresse og pr. e-mail i et kort tidsrum (fx ved login, oprettelse, bud, søgning, kontaktformular og anmeldelser). Et dagligt oprydningsjob sletter tællerne, så de gemmes i højst ca. et døgn.
- **Tekniske logs hos vores leverandører**: Supabase (login) og Vercel (hosting) registrerer tekniske oplysninger som IP-adresse, browser og tidspunkt, når du bruger BidHamr. [TODO Filip: tjek, hvor længe Supabase og Vercel gemmer deres logs på jeres abonnement, og skriv det i afsnit 8.]
- **Advarsler, påmindelser, suspension og lukning** af konti, med begrundelser.
- **Anmeldelser og rapporter**: hvem der har anmeldt hvad, og hvordan vi har behandlet det. Det gælder også automatiske rapporter fra vores filtre (fx forbudte varer og beskeder om handel uden om BidHamr).
- **Medarbejder-log**: hvad vores medarbejdere har gjort (fx afgjort en sag eller givet en advarsel). Ved sletning af en konto logges det uden persondata.

### 3.6 Anmeldelser af ulovligt indhold (DSA)

Anmelder du indhold, gemmer vi dit navn, din e-mail (og din konto, hvis du er logget ind), din begrundelse, vores svar til dig og en eventuel klage. Vi fortæller aldrig den, der har lagt indholdet op, hvem du er. Anmelder du seksuelt misbrug af børn, behøver du ikke oplyse navn og e-mail.

### 3.7 Venteliste

Skriver du dig op til ventelisten før lanceringen, gemmer vi din e-mail og sender dig en velkomstmail. [TODO Filip: hvad bruges listen til, og hvornår slettes den? Bruges den til at sende nyheder/markedsføring, kræver det samtykke – se afsnit 4.]

### 3.8 Besøgsstatistik og fejllog

- **Besøgsstatistik uden cookies**: vi tæller kun, hvor mange gange en type side er vist pr. dag (fx "en auktion"). Vi gemmer ikke, hvem du er, din IP-adresse, hvilken auktion du så, eller hvad du søgte efter. Har du slået "Do Not Track" eller "Global Privacy Control" til, tæller vi slet ikke.
- **Visninger af auktioner**: når du er logget ind og ser en andens auktion, registrerer vi, at din konto har set den, så sælgeren kan se antallet af visninger. Sælgeren kan kun se antallet – ikke hvem.
- **Fejllog**: hvis noget går galt på siden, gemmer vi en fejlbesked, siden (uden søgeord og parametre) og – hvis du er logget ind – dit bruger-id. Vi fjerner e-mails, telefonnumre og lignende fra teksten, før den gemmes.

### 3.9 Det gemmer vi ikke

- Kortnumre og bankkontonumre (de ligger hos Stripe).
- CPR-nummer. Vi beder ikke Idura om dit CPR-nummer, når du bekræfter dig med MitID (afsnit 3.10). [TODO Filip/ADVOKAT: DAC7 kan kræve skatte-id – se afsnit 5.]
- GPS-position fra dine billeder: når du lægger billeder op – til en auktion, som profilbillede, i en sag eller som pakkebillede – bliver billedet lavet om i din browser, før det sendes til os. Det fjerner skjulte oplysninger som GPS-position. [TODO Filip: bekræft, at det også gælder billeder og dokumentation, der uploades til en anke, og i appen.]

### 3.10 MitID

Før dit første bud og før du sætter din første vare til salg, skal du bekræfte, hvem du er, med MitID. Det sker via vores leverandør **Idura ApS** (tidligere Criipto), en dansk virksomhed, som er godkendt MitID-broker. Firmakonti (erhverv) er undtaget – de er godkendt med CVR.

Når du bekræfter dig, får vi fra MitID:

- **dit navn** (juridisk navn) – vi gemmer det, men viser det **aldrig** for andre brugere. Det bruges kun internt: i dine handler, på fakturaer og til indberetning til Skattestyrelsen (DAC7). Andre ser kun dit brugernavn og mærket "MitID-verificeret".
- **din fødselsdato** – for at sikre, at du er fyldt 18 år, og fordi DAC7 kræver fødselsdato på sælgere. Er du under 18, gemmer vi ikke fødselsdatoen – kun at et forsøg blev afvist.
- **dit MitID-id** (MitIDs Person-ID) – vi gemmer det **kun sløret**: som en kode (HMAC-hash med en hemmelig nøgle), som ikke kan regnes tilbage til id'et. Den bruges til at sikre, at samme MitID kun kan bruges til én konto, og at en konto, der er lukket permanent for svindel, ikke kan oprettes igen.
- **ikke dit CPR-nummer**. Vi beder ikke om det, og vi får det ikke.

Hvis en anden konto prøver at bruge et MitID, der allerede er brugt, afviser vi det og giver vores medarbejdere besked, så de kan se, om der er tale om en dobbeltkonto.

Kun du selv og vores medarbejdere kan se navnet og fødselsdatoen fra MitID. Du kan se dem under Min konto og i "Download dine data". [ADVOKAT: se noter-til-advokat.md om retsgrundlag og opbevaring af MitID-oplysningerne.]

### 3.11 Kommer senere (rettes, når det er i drift)

- **Fragtfirma** [TODO Filip: ikke i drift endnu]: når fragtintegrationen er på plads, sender vi de oplysninger, der skal til for at sende pakken – fx sælgerens og købers navn, købers pakkeshop, e-mail og telefonnummer – til fragtfirmaet DAO (Dansk Avis Omdeling A/S) [TODO: i testperioden går det via Shipmondo; når DAO-aftalen er i drift, sendes det direkte til DAO].
- **Regnskabsprogram** [TODO Filip: ikke i drift endnu]: fakturaer på BidHamrs gebyrer laves i et regnskabsprogram (sandsynligvis Dinero).
- **DAC7** [TODO Filip: ikke bygget endnu]: se afsnit 5.

---

## 4. Hvorfor behandler vi oplysningerne, og hvad er retsgrundlaget?

| Formål | Oplysninger | Retsgrundlag (GDPR) |
|---|---|---|
| Oprette og drive din konto, login og bekræftelse af din e-mail | Konto, enheder | Aftale – art. 6, stk. 1, litra b |
| Indgå aftalen om brugen af BidHamr og kunne dokumentere, hvilke brugerbetingelser du har accepteret | Version og tidspunkt for din accept | Aftale – litra b, og legitim interesse i at kunne dokumentere aftalen – litra f |
| Auktioner, bud, betaling, forsendelse, afhentning, udbetaling og handelsbeskeder | Auktioner, bud, handler, betalinger, beskeder, adresse og telefon ved afhentning | Aftale – litra b |
| Sager, anker og BidHamr Beskyttelse | Sager, billeder, pakkebilleder, beskeder, sporing | Aftale – litra b, og legitim interesse i at afgøre tvister – litra f |
| Notifikationer og mails om dine handler | E-mail, push-token, indstillinger | Aftale – litra b |
| Bogføring og fakturaer på vores gebyrer | Handels- og betalingsdata | Retlig forpligtelse – litra c (bogføringsloven) |
| Indberetning af sælgere til Skattestyrelsen (DAC7) | Sælgeroplysninger og salg | Retlig forpligtelse – litra c (skatteindberetningsloven/DAC7) |
| Behandle anmeldelser af ulovligt indhold, begrundelser og klager | Anmeldelser, afgørelser, klager | Retlig forpligtelse – litra c (DSA) |
| Forebygge svindel og misbrug, spamfilter, filter for forbudte varer, grænser for antal forsøg, mail ved nyt login, advarsler og lukning af konti | Sikkerhedsdata, IP-tællere, beskeder, rapporter, advarsler | Legitim interesse – litra f (at beskytte brugerne og BidHamr) |
| Bekræfte din identitet med MitID: 18 år, én konto pr. person og at lukkede svindlere ikke kommer igen | Navn, fødselsdato og sløret MitID-id fra MitID | Aftale – litra b (det er en betingelse for at byde og sælge), og legitim interesse i at forebygge svindel og dobbeltkonti – litra f [ADVOKAT] |
| Fejlfinding og drift | Fejllog, tekniske logs | Legitim interesse – litra f |
| Besvare henvendelser | Kontaktformular, e-mail | Legitim interesse – litra f (og aftale, hvis det handler om en handel) |
| Venteliste | E-mail | [ADVOKAT: samtykke – litra a – eller legitim interesse?] |
| Push-beskeder på telefonen | Push-token | Samtykke – litra a (du siger ja i telefonens indstillinger og kan slå det fra der) |
| Cookies, der ikke er nødvendige | – | Samtykke – litra a. Vi bruger ingen i dag (se `/cookies`) |

[ADVOKAT: Bekræft retsgrundlagene, især: (1) legitim interesse for svindelforebyggelse og for at læse beskeder i handler; (2) at DSA-behandlingen kan bygge på litra c; (3) om push kræver samtykke eller er en del af aftalen; (4) aftale/legitim interesse for at gemme version og tidspunkt for accept af brugerbetingelserne.]

**Automatiske beslutninger.** Nogle ting sker automatisk: ulovlige varer bliver stoppet ved oprettelse, beskeder med kontaktoplysninger bliver stoppet, handler annulleres, hvis fristen for betaling eller afsendelse er overskredet, pengene frigives, når fristen for en sag er gået, og en auktion, som BidHamr har sat på pause, annulleres efter 14 dage på pause. Advarsler, afgørelser i sager, skjulning af auktioner og lukning af konti træffes altid af en medarbejder. [ADVOKAT: Er nogen af de automatiske beslutninger omfattet af GDPR art. 22?]

---

## 5. Indberetning til Skattestyrelsen (DAC7)

Som markedsplads har BidHamr pligt til at indberette oplysninger om sælgere til Skattestyrelsen, når en sælger i løbet af et kalenderår har mindst 30 salg eller har solgt for mindst 2.000 euro. Indberetningen omfatter fx navn, adresse, fødselsdato, skatte-id (CPR-nummer), bankkonto, antal salg, beløb og gebyrer. Skattestyrelsen kan dele oplysningerne med skattemyndigheder i andre EU-lande.

Rammer du grænserne, beder vi dig om de oplysninger, loven kræver, og giver dig besked om indberetningen. [TODO Filip: indsamlingen af skatte-id og fødselsdato er ikke bygget. Afklar med revisor, hvordan og hvornår – evt. via Stripe.] [ADVOKAT/revisor: bekræft grænser, indhold, hvordan sælgerne skal informeres, og hvor længe oplysningerne skal gemmes.]

---

## 6. Hvem deler vi oplysningerne med?

### 6.1 Andre brugere

- **Offentligt**: dit navn, profilbillede, dine auktioner, spørgsmål og svar, dine bedømmelser og dine offentlige tal (fx antal auktioner og salg), og om du er MitID-verificeret (mærket – aldrig navnet fra MitID). Bud vises uden navn.
- **Køber og sælger i en handel** ser hinandens navn og beskederne i handlen.
- **Ved afhentning** ser køberen sælgerens adresse og telefonnummer, når varen er betalt, og indtil den er hentet.
- Din e-mail vises aldrig for andre brugere. Telefonnummer og adresse vises kun ved afhentning som beskrevet ovenfor.
- Har du anmeldt noget, ser den, der har lagt indholdet op, aldrig hvem du er.

### 6.2 BidHamrs medarbejdere

Vores medarbejdere har adgang til de oplysninger, de skal bruge til fx sager, anmeldelser, support og svindelforebyggelse – også beskeder i handler. Kun ledelsen ("chef") kan se BidHamrs indtjening.

### 6.3 Databehandlere (leverandører, der behandler oplysninger for os)

| Leverandør | Hvad de gør for os | Hvor | Overførsel uden for EU/EØS |
|---|---|---|---|
| **Supabase** | Database, login, filer (billeder) og planlagte opgaver | Data lagres i EU – AWS-region eu-west-1 (Irland) | Supabase Inc. er en amerikansk virksomhed. Mulig adgang fra USA (support/drift) [ADVOKAT] |
| **Vercel** | Hosting af hjemmesiden, billedvisning og serverkode | Serverkoden kører i EU – Vercel-region dub1 (Dublin, Irland) [TODO Filip: tjek, hvor Vercel gemmer logs, og om sider og billeder også leveres fra servere uden for EU via Vercels netværk] | Vercel Inc. er en amerikansk virksomhed. Overførsel eller adgang fra USA kan forekomme (fx support, drift og logs) [ADVOKAT] |
| **Resend** | Afsendelse af mails (fx bekræftelse, notifikationer, kvitteringer) | [TODO Filip: tjek, om bidhamr.dk-domænet i Resend er sat op i en EU-region] | Resend Inc., USA |
| **Idura ApS** (tidligere Criipto) | MitID-login (broker): bekræfter din identitet og sender os navn, fødselsdato og MitID-id | Danmark/EU | Nej [TODO Filip: bekræft i Iduras databehandleraftale, hvor data behandles] |
| **Expo** (650 Industries) | Sender push-beskeder til appen videre til Apple og Google | USA | Ja |
| **Apple** og **Google** | Levering af push-beskeder til din telefon | – | [ADVOKAT: databehandlere eller selvstændigt dataansvarlige?] |

[TODO Filip: bekræft databehandleraftale (DPA) med Supabase, Vercel, Resend, Idura og Expo – de fleste har en standardaftale, der skal accepteres i deres dashboard.]

Vi bruger ikke Google Analytics, Facebook Pixel, reklamenetværk eller andre sporingsværktøjer. Skrifttyper og billeder hentes fra vores eget domæne.

### 6.4 Stripe (betaling)

Betalingen håndteres af vores betalingspartner Stripe. Når du betaler, gemmer et kort eller opretter en udbetalingskonto, giver du dine oplysninger direkte til Stripe. Vi deler fx dit navn, din e-mail og handlens beløb med Stripe, så betalingen kan gennemføres. Stripe er selvstændigt dataansvarlig for en del af behandlingen, fx kontrol af identitet ved udbetalingskonti, svindelforebyggelse og krav efter hvidvaskloven. Læs Stripes privatlivspolitik på stripe.com/privacy. Stripe Payments Europe Ltd. ligger i Irland, men oplysninger kan blive overført til Stripe i USA.

[ADVOKAT: Hvilke dele er Stripe databehandler for, og hvilke er Stripe selvstændigt dataansvarlig for?]

### 6.4a MapTiler (kort i checkout)

Når du vælger en pakkeshop, viser vi et kort. Kortbillederne hentes fra MapTiler AG i Schweiz (kortdata fra OpenStreetMap). Din browser henter billederne direkte fra MapTiler, så MapTiler modtager din IP-adresse og oplysninger om din browser – men ikke dit navn, din adresse eller hvad du har købt. Søgningen efter pakkeshops sker gennem os, ikke gennem MapTiler. Schweiz er af EU-Kommissionen godkendt som et land med tilstrækkeligt beskyttelsesniveau. Læs MapTilers privatlivspolitik på maptiler.com/privacy-policy. [ADVOKAT: Er MapTiler databehandler for os, eller selvstændigt dataansvarlig for de tekniske oplysninger? Kræver det en databehandleraftale?]

### 6.5 Myndigheder og andre

- **Skattestyrelsen** (DAC7, se afsnit 5) og andre myndigheder, når loven kræver det.
- **Politiet**, hvis vi har mistanke om alvorlig kriminalitet, eller når politiet beder om det med lovhjemmel.
- **Din bank eller kortudsteder** via Stripe, hvis du gør indsigelse mod en betaling (fx sporing og leveringskvittering).
- **Revisor og rådgivere**, når det er nødvendigt.
- Fragtfirma og regnskabsprogram: se afsnit 3.10.

Vi sælger aldrig dine oplysninger.

---

## 7. Overførsel til lande uden for EU/EØS

Vores database og vores serverkode kører i EU (Irland). Nogle af vores leverandører er dog amerikanske virksomheder (Supabase, Vercel, Resend, Expo og Stripe), og oplysninger kan derfor blive overført til eller set fra USA, fx når leverandøren yder support eller drift. Når oplysninger overføres til USA, sker det på grundlag af EU-US Data Privacy Framework, hvis leverandøren er certificeret, og ellers EU-Kommissionens standardkontraktbestemmelser.

[ADVOKAT: Bekræft grundlaget for hver leverandør (DPF-certificering/SCC) og behovet for en overførselsvurdering (TIA). Gælder også Vercel, selvom serverkoden nu kører i EU (dub1).] [TODO Filip: tjek på dataprivacyframework.gov, hvilke af leverandørerne der er certificeret.]

---

## 8. Hvor længe gemmer vi oplysningerne?

| Oplysninger | Hvor længe |
|---|---|
| Konto og profil | Så længe du har en konto. Når du sletter den, fjernes eller anonymiseres oplysningerne (se afsnit 9) |
| Accept af brugerbetingelserne (version og tidspunkt) | Så længe du har en konto. Har du handlet på BidHamr, gemmes den derefter som dokumentation for de handler, du har lavet, lige så længe som handelsdata [TODO Filip: bekræft, at sletning af kontoen bevarer felterne] [ADVOKAT] |
| Handelsdata: handler, betalinger, gebyrer, forsendelser, pakkebilleder, sager, anker, sagsbilleder og beskeder i handler | Mindst 5 år efter udgangen af det regnskabsår, handlen hører til (bogføringsloven). I dag slettes de ikke automatisk. [ADVOKAT: se nedenfor] |
| Bedømmelser og sælgers svar | Så længe BidHamr findes. Efter sletning af kontoen vises de som fra "Slettet bruger" |
| Samtaler med BidHamr | Slettes ikke automatisk i dag [ADVOKAT] |
| Henvendelser via kontaktformularen | Slettes ikke automatisk i dag [ADVOKAT] |
| Advarsler, begrundelser for indgreb og medarbejder-log | Slettes ikke automatisk i dag (dokumentation for afgørelser) [ADVOKAT] |
| Anmeldelser og rapporter | Behandlede rapporter flyttes til et arkiv efter 48 timer og gemmes der. Anmelderens navn, e-mail, konto-kobling og fritekst i DSA-anmeldelser anonymiseres 12 måneder efter afgørelsen. Statistik og begrundelser gemmes |
| MitID: sløret MitID-id | Også efter, at du har slettet din konto – så en konto, der er lukket for svindel, ikke kan oprettes igen, og så vi kan se, hvis samme person kommer tilbage (fx med advarsler på den gamle konto) [ADVOKAT: hvor længe?] |
| MitID: navn og fødselsdato | Så længe du har en konto. Har du handlet, gemmes de som handelsdata (fakturaer, DAC7) – ellers slettes de, når du sletter kontoen |
| Enheder | Til du fjerner enheden, til den bliver skubbet ud af listen over de 30 seneste, eller til du sletter kontoen |
| Tællere med IP-adresse og e-mail (misbrug) | Højst ca. et døgn. Et dagligt oprydningsjob sletter dem |
| Fejllog | 90 dage efter, fejlen sidst er set |
| Log over planlagte opgaver (cron) | 90 dage. Den tekniske historik i databasen slettes efter 14 dage. Indeholder ikke persondata |
| Besøgsstatistik | Indeholder ikke persondata |
| Venteliste | [TODO Filip: fx til lanceringen + 3 måneder] |
| Tekniske logs hos Supabase og Vercel | [TODO Filip: indsæt leverandørernes frister] |
| Cookies | Se `/cookies` |
| DAC7-oplysninger | [ADVOKAT/revisor: fx 10 år] |

[ADVOKAT: Forretningsreglen er i dag, at handelsdata, samtaler, kontakthenvendelser, rapporter og begrundelser "slettes aldrig". Bogføringsloven kræver 5 år. Hvor længe må vi gemme de enkelte typer efter GDPR's princip om opbevaringsbegrænsning, og skal vi bygge automatisk sletning eller anonymisering efter fx 5 år (+ indeværende regnskabsår)?]

---

## 9. Når du sletter din konto

Du sletter din konto under Min konto → Slet konto. Det kan ikke lade sig gøre, mens du har noget i gang (fx bud, handler, sager eller penge undervejs), mens kontoen er suspenderet, eller mens du har advarsler – siden viser, hvad der mangler. [ADVOKAT: se noter-til-advokat.md nr. 110.]

Når kontoen slettes:

- Dit navn bliver til "Slettet bruger".
- Din e-mail, dit telefonnummer, din adresse, dit profilbillede (også selve filen), dine push-tokens og dit gemte kort fjernes.
- Favoritter, følger (begge veje), gemte søgninger, notifikationer, blokeringer, skabeloner og enheder slettes.
- Auktioner uden bud afsluttes og arkiveres.
- Din login-bruger spærres, og e-mailen sløres, så du ikke kan logge ind. Du kan senere oprette en ny konto med samme e-mail.
- Du får en mail om, at kontoen er slettet.
- Mærket "MitID-verificeret" fjernes. Navn og fødselsdato fra MitID slettes, medmindre du har handlet (så gemmes de som handelsdata). Det slørede MitID-id gemmes, så samme MitID ikke kan bruges til at omgå en lukning. Du kan godt oprette en ny konto med samme MitID senere, medmindre din konto er lukket permanent.

Det gemmer vi, fordi loven kræver det: handler, betalinger, gebyrer, sager, anker, beskeder i handler og medarbejder-loggen (bogføringsloven og DAC7). Vi gemmer også, hvilken version af brugerbetingelserne du accepterede, og hvornår, som dokumentation for de handler, du har lavet. Bedømmelser og svar bliver stående, men står som fra "Slettet bruger". Referencer til din kunde- og udbetalingskonto hos Stripe gemmes som en del af handelsdata. [TODO Filip: gemte kort hos Stripe ryddes, når Stripe-arbejdet genoptages.]

Mails, der allerede er sendt til andre (fx en kvittering med dit navn), kan vi ikke trække tilbage. [TODO Filip: tjek, om dit tidligere navn kan ses andre steder efter sletningen, fx i tekst, som brugerne selv har skrevet i beskeder.]

---

## 10. Dine rettigheder

Du har disse rettigheder efter databeskyttelsesforordningen (GDPR):

- **Indsigt og dataportabilitet**: under Min konto kan du trykke "Download dine data" og få én fil (JSON) med dine oplysninger: profil, auktioner, bud, handler med dine egne beløb, beskeder i dine handler, samtaler med BidHamr, bedømmelser, notifikationer og indstillinger, favoritter, følger, gemte søgninger, anmeldelser, kontakthenvendelser og enheder. Andre brugere står kun med fornavn. Du kan hente filen én gang i timen. Vil du have oplysninger, der ikke er i filen, så skriv til os. [TODO Filip: tjek, om version og tidspunkt for accept af brugerbetingelserne er med i filen.]
- **Berigtigelse**: du kan selv rette navn, telefon, adresse og profilbillede under Min konto. Skriv til os, hvis noget andet er forkert.
- **Sletning**: brug "Slet konto" (se afsnit 9). Vi sletter ikke oplysninger, vi har pligt til at gemme.
- **Begrænsning**: du kan bede os om midlertidigt kun at opbevare dine oplysninger, fx mens vi undersøger, om de er rigtige.
- **Indsigelse**: du kan gøre indsigelse mod behandling, der bygger på vores legitime interesse (se afsnit 4). Så stopper vi, medmindre vi har vægtige grunde til at fortsætte, fx for at forhindre svindel eller afgøre en sag.
- **Træk samtykke tilbage**: fx ved at slå push fra i telefonens indstillinger eller ændre dit cookievalg via "Cookieindstillinger" nederst på siden. Det påvirker ikke det, vi har gjort, før du trak samtykket tilbage.

Skriv til support@bidhamr.dk for at bruge dine rettigheder. Vi svarer inden for en måned. Vi kan bede dig bekræfte, at det er dig.

**Klage**: du kan klage til Datatilsynet, Carl Jacobsens Vej 35, 2500 Valby, dt@datatilsynet.dk, datatilsynet.dk. Vi vil gerne høre fra dig først, så vi kan prøve at løse det.

---

## 11. Cookies

Vi bruger kun nødvendige cookies til login, sikkerhed og betaling – ingen statistik- eller reklamecookies. Se alle cookies, og ændr dit valg, på `/cookies`.

---

## 12. Sådan beskytter vi dine oplysninger

- Al trafik til BidHamr er krypteret (HTTPS).
- Adgangskoder gemmes kun som hash. Vi kræver stærke adgangskoder, og din e-mail bekræftes med en kode, når du opretter en konto.
- Du får en mail ved login fra en ny enhed, når din adgangskode ændres, og når din konto slettes. Mails om sikkerhed kan ikke slås fra.
- Databasen bruger adgangsregler, så du kun kan se dine egne private oplysninger. Billeder fra sager, pakkebilleder og fragtlabels ligger i lukkede mapper, som kun parterne i handlen og vores medarbejdere kan åbne.
- Billeder bliver lavet om i din browser, før de sendes til os, så skjulte oplysninger som GPS-position ikke følger med (se afsnit 3.9).
- Vores medarbejdere har kun adgang til det, de skal bruge, og deres handlinger logges.
- Vi begrænser antallet af forsøg (fx login og anmeldelser) for at stoppe gætteri og spam.
- Supabase krypterer data, når de er gemt. [TODO Filip: bekræft på Supabases side.]
- Vi tager backup af databasen. [TODO Filip: hvor gemmes backup, og hvor længe?]

Sker der et brud på sikkerheden, der kan skade dig, giver vi dig og Datatilsynet besked, som loven kræver.

---

## 13. Ændringer

Vi opdaterer politikken, når vi ændrer, hvordan vi behandler oplysninger – fx når fragtfirmaet eller regnskabsprogrammet kommer til. Ved væsentlige ændringer giver vi dig besked på mail eller i appen. Datoen øverst viser, hvornår politikken sidst er ændret.

---

## 14. Kontakt

Har du spørgsmål om dine oplysninger, så skriv til support@bidhamr.dk eller brug kontaktformularen på `/kontakt`.

[TODO Filip: firmanavn, CVR og adresse]
