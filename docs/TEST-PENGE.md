# Pengetestene (sikkerhedsnet B)

To testsæt:

| Kommando | Kører mod | Tid | Hvad |
|---|---|---|---|
| `npm run test:penge` | **testdatabasen** (`.env.local`) og **Stripes testmiljø** | ca. 7-8 min | End-to-end: alle pengescenarierne med rigtige Stripe-betalinger, -refusioner, -indsigelser og -udbetalinger |
| `npm run test:penge:db` | PGlite (Postgres i processen) | ca. 5 sek | Migrationen `20261019020000_pengeafstemning.sql` (to gange) + afstemningens og CSV'ens regler. Ingen database, intet netværk |

## Sådan køres de

```
npm run test:penge:db
npm run test:penge
```

Fra en git worktree uden egen `.env.local`:

```
PENGE_ENV_FIL=C:/Users/jeppe/Desktop/hamr/.env.local npm run test:penge
```

`PENGE_LOG=1` viser testmails og webhook-logs (skjult som standard).

## Sikringer (testene nægter at køre ellers)

- `NEXT_PUBLIC_SUPABASE_URL` skal være testdatabasen `pjiigmzqwlfepxnjdvug` (produktionen `lkifkrexeldimmghnsie` afvises).
- `STRIPE_SECRET_KEY` skal være en testnøgle (`sk_test_`/`rk_test_`), og databasens `stripe_tilstand` skal være `test` og `destination`.
- Ingen rigtige mails (testdatabasen logger dem kun - `MAIL_TEST_MODTAGER` og `RESEND_API_KEY` fjernes), ingen Dinero/Shipmondo, ingen heartbeat.
- Webhooks signeres af testen selv med en tilfældig hemmelighed pr. kørsel og leveres til den rigtige rute (`/api/webhooks/stripe` - signaturen verificeres som altid). Testene afhænger derfor ikke af, at Stripe kan nå din maskine.

## Testdata

- **Faste TEST-brugere** (oprettes første gang, slettes aldrig - brugere kan ikke slettes, og `seed.sql` nægter at køre med over 50 brugere): `penge-saelger@`, `penge-saelger-bankfejl@`, `penge-koeber@`, `penge-fremmed@test.bidhamr.dk` (id `11111111-1111-4111-8111-0000000005e1..e4`), navne "TEST Penge …". Adgangskoden sættes tilfældigt ved hver kørsel og gemmes ingen steder.
- **Nye Stripe Connect-testkonti for hver kørsel** (oprettet færdige via API'et i testmiljøet: card_payments, transfers, manuel udbetalingsplan, DK-test-IBAN `DK5000400440116243`; bankfejl-sælgeren får `DK8003450003179681`, som afviser udbetalinger). Saldoen starter derfor altid på 0. Metadata `test = TEST pengetest`.
- **Hver handel** hedder `TEST pengetest: <scenarie> [<kørsel>]`. Auktionen slutter "for 8 dage siden", så pg_cron's `afslut_udloebne_auktioner` aldrig laver sin egen handel på den. Handel, leveringsvalg og betalingsrække skrives med service role (som `afslut_udloebne_auktioner` og checkout gør); alt derefter er den rigtige kode.
- **Oprydning:** handelsdata slettes aldrig (bogføringsloven). Hver test bringer pengene til en sluttilstand (udbetalt eller refunderet), annullerer ubetalte handler som admin (`admin_annuller_ikke_betalt` - ingen "ubetalt vinder"-advarsel), annullerer åbne PaymentIntents hos Stripe, arkiverer auktionen og lukker drift-tilfælde for betalingen. `99-slutafstemning` tjekker til sidst, at saldoen på begge testkonti hos Stripe er præcis det, databasen siger (`skyldigOere`), og at overvågningen ikke finder afvigelser.

## Scenarierne (`tests/penge/`)

| Fil | Scenarie | Testkort |
|---|---|---|
| 01 | Betal → køberen godkender (frigivelse) → payout til banken → `payout.paid`. Gebyret = købergebyr + sælgergebyr + fragt + Beskyttelse; sælgeren står med bud − sælgergebyr | `pm_card_bypassPending` (4000 0000 0000 0077) |
| 02 | Sag med medhold (skadet, BidHamr Beskyttelse) → ankefristen udløber → refusion af alt undtagen Beskyttelsen i tre trin (gebyr-refusion, tilbageførsel, refusion). BidHamr beholder præcis Beskyttelsen. Gentaget afvikling flytter intet | 0077 |
| 03 | Fuld refusion (admin) og idempotens; refusion efter udbetaling afvises; refusion lavet i "dashboardet" uden tilbageførsel markeres til staff og kan ikke udbetales | 0077 |
| 04 | Ikke-afhentet pakke: R = 0 (køber 0, sælgerens del tilbageført) og R < U (køber bud − returfragt, hele U tilbageført) | 0077 |
| 05 | Indsigelse før udbetaling: frosset, frigivelse afvist; tabt → sælgerens del hentet tilbage; gentaget event/cron henter ikke igen | `pm_card_createDispute` (…0259) |
| 06 | Indsigelse tabt efter udbetaling: intet trækkes fra sælgeren, BidHamr bærer tabet | 0077 (se note) |
| 07 | Tidligt svindelvarsel stopper udbetalingen - fra webhooken, og fundet af Stripe-tjekket før udbetaling (F03) uden webhook | `pm_card_createIssuerFraudRecord` (…5423) |
| 08 | Webhooks: falsk og forældet signatur (400), charge-event før betaling, forældet `payment_failed` efter betaling, samme event to gange, nyt event for samme betaling, `payout.paid` to gange, `balance.available` | 0077 |
| 09 | Mistet webhook: betalingen samles op af overvågningen (`opsamlUdebleveneBetalinger`), transferen hentes frisk, og udbetalingen virker uden en eneste webhook | 0077 |
| 10 | `payout.failed`: pengene tilbage på kontoen, sælgeren "venter på bank", ingen ny udbetaling før bankkontoen er rettet; derefter én ny udbetaling | 0077 + IBAN …9681 |
| 11 | To samtidige cron-kørsler + `balance.available` på samme tid → én payout med begge handler | 0077 |
| 12 | Beløbsmanipulation (RLS, ændret PaymentIntent rettes før betaling, forkert beløb betalt → ikke registreret, refunderet, ny PaymentIntent) og betaling for en andens handel (fremmed, sælgeren selv, uden login) | 0077 |
| 98 | Den daglige afstemning mod Stripes rigtige testdata: finder dashboard-refusionen og -tilbageførslen fra 03 og intet på BidHamrs egne bevægelser (se note) | - |
| 99 | Slutafstemning: saldo hos Stripe = databasen på begge testkonti; overvågningen finder intet | - |

### Noter

- **09 og 11 kører cron-trin mod ALLE data i testdatabasen**, ikke kun testens egne: `opsamlUdebleveneBetalinger` (09) slår alle ventende betalinger op hos Stripe og spejler dem, der er betalt, og `udbetalVentende`/`udbetalForKonto` (11) kører for pengetest-sælgeren. Det er det samme, betalings-cron'en gør hvert 5. minut, men det kan røre andres testdata i testdatabasen (fx spejle en betaling, en anden test har betalt uden webhook). Kør dem ikke, mens en anden tester midt i et betalingsflow uden webhooks. 98 kører hele afstemningen og registrerer afvigelser for alt i Stripes testkonto de seneste 24 timer.

- **Test clocks** bruges ikke: de findes kun for Stripe Billing (kunder/abonnementer), ikke for betalinger, Connect-saldi og payouts. Tid simuleres i stedet i databasen (fx sagens `penge_flyttes_efter_kl`).
- **06:** Stripes testmiljø kan kun lave en indsigelse i samme øjeblik som betalingen (0259), og så stopper BidHamrs tjek før udbetaling netop udbetalingen. Betaling, frigivelse og payout er rigtige; dispute-objektet (status `lost`) for den rigtige charge er simuleret i testen.
- **07:** 5423-kortet lægger pengene som afventende i 7 dage, så den almindelige udbetaling venter alligevel - Stripe-tjekket (F03) kaldes derfor direkte.
- **98** kræver migrationen `20261019020000_pengeafstemning.sql` på testdatabasen (kørt 11. okt. 2026). Den kører den rigtige afstemning (tvunget, vindue 1 døgn) og læser afvigelserne i `penge_afstemning_afvigelser`. Afvigelser, testen selv laver (dashboard-refusionen fra 03), markeres løst af testen bagefter. Afstemningen kører i sin egen rute (`/api/cron/afstemning`, pg_cron-job `pengeafstemning`), ikke i betalings-cron'en; testen kalder `koerPengeafstemning` direkte.
- **Ikke testet end-to-end:** udeblevet `payout.paid` (overvågningen venter, til Stripe's ankomstdato + 1 time er passeret - testpayouts ankommer først næste midnat) og Express-sælgerens egen onboarding (testene bruger API-oprettede testkonti).
