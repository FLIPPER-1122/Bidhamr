# Fakturaer på BidHamrs egne ydelser (Dinero)

Bygget 9. okt. 2026 (ROADMAP fase 1: "Automatiske fakturaer på BidHamrs egne gebyrer"). Kun Dineros testregnskab ("BidHamr Test") og Stripes testmiljø indtil Filip går live.

Kode: `src/lib/faktura/` (dinero.ts, konfig.ts, proces.ts, koe.ts, data.ts, tekster.ts). Migration: `supabase/migrations/20261012080000_fakturaer.sql`. Visning: `/konto/fakturaer`, handelssiden (`src/components/faktura/FakturaBoks.tsx`), firma-dashboardets Regninger, Admin → Fakturaer (kun chef). PDF: `GET /api/faktura/<id>`.

## 1. Hvad der laves

| Hændelse | Dokument i Dinero | Til | Linjer (alle beløb inkl. 25 % moms) |
|---|---|---|---|
| Køber har betalt (BidHamrs gebyr er trukket hos Stripe) | Faktura | Køber | Købergebyr (5 %), Fragt, BidHamr Beskyttelse |
| Samme betaling | Faktura | Sælger (firma: med CVR og adresse) | Sælgergebyr (5 %) |
| Betalingen refunderes (hele BidHamrs gebyr tilbage) | Kreditnota for hver faktura | Køber og sælger | Alle linjer |
| Refusion efter sag med medhold (BidHamr beholder BidHamr Beskyttelse) | Kreditnota for hver faktura | Køber og sælger | Køber: købergebyr + fragt. Sælger: sælgergebyr |
| Ikke-afhentet pakke refunderet (køberen får købsbeløbet minus gebyrer og fragt begge veje) | Kreditnota for sælgers faktura + ny faktura til køberen (`slags = 'returfragt'`) | Sælger / køber | Sælger: sælgergebyr (krediteres helt - sælgeren fik intet). Køber: ingen kreditnota (købergebyr, fragt og Beskyttelse refunderes ikke) + "Returfragt (pakken blev ikke afhentet)" på fragtkontoen |
| Køb af boost-point betalt (BidHamrs egen omsætning, `slags = 'boost'`, `boost_koeb_id`, ingen handel) | Faktura | Køber | "Boost-point (100 point)" på salgskontoen (1000 m/moms) – dateret betalingsdagen |
| Boost-køb refunderet (chefen eller Stripe-dashboardet) | Kreditnota | Køber | Samme linje – dateret refusionsdagen |
| Erhvervsabonnement betalt (Stripe Billing) | Finansbilag i kassekladden, Stripe-fakturaen vedhæftet | – (firmaet har Stripes faktura) | Abonnement (salg m/moms) |
| Abonnementsfaktura refunderet | Modpostering i kassekladden | – | Samme beløb negativt |

- Kun betalinger i betalingsmodellen destination (`betalinger.pengemodel = 'destination'`) faktureres. Gamle betalinger fra den tidligere model ("separate charges and transfers", `separat`) faktureres ikke – de findes kun i testdatabasen; produktionen har ingen.
- Fragtlinjen er `betalinger.fragt_oere` (låst ved betalingen) og hedder efter købers leveringsvalg i checkout: "Fragt (levering til pakkeshop)" eller "Fragt (levering til døren)" (`handel_levering.maade`). Afhentning = ingen fragtlinje.
- Ingen faktura på selve varen (privatsalg). Faktura på varen ved firmasalg er IKKE bygget (venter på revisor, `jura/noter-til-advokat.md` nr. 95).
- Momsen udskilles af Dinero pr. linje: netto = beløb × 4/5 afrundet til hele øre, moms = resten (fx købergebyr 12,35 kr. = 9,88 + 2,47 moms). Verificeret mod sandkassen: totalen i Dinero er altid præcis det beløb, Stripe har trukket.
- Konti (kan ændres med miljøvariabler): gebyrer, BidHamr Beskyttelse og abonnement på **1000 "Salg af varer/ydelser m/moms"** (U25), fragt på **1350 "Salg af fragt – momspligtig"** (U25), betalinger på **55000** (se afsnit 4).
- Fakturaen er "Betalt" (betalingsbetingelse Betalt, og betalingen registreres med Stripe-id'et), så den aldrig står som ubetalt i Dinero, og PDF'en siger "Fakturaen er betalt".
- Kreditnotaen knyttes til fakturaen (Dinero modregner den automatisk), og refusionen registreres som en negativ betaling på fakturaen ("Refunderet via Stripe"), så fakturaen står som betalt netto.
- Kommentaren på fakturaen: varens titel, handels-id og betalingsdato ("Betalt via vores betalingspartner Stripe den …"). Firmaer får adressen på fakturaen; private kun navn og e-mail (adressen kommer med over 3.000 kr., hvis den findes – forenklet faktura under 3.000 kr. kræver ikke adresse).
- Kontakter: én Dinero-kontakt pr. bruger (navn + e-mail; firmaer også CVR og adresse), oprettet første gang og genbrugt (`faktura_kontakter`). Ændres navn/e-mail/CVR/adresse, opdateres kontakten før næste faktura. En slettet konto røres ikke.

## 2. Hvornår (chefens valg – Filip kan ændre)

**Fakturaen dateres og laves på betalingsdagen, og en refusion giver en kreditnota.** Opgaven foreslog "når handlen er endelig (frigivet/udbetalt)". Det sikreste er betalingsdagen:

1. **Momsen forfalder senest, når betalingen modtages** (momsloven § 23, stk. 3 – forudbetaling). BidHamrs gebyr trækkes hos Stripe i det øjeblik, køberen betaler. Venter fakturaen til frigivelsen (dage eller uger senere, fx ved en sag), kan omsætningen lande i en senere momsperiode end den, hvor pengene blev modtaget.
2. **Bogføringsloven** kræver, at transaktioner registreres løbende. Gebyret er en pengebevægelse på BidHamrs Stripe-konto den dag.
3. Annulleres handlen bagefter, er en kreditnota den korrekte måde at tilbageføre på (fakturaer slettes aldrig).

Er fakturaen selv stoppet, håndteret manuelt eller oprettet som "skal laves manuelt", laves kreditnotaen (og en abonnements-modpostering) også som "skal laves manuelt" med teksten "Fakturaen blev håndteret manuelt – lav kreditnotaen manuelt i Dinero".

Konkret: en faktura laves, når betalingen er gennemført og BidHamrs gebyr er spejlet fra Stripe (`betalinger.betalt_kl` og `stripe_application_fee_id`). Kreditnotaen laves, når refusionen er gennemført (`refunderet_kl`) – for præcis det, BidHamr har givet tilbage af sit gebyr (`refusion_gebyr_oere`). Passer det beløb hverken med "alt" eller "alt undtagen BidHamr Beskyttelse", laves INGEN automatisk kreditnota; den står under Admin → Fakturaer som "skal laves manuelt".

**Ikke-afhentet pakke** (`20261016030000_ikke_afhentet_pakke.sql`, revisor bør bekræfte bogføringen): BidHamr beholder købergebyr, fragt, BidHamr Beskyttelse og returfragten (= total − refusion; højst buddet – er returfragten større, dækker BidHamr resten) og intet sælgergebyr. Derfor: sælgerens faktura krediteres helt, købers faktura står uændret, og returfragten faktureres køberen på en ny faktura (`fakturaer.slags = 'returfragt'`, dateret refusionsdagen, fragtkonto). Begge laves kun automatisk, når Stripe-trinnene passer præcis med planen (`faktura_ikke_afhentet_ok`: gebyr-refusion G = R − min(U, R), tilbageførsel gennemført, og det BidHamr står tilbage med = total − R = købergebyr + fragt + Beskyttelse + beholdt returfragt) – ellers "skal laves manuelt". Får køberen 0 kr. (returfragten er mindst buddet), sker der ingen Stripe-refusion: sælgerens del tilbageføres, betalingen afsluttes som refunderet, og fakturaerne laves på samme måde (sælgers kreditnota; returfragt-faktura på buddet), dateret tilbageførselsdagen.

Skal Filip/revisoren hellere have fakturaen ved frigivelsen, er det én betingelse i `faktura_planlaeg` (`x.betalt_kl` → `x.frigivet_kl`) – men så skal annullerede handler, der er betalt og refunderet før frigivelsen, slet ikke have faktura/kreditnota, og momsperioden skal vurderes (spørgsmål til revisor nr. 97).

## 3. Sådan virker køen (idempotens)

1. Betalings-cron'en (`src/lib/betaling/cron.ts`, trin 11) kalder `koerFakturaKoe()`.
2. `faktura_planlaeg()` (databasen) opretter de rækker i `fakturaer`, der mangler – én pr. handel pr. part pr. dokument (unikke indeks). Linjer og beløb låses i rækken (trigger) og kan aldrig ændres.
3. `faktura_claim(8)` tager op til 8 dokumenter med en lås på 10 min. Hvert dokument behandles trin for trin (`proces.ts`), og Dineros tilstand læses før hvert trin:
   - Kontakt: guid reserveret i databasen FØR Dinero kaldes.
   - Faktura/kreditnota: oprettes med **vores guid = `fakturaer.id`**. Findes den allerede (genforsøg), svarer Dinero 409 – den genbruges. Kontrol: kontakt, beløb og linjer skal passe, ellers stop til staff. Bogføres, nummer og moms gemmes.
   - Betaling: registreres kun, hvis der ikke allerede er en betaling med samme reference (`bidhamr-betaling-<id>` / `bidhamr-refusion-<id>`), og restbeløbet passer præcis.
   - PDF'en gemmes privat i storage-bucket `fakturaer` (kun service role).
4. Fejl: spredte forsøg (5, 10, 20, 40 min), efter 5 fejl "opgivet" + drift-alarm `faktura/dinero` (som refusionskøen). Dinero afviser indholdet (fx et ugyldigt CVR-nummer): stoppet med det samme + drift-alarm. Dineros grænse (60 kald i minuttet → 429) bruger ikke et forsøg. Tidsbudget: højst 8 s pr. kald, og nye dokumenter påbegyndes ikke efter 20 s (højst ca. 45 kald pr. kørsel), så betalings-cron'en ikke trækker ud.
5. Drift-alarmer: én pr. dokument, der oprettes eller ender som "kræver handling" (også dem, planlægningen selv opretter som manuelle), og én samlet (`faktura:haenger`), når dokumenter har ventet over 2 timer – også når Dinero er sat op. Dinero afviser login (token/nøgler): `faktura:adgang`. Forkert opsætning eller forkert regnskab: `faktura:konfiguration`.
   **Systemlampen "Fakturaer"** på admin-forsiden (`src/lib/admin/fakturaLampe.ts`, 20. okt. 2026) læser køen direkte i databasen, så den også slår ud, hvis køen slet ikke kører (fx Dinero ikke sat op, eller ingen kalder betalings-cron'en): gul, når et dokument har ventet over 2 timer eller kræver handling; **rød**, når et dokument har ventet over 6 timer, eller når `faktura:adgang`/`faktura:konfiguration` er åbne. Også rød på testdatabasen.
   **Regnskabs-værnet** (`kontrollerOrganisation` i `konfig.ts`, Filip 20. okt. 2026): før HVER kørsel spørger køen Dinero, hvilket regnskab nøglen og `DINERO_ORG_ID` peger på (`GET /v1.1/organizations`). Live: regnskabet skal have BidHamrs CVR 46836219. Test: regnskabet skal hedde **"BidHamr Test"** (eller "BidHamr Test …" med et tillæg) og må ikke have BidHamrs CVR – så test aldrig sender til **"Bidhamr ApS"**, det rigtige regnskab. Ellers sendes intet, og der gives drift-alarm. Testet i `tests/enhed/fakturaKonfig.test.ts` og `tests/enhed/fakturaKoeVagt.test.ts`.
6. Admin → Fakturaer (kun chef): "Har ventet over 2 timer", "Kræver handling", "Prøv igen" (logges: `proevet_igen_af`/`_kl`) og "Markér som håndteret i Dinero" (med note, logges: `haandteret_af`/`_kl`). Chefen kan ikke behandle et dokument, hvor han selv er modtager, køber eller sælger (inhabil).
7. Abonnement refunderet: modposteringen dateres refusionsdagen – Stripes tidspunkt for den seneste gennemførte refusion (dansk tid). `firma_regninger.krediteret_kl` sættes af en trigger, når status bliver krediteret, og udfyldes bagud fra Stripe for regninger, der var krediteret før migrationen (`faktura_regning_krediteret_kl`); og før den bogføres, slås det op hos Stripe, hvor meget der faktisk er refunderet. Kun en fuld refusion bogføres automatisk – en delvis stoppes til staff. Det gælder også en abonnementsfaktura, der delvist er betalt med kredit (firmaets saldo hos Stripe): Stripe kan højst refundere det betalte, som er mindre end fakturaens beløb, så den går altid til staff ved refusion.
8. En kreditnota/modpostering, der venter, når dens faktura/bilag bliver håndteret manuelt (eller stoppet som manuel), sættes ved næste kørsel til "kræver handling" (manuel, én drift-alarm) – "Prøv igen" svarer da, at den skal laves manuelt. Listen "Har ventet over 2 timer" har "Prøv igen nu" og "Markér som håndteret i Dinero".

Verificeret i sandkassen: et genforsøg efter et tabt svar (både efter bogføring og efter betaling) gav præcis én faktura og én betaling.

## 4. Det skal Filip gøre for at gå live i Dinero

1. Revisoren bekræfter Dinero (ROADMAP fase 1) og svarer på spørgsmålene i `jura/noter-til-advokat.md` nr. 93 og 97–104.
2. I det rigtige Dinero-regnskab (Pro eller Total): **Indstillinger → Virksomhed**: firmanavn **Bidhamr ApS**, CVR **46836219**, Ellegårdsvej 40, 4684 Holmegaard, e-mail og evt. logo (står på hver faktura). Fakturaskabelonen kan tilpasses (logo, farver).
3. Kontoplan: tjek at 1000 og 1350 har momskode U25. **Opret en egen likvid konto "Stripe"** (fx 55100) – pengene står på Stripe, ikke i banken, indtil Stripe udbetaler – og sæt `DINERO_KONTO_INDBETALING` til den (revisoren bestemmer).
4. **Integrationer → API-nøgler → Personlig integration**: hent client id og secret, og lav en API-nøgle for regnskabet. Organisations-id står i Dinero (eller hentes med `GET /v1/organizations`).
5. Sæt miljøvariablerne i Vercel (Filip selv – agenter rører dem ikke): `DINERO_CLIENT_ID`, `DINERO_CLIENT_SECRET`, `DINERO_API_KEY`, `DINERO_ORG_ID`, `DINERO_MILJOE=live`, `DINERO_LIVE_ORG_ID` (= det rigtige regnskabs id), `DINERO_KONTO_INDBETALING` (og evt. `DINERO_KONTO_SALG`/`DINERO_KONTO_FRAGT`). Produktionen nægter at lave fakturaer uden `DINERO_MILJOE=live` (undtagen testregnskabet, mens Stripe kører med testnøgle – se nedenfor), og med `live` skal `DINERO_ORG_ID` være præcis `DINERO_LIVE_ORG_ID` (så sandkassens nøgler aldrig kan få rigtige kunders fakturaer). Testdatabasen nægter `live` og nægter at bruge `DINERO_LIVE_ORG_ID`. Dineros API har intet "demo"-flag på organisationen, så derudover tjekkes det før hver kørsel i live, at regnskabet har BidHamrs CVR 46836219 (`GET /v1.1/organizations`) – ellers laves intet, og der gives drift-alarm. Sæt derfor CVR i Dinero (punkt 2) før go-live.
6. Kør migrationen `20261012080000_fakturaer.sql` i produktion (Filips "ja").
7. Tjek Admin → Fakturaer: "Dinero: sat op (live-regnskab …)". Første betaling → faktura i Dinero inden for få minutter.

Før det er sat op, laves der ingen fakturaer – men rækkerne planlægges, og de laves alle, når Dinero er sat op (drift-alarm og gul lampe efter 2 timer, rød lampe efter 6 timer).

**Indtil revisoren har godkendt live (20. okt. 2026):** produktionen bruger testregnskabet "BidHamr Test" med `DINERO_MILJOE=test`. Det er kun tilladt, når det er valgt udtrykkeligt (tom værdi afvises i produktionen), og når Stripe kører med testnøgle (`sk_test_`/`rk_test_`) – så er betalingerne heller ikke rigtige. Med Stripes live-nøgle kræver produktionen `DINERO_MILJOE=live`. Vercel-variablerne står i HUSKELISTE.md ("Fakturaer i produktion").

## 5. Abonnementet (chefens valg – Filip kan ændre)

Opgaven foreslog "en faktura i Dinero, der henviser til Stripe-fakturaen". Stripe Billing har allerede udstedt en faktura med nummer og moms til firmaet. En ny faktura i Dinero på samme ydelse ville give firmaet **to fakturaer med moms for samme ydelse** (risiko for dobbelt moms, momsloven § 52, stk. 5, og forvirring hos firmaet). Derfor bogføres den betalte Stripe-faktura som et **finansbilag** i Dineros kassekladde (debet indbetaling, kredit 1000 m/moms) med Stripe-fakturaens PDF som bilag og fakturanummeret i teksten. Firmaet ser stadig Stripes faktura under Regninger. Refunderes en abonnementsfaktura, laves en modpostering. Revisoren bør bekræfte (nr. 100).

## 6. Hvad brugeren ser

- **Min konto → Fakturaer** (`/konto/fakturaer`): alle egne fakturaer og kreditnotaer med linjer, moms og "Hent faktura (PDF)". Undervejs: "Fakturaen er på vej – den er klar om få minutter."
- **Handelssiden**: boksen "Fakturaer fra BidHamr" for handlen (køber og sælger ser kun deres egen).
- **Firma oversigt → Regninger**: Stripes abonnementsfakturaer som før + "Fakturaer på gebyrer" (sælgergebyret med CVR).
- **Mails**: kvitteringen til køberen (forsendelse og afhentning) og afregningen til sælgeren har et link til Min konto → Fakturaer.

## 7. Appen (Expo)

- Liste: `supabase.rpc("mine_fakturaer", { p_trade })` (`p_trade` valgfri, kun én handel) → `[{ id, dokument: 'faktura' | 'kreditnota', part: 'koeber' | 'saelger', trade_id, titel, nummer, dato: 'ÅÅÅÅ-MM-DD', beloeb_oere, moms_oere, linjer: [{ tekst, beloeb_oere }], klar, krediterer_nummer }]` (nyeste først, kun egne; beløb inkl. moms i øre; `nummer` er null, til `klar` er true).
- PDF: `GET https://bidhamr.dk/api/faktura/<id>` med `Authorization: Bearer <session.access_token>` → `application/pdf`. 401 = log ind igen, 404 = findes ikke/ikke din/ikke klar endnu, 429 = vent (60 i timen). Åbn den med appens PDF-visning eller del den.
- Samme tekster som hjemmesiden: `src/lib/faktura/tekster.ts`.

## 8. Test (9. okt. 2026)

- **Migrationen** (PGlite mod en stub af tabellerne – testdatabasen kunne ikke migreres fra agenten): 69 kontroller – planlægning (køber/sælger, afhentning, firma, gebyr der ikke passer, fee ikke spejlet, dansk dato), kreditnotaer (fuld, medhold uden Beskyttelse, ukendt gebyr-refusion → manuel), abonnement (moms 25 %, prorateret, forkert moms → manuel, refunderet → modpostering), lås/claim, statusrækkefølge, låste felter, ingen sletning, backoff og "opgivet" efter 5, 429 uden forsøg, chef-handlinger, kontakter, `mine_fakturaer`, RLS og kolonne-rettigheder.
- **Dinero-sandkassen** (rigtig kode fra `src/lib/faktura`, rigtige betalinger fra testdatabasen): kontakter (privat og firma; testfirmaets CVR 12345678 afvises af Dinero → stoppet → CVR rettet → "Prøv igen" → ok), køber- og sælgerfakturaer bogført og betalt, kreditnotaer ved sag med medhold (BidHamr Beskyttelse beholdt), PDF hentet (fra storage og fra Dinero), abonnementsbilag bogført med Stripe-PDF vedhæftet (moms 249,99 af 1.249,96 kr. – samme som Stripe), modpostering ved refusion, genforsøg efter tabt svar uden dubletter, Dineros 429 håndteret.
