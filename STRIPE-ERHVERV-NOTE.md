# Erhvervsabonnement med Stripe Billing – tjekliste til Niels

Bygget 8. okt. 2026 i Stripes **testmiljø** efter Filips ønske (undtagelse fra Stripe-pausen). Regler: `ROADMAP-BESLUTNINGER.md` → "Erhvervskonti". Kode: `src/lib/erhverv/betaling.ts` (kører kun med `sk_test_`/`rk_test_`-nøgle), webhook `src/app/api/webhooks/stripe/route.ts`, database `supabase/migrations/20261010050000_erhverv_stripe.sql`.

## Hvad er bygget
- **Første betaling:** Firma oversigt → Abonnement → "Betal for din pakke" → Stripe Checkout (`mode: subscription`, kun kort) → retur til `/firma/abonnement?betaling=ok` (kvittering). Indtil da er firmaet `afventer_betaling` og kan ikke oprette auktioner (databasen, BHE02).
- **Opgradering:** `subscriptions.update` med `proration_behavior: always_invoice`, `payment_behavior: pending_if_incomplete`. Fakturaen for forskellen betales med det gemte kort; kræver den 3DS, sendes firmaet til `hosted_invoice_url`. `invoice.paid` (faktura med kun proration-linjer) → tjek af prisen → `firma_pakkeskift_betalt`. En opgradering, der ikke længere venter, annulleres (void); bliver den betalt alligevel, refunderes den automatisk, og prisen sættes tilbage (+ drift-alarm).
- **Nedgradering:** Subscription Schedule (2 faser, `proration_behavior: none`, `end_behavior: release`) – prisen skifter ved periodens slut. "Behold pakken" frigiver planen.
- **Opsigelse:** kun chef eller sælger i Admin → Erhverv → Firma ("Opsig abonnement") → `cancel_at_period_end`. `customer.subscription.deleted` → status `opsagt`. "Fortryd opsigelsen" findes også. (Filip, 10. okt. 2026: chef og sælger må alt ved firmaer – også pakkeskift; kun pakker/priser er kun chef.)
- **Opsigelse ved permanent lukning (10. okt. 2026, migration `20261016040000_erhverv_luk_opsigelse.sql`):** lukkes en firmakonto permanent (`bruger_luk_konto_permanent` via "3 advarsler"-forslaget eller DSA-indgrebet "luk konto"), opsiges abonnementet **med det samme**: `subscriptions.cancel(sub, { prorate: false, invoice_now: false, cancellation_details.comment })` – ingen kreditering/refusion for resten af perioden og ingen slutfaktura (testet: ingen kreditnota, kundesaldo 0; en Subscription Schedule annulleres med). `cancellation_details.reason` bliver `cancellation_requested`, så webhooken sætter firmaet til `opsagt` (også hvis det var på pause). Først lukkes åbne Checkout-betalinger; bagefter annulleres ventende opgraderingsfakturaer (void). Ubetalte fornyelsesfakturaer røres ikke (Stripe stopper selv automatisk opkrævning ved opsigelse).
  - **Hvem kalder:** `opsigVedLukning(brugerId)` i `after()` lige efter lukningen (`godkendKontoLukning` og `udfoerIndgreb` med `konto_lukket`) og `koerLukOpsigelser()` i betalings-cron'en (`/api/cron/afslut-auktioner`, hvert 5. minut). Cron'en finder kandidaterne ud fra **tilstanden** (`firma_luk_opsigelse_kandidater`: `users.konto_lukket_kl` sat + abonnement, der ikke er `canceled`/`incomplete_expired`) – så alle veje til lukning er dækket, også et abonnement, der starter efter lukningen (drift-alarm `erhverv/luk-nyt-abonnement`: refundér manuelt).
  - **Fejl:** lukningen rulles aldrig tilbage. `firma_luk_opsigelse_fejl` tæller `luk_opsigelse_forsoeg` op og sætter `luk_opsigelse_naeste_kl` (5 min, 10, 20 … højst 6 timer); drift-alarm `erhverv/luk-opsigelse` (kilde `cron` markerer kørslen som fejlet). Lykkes det, nulstiller `firma_luk_opsigelse_udfoert` forsøgene, sætter `luk_opsigelse_kl` og logger én linje i `moderation_log`.
  - **Idempotens:** Stripe ignorerer idempotency-nøgler på `DELETE`-kald (docs.stripe.com/api/idempotent_requests), og `subscriptions.cancel` er DELETE. Nøglen `luk:<bruger_id>:<subscription_id>` sendes alligevel, men sikkerheden ligger i, at abonnementet hentes frisk før kaldet (er det afsluttet, sker intet), at et gentaget cancel kun giver 404 `resource_missing` (som tjekkes frisk), og at opsigelsen ikke flytter penge. POST-kaldene (luk Checkout, void faktura) har nøgler med forsøgsnummer (`luk:<bruger>:<sub>:<forsøg>:…`), så et gemt fejlsvar ikke blokerer næste forsøg i 24 timer.
  - "Betal for din pakke" afvises for en lukket konto (`konto_lukket`). Genåbnes kontoen (omgjort DSA-afgørelse), står firmaet som `opsagt` med det gamle abonnements-id – et nyt abonnement skal aftales og sættes op af staff.
- **Mislykket betaling:** `invoice.payment_failed` → `firma_abonnement_mislykket`; cron `erhverv-betalingsfrist` (dagligt 04:07) pauser efter 7 dage; senere betaling genaktiverer.
- **Betalingskort:** Customer Portal, egen konfiguration (kun `payment_method_update` + `invoice_history`; opsigelse, pakkeskift og kundeoplysninger er slået fra).
- **Regninger:** `firma_regninger` spejles fra Stripe (nummer, beløb ekskl./inkl. moms, moms, `invoice_pdf`, `hosted_invoice_url`, status).

## Stripe-objekter (oprettes automatisk, idempotent, første gang de bruges)
| Objekt | Kendes på |
|---|---|
| Tax Rate "Moms" 25 %, DK, eksklusiv, `tax_type: vat` | `metadata.bidhamr = moms_dk_25` |
| Product pr. pakke | id `bidhamr_erhverv_<pakke-id uden bindestreger>` |
| Price pr. pakke og beløb (DKK, månedlig, `tax_behavior: exclusive`) | `lookup_key = erhverv_pakke_<pakke-id>_<øre>`; id gemt i `erhverv_pakker.stripe_price_id` |
| Customer pr. firma (navn, adresse, e-mail, `tax_id` eu_vat `DK<CVR>`, `preferred_locales: da`) | `metadata.firma_id`; id i `firmaer.stripe_customer_id` |
| Subscription (`default_tax_rates: [Moms]`, `metadata.firma_id`) | `firmaer.stripe_subscription_id` |
| Billing Portal-konfiguration | `metadata.bidhamr = erhverv_v1` |

Alle opret-/ændringskald har idempotency-nøgler (`idempotensNoegle` i `betaling.ts`); handlinger, der kan gentages med modsat virkning (opsig/fortryd, chefens pakkeskift, prisrettelser), får en ny UUID pr. klik.

## Webhook-events, der skal slås til (test)
På det **eksisterende** endpoint `https://bidhamr.dk/api/webhooks/stripe` (samme signatur-hemmelighed `STRIPE_WEBHOOK_SECRET`, ingen nye miljøvariabler):
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.pending_update_expired` – opgraderingen blev ikke betalt i tide: fakturaen annulleres, skiftet annulleres
- `invoice.finalized`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.voided` – regningen → "annulleret"; en ventende opgradering på fakturaen annulleres
- `invoice.marked_uncollectible` – regningen → "mislykket"
- `customer.updated` – kortet kan være skiftet i kundeportalen: mærke, sidste 4 cifre og udløb spejles
- `payment_method.attached` – nyt kort på kunden: spejles
- `payment_method.automatically_updated` – banken har opdateret kortet: spejles

## Nye pakker (26. okt. 2026, migration `20261102010000_firmapakker.sql`)
- **Pakker:** Start 499 kr. (10 auktioner/md), Butik 999 kr. (30/md, 5 fremhævninger, Ugens butik 50 % x 3), Pro 1.999 kr. (ubegrænset, 20 fremhævninger, Ugens butik 50 % x 5). Basis/Plus/Pro/Max er arkiveret ("<navn> (gammel)"); firmaer med abonnement får prisen skiftet i Stripe af betalings-cron'en (`koerAbonnementSynk`, fra næste betaling, ingen proration).
- **1 måned gratis:** Checkout får `subscription_data.trial_end` (= nu + `firmaer.proeve_maaneder` kalendermåneder) og `payment_method_collection: always` - kortet gemmes, 0 kr. trækkes nu. Kun første gang (aldrig en ny gratis periode efter en mislykket betaling). Firmaet er aktivt i den gratis periode (0-kr.-fakturaen er betalt -> `firma_abonnement_betalt`).
- **Introrabat:** kupon `bidhamr_intro_<procent>_<måneder>` (`duration: repeating`, metadata `bidhamr=intro`). Stripe tæller kuponens måneder fra den sættes på - også gratis måneder - så varigheden regnes (`introKuponMaaneder`), så rabatten rammer præcis N betalte fakturaer. Sættes på lige efter Checkout (webhooken `customer.subscription.created`) - aldrig i samme sekund som en faktura. Testet med test clock: 2 gratis måneder, 6 fakturaer med 50 %, så fuld pris.
- **Særpris:** firmaets egen Stripe-pris på pakkens produkt (lookup_key `erhverv_firma_<firma>_<pakke>_<øre>`, metadata `pakke_id` + `firma_id`). Bortfalder, når pakken skiftes (databasen, trigger `firmaer_saerpris_bortfalder`).
- **Gratis periode:** `trial_end` forlænges (eller lægges efter den betalte periode) med `proration_behavior: none`; en kørende introrabat sættes på igen med de resterende måneder.
- **Pakkeskift i den gratis periode** (op og ned) sker med det samme uden proration (`firma_pakkeskift_uden_betaling`).
- **Refusion af en regning:** kreditnota på alle linjer med `refund_amount = amount_paid` (idempotency key pr. regning), regningen -> `krediteret`.
- **Nye webhook-events** (samme endpoint): `customer.updated`, `payment_method.attached`, `payment_method.automatically_updated` (kortets mærke/sidste 4/udløb spejles). Slå dem til i Stripe (test).
- **Test mod Stripe:** `npm run test:firmapakker:stripe` (test clock, kort 4242/pm_card_visa).

## Rettelser efter review (8. okt. 2026)
- **Pakkeskift kun via serveren.** `firma_skift_pakke` kan ikke længere kaldes af `authenticated` (kun service role). Hjemmesiden og appen bruger samme kode (`src/lib/erhverv/pakkeskift.ts` → `firma_skift_pakke_server` → Stripe). Appen: `POST /api/firma/skift-pakke` med Bearer-token.
- **Transaktionelt:** fejler Stripe-kaldet ved opgradering (før abonnementet er ændret), nedgradering eller "behold pakken", rulles databasen tilbage (`firma_pakkeskift_rul_tilbage`), og firmaet får en dansk fejl. Chefens pakkeskift i admin ændrer Stripe FØRST (`skiftPrisAdmin`: åbne opgraderingsfakturaer annulleres, plan frigives, ny pris med `proration_behavior: none` – gælder fra næste betaling); fejler databasen bagefter, sættes prisen tilbage.
- **Fakturatype ud fra linjerne**, ikke `billing_reason`: almindelig abonnementslinje = fornyelse (`firma_abonnement_betalt`), kun proration-linjer = opgradering.
- **Pristjek (værn i dybden):** efter hver betalt fornyelse tjekkes, at fakturaens pris hører til firmaets pakke (`price.metadata.pakke_id`). Afviger den → drift-alarm (`erhverv/pris-afviger`). Prisen rettes kun automatisk (fra næste betaling), når abonnementet ikke har plan/ventende ændring, intet skift venter, og databasens pakke ikke er dyrere end det, firmaet betaler.
- **Opgradering:** skiftets id sættes i abonnementets metadata (`skift_id`), så webhooken altid finder skiftet. Før pakken aktiveres, tjekkes at abonnementets pris ER skiftet; ellers refunderes og annulleres skiftet. Ukendte opgraderingsfakturaer giver drift-alarm og kvitteres (ingen uendelige genforsøg).
- **Opsig/fortryd:** ny idempotency-nøgle (UUID) pr. klik, og abonnementet hentes frisk bagefter.
- **Genaktivering:** `firma_regninger.stripe_subscription_id` – kun mislykkede regninger fra det nuværende abonnement holder firmaet på pause.
- **Refusion af en opgradering** sætter kun prisen tilbage, når intet andet pakkeskift venter.

## Rettelser efter gen-review (8. okt. 2026, migration `20261010051000_erhverv_pakkeskift_laas.sql`)
- **Ét pakkeskift ad gangen pr. firma:** `firma_skift_pakke_server` sætter `firmaer.pakkeskift_i_gang_kl` + `pakkeskift_laas` i samme transaktion som skiftet. Et nyt skift (dobbeltklik, to faner, app + hjemmeside) afvises med BHE07 "Vi er ved at skifte din pakke …" (appen: 409 `i_gang`). Markeringen ryddes, når Stripe-delen er færdig eller rullet tilbage (`firma_pakkeskift_laas_frigiv` / `firma_pakkeskift_rul_tilbage`), og udløber selv efter 5 minutter.
- **Opsigelse** annullerer også den planlagte nedgradering i databasen (`firma_pakkeskift_annuller_planlagt`, note "Abonnementet er opsagt"). "Fortryd opsigelsen" genskaber den ikke, og `rul_tilbage` gendanner aldrig en nedgradering, mens abonnementet er opsagt. Nedgradering mens opsagt afvises med en dansk forklaring (BHE08).
- **Chefens pakkeskift** (`skiftPrisAdmin`): fejler Stripe midt i, eller databasen bagefter, sættes prisen tilbage, og det, der ikke kan genskabes i Stripe (frigivet plan, annullerede opgraderingsfakturaer), rettes i databasen (planlagt nedgradering annulleres) med drift-alarm `erhverv/admin-pakke-delvist` – firmaet skal vælge skiftet igen.
- **Betalt med det samme, men webhooken er ikke færdig** (`ProevIgen`): firmaet får "Betalingen er gået igennem. Din nye pakke bliver aktiveret om et øjeblik" – ikke "betalingen fejlede".
- `skift_id` fjernes fra abonnementets metadata, når skiftet er betalt, annulleret, udløbet eller refunderet.
- Refusionsloggen siger nu, om der faktisk blev refunderet (beløb), eller om der intet var at refundere.
- Spærrede/suspenderede/lukkede/slettede brugere kan ikke skifte pakke (BHE06).
- `POST /api/firma/skift-pakke` tjekker `Content-Length` og læser højst 1 KB af kroppen (413 ved for stor krop).

## Bør gennemgås
1. **Smart Retries / "efter sidste forsøg"** (Billing → Revenue recovery): anbefaling "mark subscription as unpaid" eller "leave past due". Vælges "cancel", sætter koden firmaet på pause og fjerner abonnementet, så firmaet må betale på ny med Checkout.
2. **Fast Tax Rate vs. Stripe Tax:** valgt fast 25 % (kun danske firmaer). Skal udenlandske firmaer med senere, skal det laves om (reverse charge).
3. **Fakturaindstillinger** i dashboardet: firmanavn/adresse/CVR for BidHamr på fakturaen, nummerering, fakturasprog, e-mail-kvitteringer til kunden.
4. **Pause af BidHamr** (staff sætter "Sat på pause"): Stripe trækker fortsat betaling. Skal det være `pause_collection`? (Pausen påvirker ikke opsigelsen ved permanent lukning – den opsiger også et firma på pause.)
8. **Opsigelse ved lukning uden refusion:** valgt, fordi beslutningerne ikke siger andet – Filip bekræfter. Ubetalte fornyelsesfakturaer efter lukning står åbne (uden automatisk opkrævning) – skal de annulleres?
5. **Dobbelt abonnement** (to Checkout-betalinger på samme tid): det nye abonnement stoppes automatisk + drift-alarm; betalingen skal refunderes manuelt.
6. **Live-skift (fase 6):** fjern test-nøgle-tjekket i `betaling.ts` (`stripe()`), og tjek at priser/Tax Rate/portal oprettes i live.
7. Kunden har ikke selv adgang til at ændre navn/adresse i portalen; ændres firmaoplysninger i admin, opdateres Stripe-kunden ikke automatisk endnu.

## Rettelser efter review (27. okt. 2026, migration `20261102020000_firmapakker_rettelser.sql`)
- **Introrabat i Checkout:** en aftalt introrabat sættes på allerede i Checkout-sessionen (`discounts: [{ coupon }]`), så Stripe viser prisen med rabat efter den gratis periode. Kuponens varighed regnes fra abonnementets oprettelse (`introKuponMaanederCheckout`: gratis måneder + N - 1). Aftalens nøgle står i abonnementets metadata (`intro_noegle`, `intro_kupon`), så webhooken kun spejler rabatten og ikke sætter en ny på.
- **Nedgradering beholder introrabatten:** Subscription Schedule-faserne får abonnementets rabatter med (`phases[].discounts: [{ discount }]` - genbruger den eksisterende rabat, samme slutdato). Uden dem arver en fase kun kundens rabatter. Testet med test clock.
- **Gratis måneder uden abonnement:** et firma, der har haft en gratis periode før, får staff-givne måneder oven i næste Checkout (`firmaer.proeve_ekstra_ventende`, metadata `gratis_ekstra`). Kan firmaet ikke starte et abonnement (fx opsagt), afvises handlingen, og der sendes ingen mail.
- **Dobbeltklik:** staff-hurtighandlingerne tager et valgfrit `klikId` (UUID fra formularen). Det er idempotency key i Stripe og unik nøgle i `erhverv_staff_klik`.
- **Prissynk efter flytningen:** cron'en frigiver en gammel plan og annullerer åbne opgraderingsfakturaer i Stripe, før prisen skiftes - kun når databasen ikke har et nyt ventende skift. Kandidaterne tages efter seneste forsøg (`stripe_synk_forsoegt_kl`).
- **Refusion:** findes kreditnotaen allerede (`metadata.regning_id`), spejles den. `refund_amount` = Stripes forhåndsberegnede kreditnota (`creditNotes.preview`), så rabatter regnes rigtigt. Testet med en faktura med introrabat.
- **Firmaoplysninger til Stripe:** ændres navn, CVR, adresse, telefon eller e-mail, opdaterer cron'en Stripe-kunden og bytter momsnummeret (`eu_vat` DK+CVR) ud (`synkKundeStripe`). En fejl i Stripe vælter aldrig databaseopdateringen.
