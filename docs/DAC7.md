# DAC7 – indberetning af sælgere til Skattestyrelsen

Bygget 9. okt. 2026 (ROADMAP fase 1, "DAC7"). Database:
`supabase/migrations/20261014010000_dac7.sql`. Kode: `src/lib/dac7/`,
`/konto/skat`, `/admin/dac7`, `/api/dac7/oplysninger`.
Advokat/revisor: `jura/noter-til-advokat.md` nr. 111–112. Privatlivspolitik afsnit 5.

## Kort fortalt

- En sælger skal indberettes, når han i et kalenderår har **mindst 30 salg ELLER
  over 2.000 EUR** i vederlag. Andre er "undtagne sælgere".
- Når en privat sælger **nærmer sig** (25 salg eller 1.500 EUR), beder BidHamr om
  oplysningerne under **Min konto → Skatteoplysninger**: frist 60 dage,
  påmindelser efter 20 og 40 dage. Efter fristen kan han **ikke oprette nye
  auktioner** (fejlkode `BHD01`), før oplysningerne er givet (chefens valg).
- Chefen henter én gang om året **Skattestyrelsens CSV-fil** under **Admin →
  DAC7**, uploader den i TastSelv Erhverv **senest 31. januar** og markerer året
  som sendt. Så får sælgerne besked og en **kopi** under Min konto.

## Hvad Stripe tilbyder (undersøgt 9. okt. 2026)

Kilde: docs.stripe.com/connect/platform-tax-reporting.

- Stripe har **"Platform tax reporting"** til DAC7 (alle EU-lande undtagen PL) –
  men den er i **lukket beta (private preview)**: man skal ansøge om adgang. Den
  er ikke slået til på BidHamrs testkonto.
- Med den tilføjes en `tax_reporting`-verificering på de forbundne konti, og
  Stripe spørger selv sælgeren om skatte-id i onboardingen (også Express), med
  spærring af udbetalinger efter beløb/tid.
- Men: rapporten laves kun i **XML for NL** (EU), AU, CA og UK. **Danmark kræver
  CSV i Skattestyrelsens eget format** (TastSelv Erhverv) – Stripes fil kan
  ikke bruges direkte her. Transaktionstallene skal desuden uploades til Stripe
  som CSV af platformen selv.
- Stripes API udleverer aldrig sælgerens CPR/skatte-id eller fulde kontonummer
  (kun `id_number_provided` og de sidste 4 cifre).

**Valg (chefens):** BidHamr beregner selv tallene fra databasen og laver selv
Skattestyrelsens CSV. CPR indsamles af BidHamr i en egen formular, krypteret
(se herunder) – det sikreste, der kan bygges uden Stripes beta, og CPR ender
kun ét sted (os) i stedet for to. Får Filip adgang til Stripes beta, kan den
bruges til at indsamle/verificere skatte-id, men den danske fil skal stadig
laves her.

## Tallene (pr. sælger, pr. kalenderår og kvartal)

`dac7_salg` / `dac7_saelgertal` i migrationen:

- Et **salg** = en betaling med status `betalt` (destination-modellen: pengene er
  krediteret sælgerens Stripe-konto). Dato = `betalt_kl` (gamle
  `separat`-betalinger: `overfoert_kl`). År og kvartal efter dansk tid.
- **Vederlag** = `udbetaling_oere` (bud − sælgergebyr) − evt. beløb hentet tilbage
  ved tabt indsigelse. Refunderede betalinger tæller ikke (sælgeren fik intet).
- **Gebyr** = `saelgergebyr_oere`. Skat = 0.
- **Kurs**: 7,46 DKK/EUR som standard; chefen kan rette årets kurs i admin (låst,
  når året er sendt). Grænsen er `2000 × kurs` kr.

## Sælgerens oplysninger

| Oplysning | Kilde |
|---|---|
| Juridisk navn, fødselsdato | MitID (`mitid_verificeringer`) – ikke tastet igen |
| Bopælsadresse | Formularen (`dac7_saelgeroplysninger`) |
| CPR-nummer (skatte-id) | Formularen – krypteret. De første 6 cifre skal passe med fødselsdatoen fra MitID |
| Skatte-id fra andet EU-land | Formularen (valgfrit) – krypteret |
| Firma: navn, CVR, adresse | `firmaer` (BidHamr har allerede godkendt dem) |
| Bankkonto | **Indberettes ikke** – ligger kun hos Stripe (spørgsmål til revisor, nr. 112) |

### Sikkerhed for CPR

- AES-256-GCM i serverkoden (`src/lib/dac7/krypto.ts`) med nøglen
  `DAC7_KRYPTERINGSNOEGLE`, som kun findes på serveren. Databasen gemmer
  `v1.<iv>.<tag>.<data>` og kan ikke dekryptere. Hver værdi er bundet til
  brugeren og feltet (AAD), så den ikke kan flyttes til en anden bruger.
- Tabellerne har RLS uden grants til `anon`/`authenticated` – kun `service_role`.
  Brugeren ser sit CPR **maskeret** (`010190-••••`) under Min konto. Chefen ser
  kun CPR i selve indberetningsfilen (bygget i hukommelsen, sendt direkte til
  chefens browser, gemt ingen steder). Ingen andre medarbejdere kan se det.
- CPR logges aldrig: fejl fra databasen logges kun med fejlkode; formularen kan
  ikke sendes, før siden er indlæst (ellers kunne CPR havne i adressen).
- Rate limit: 10 gem pr. bruger pr. time.
- **Nøglen må ALDRIG skiftes eller mistes**, så længe der er gemte CPR-numre –
  så kan de ikke læses igen, og sælgerne skal udfylde dem på ny. Mangler nøglen,
  kan der hverken gemmes CPR eller laves fil (fail closed).

## Indberetningsfilen (eksport) og "sendt"

- Hver gang chefen henter filen, gemmes en **eksport** (`dac7_eksporter`) med et
  **øjebliksbillede pr. sælger** (`dac7_eksport_saelgere` – CPR kun krypteret) og
  **SHA-256 af filen**. Filen bygges af øjebliksbilledet.
- Alle tekstfelter valideres, før filen laves: de skal starte med et bogstav
  eller tal og må ikke indeholde kontroltegn (beskytter mod formler, når filen
  åbnes i et regneark). Fejler et felt, stoppes eksporten med en dansk besked,
  der peger på sælgerens bruger-id – værdien rettes aldrig stiltiende.
- "Markér som sendt": chefen vælger eksporten og den fil, han uploadede. Browseren
  beregner filens SHA-256 (filen sendes ikke), og den skal passe med eksporten.
  Sælgernes kopi er netop den eksports øjebliksbillede.

## Anmodning, påmindelser og spærring

Cron (`/api/cron/afslut-auktioner` → `koerDac7Cron` → `dac7_koer_cron`, højst
én gang i timen):

1. Private sælgere, der mangler oplysninger, får en **anmodning** (frist 60
   dage): for i år, når de nærmer sig grænsen; for sidste år kun, hvis de blev
   indberetningspligtige. En åben anmodning for et afsluttet år, hvor sælgeren
   ikke blev indberetningspligtig, **bortfalder** (`bortfaldet_kl`), og en
   spærring ophæves.
2. **Påmindelse 1** efter 20 dage, **påmindelse 2** efter 40 dage (mindst 7 dage
   efter nr. 1).
3. Efter fristen (og mindst 7 dage efter påmindelse 2): **spærret for nye
   auktioner og "tilbud til næste byder"** (et nyt salg – chefens valg;
   triggere `auctions_a1_dac7` og `a1_andenchance_dac7`, `BHD01`).
   Igangværende auktioner, handler og udbetalinger fortsætter.
4. Så snart oplysningerne er gemt, lukkes anmodningen, og spærringen ophæves.

Beskederne er notifikationstypen **`skat`** (påkrævet) med link til
`/konto/skat`, sendt én gang pr. trin (nøgle `dac7:<år>:<trin>:<bruger>`).
Firmakonti får ingen anmodning – staff retter firmaets oplysninger.

## Bopæl uden for Danmark (chefens valg)

Kun sælgere med bopæl i Danmark kan give oplysningerne (formularen kræver
"Jeg bor i Danmark", og databasen afviser andet end land DK). Bor sælgeren i
udlandet, får han besked om at skrive til support. Revisor: nr. 113.

## Opbevaring og kontosletning

- Anmodninger, eksporter, kopier og log slettes aldrig (handelsdata).
- Ved kontosletning bevares CPR og adresse kun for sælgere, der har en
  anmodning eller indberetning, eller som nærmer sig/har nået grænsen i år
  eller sidste år. Ellers slettes de.
- Vi antager **10 år** efter indberetningsåret (direktivet nævner op til 10 år;
  Skattestyrelsen nævner 5 år for filerne). Der er endnu ingen automatisk
  sletning – afventer advokat/revisor (nr. 111).

## Til revisor (også i noter-til-advokat.md nr. 111–113)

- **Vederlag:** bud − sælgergebyr (det sælgeren får), pr. betalt handel, dateret
  på betalingsdagen (pengene krediteres sælgerens Stripe-konto) – ikke
  udbetalingen til banken.
- **Gebyr:** kun sælgergebyret. Købergebyr, fragt og BidHamr Beskyttelse
  betales af køberen og indberettes ikke.
- **Kurs:** 7,46 DKK/EUR som standard; chefen kan rette årets kurs.
- **Kontonummer:** indberettes ikke (ligger hos Stripe; vi har kun 4 cifre).
- **Rettelser:** korrektionsfiler laves ikke af systemet – rettes manuelt i
  Skattestyrelsens Excel-værktøj. Sælgerens kopi er den oprindelige.
- **Bopæl uden for DK:** afvises i dag.

## Hvad Filip skal gøre

1. **Nøgle:** generér `DAC7_KRYPTERINGSNOEGLE` (32 bytes, base64url) – én til
   `.env.local` (test) og en **anden** til Vercel (produktion). Gem dem sikkert
   (password-manager). Kommandoen står i `.env.example`.
2. **Migration:** `20261014010000_dac7.sql` er kørt på testdatabasen. Kør den i
   produktion, når du har sagt ja (kræver `20261013010000_mitid.sql` først).
3. **Skattestyrelsen:** når CVR er på plads: registrér BidHamr med pligtkode 242
   (blanket 03.091 på virk.dk), og giv dig selv/revisor rettigheden "indberet om
   platformsøkonomi" i TastSelv Erhverv (MitID Erhverv).
4. **Admin → DAC7 → Indstillinger:** BidHamrs CVR, juridiske navn, adresse og
   kontakt (står i filen).
5. **Hvert år i januar** (frist **31. januar**):
   1. Admin → DAC7, vælg sidste år. Tjek, at alle er "Komplet". Mangler nogen,
      bruger filen Skattestyrelsens dummy-værdier (fx `01-01-1900`), og
      indberetningen skal rettes senere.
   2. "Hent indberetningsfil" → upload i TastSelv Erhverv → Øvrige
      indberetninger → Platformsøkonomi → Indberet via fil. Vent på godkendt
      validering. **Slet filen bagefter** (den indeholder CPR-numre).
   3. "Markér som sendt": vælg eksporten og den uploadede fil (tjekkes med
      hash) og skriv kvitteringsnummeret. Sælgerne får besked og kopien. Slet
      filen bagefter.
6. **Revisor/advokat:** spørgsmål nr. 111–112 (vederlag, gebyr, kurs,
   sanktion, opbevaring, bankkonto).

## Ikke bygget (endnu)

- **Korrektioner** (DPI402/OECD2/OECD3): retter man efter indberetningen, laves
  korrektionsfilen manuelt i Skattestyrelsens Excel-værktøj. Kopien til
  sælgeren er den oprindelige.
- **Verificering hver 36. måned** af oplysningerne.
- **Udbetalingsstop** som sanktion (vi spærrer kun nye auktioner – nr. 111).
- **Henvisende indberetning** (to platforme om samme sælgere) – ikke relevant.

## Appen (Expo)

- Status: `supabase.rpc("dac7_min_status")` → `{ aar, konto_type, antal,
  vederlag_oere, gebyr_oere, graense_antal, graense_oere, varsel_antal,
  varsel_oere, pligtig, naer, mangler: ('mitid'|'oplysninger'|'firma')[],
  mitid: { navn, foedselsdato } | null, oplysninger: { adresse, postnummer,
  bynavn, land, cpr_oplyst, andet_tin_land, oplyst_kl, opdateret_kl } | null,
  anmodning: { aar, anmodet_kl, frist, paamindelser, spaerret } | null,
  indberetninger: [{ aar, indberettet_kl, data }] }`. Intet CPR.
- Gem: `POST https://bidhamr.dk/api/dac7/oplysninger` med
  `Authorization: Bearer <access token>` og JSON `{ adresse, postnummer, bynavn,
  cpr?, andetTinLand?, andetTinNummer?, beholdAndetTin?, bopaelDk: true, bekraeft: true }` (se
  kommentaren i ruten for svar og fejlkoder). Appen må aldrig gemme CPR lokalt.
- Maskeret CPR: `GET /api/dac7/oplysninger` → `{ cpr: "010190-••••" | null }`.
- Ny fejl ved oprettelse/genopsætning af auktion: errcode **`BHD01`**, besked
  starter med `dac7_mangler:` – vis den og et link til skatteoplysningerne.
- Ny notifikationstype `skat` (påkrævet).

## Test (testdatabasen)

- Grænserne er testet i en transaktion, der rulles tilbage (30 salg ⇒
  indberetningspligtig; refunderet og tabt indsigelse tæller ikke; nytårsaften
  UTC tæller i Q1 dansk tid). Påmindelser/spærring og BHD01 på samme måde.
- Vil du se flowet i browseren: sæt årets kurs til 1 under Admin → DAC7 →
  Indstillinger (så er grænsen 2.000 kr.), og kør cron. Sæt kursen tilbage
  bagefter (7,46).
