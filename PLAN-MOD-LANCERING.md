# Plan mod lancering 1. marts 2027

Senest opdateret 27. okt. 2026. **Mig** = Claude og agenterne. **Filip** = dig.

**Regel:** fra 1. januar 2027 kodes der ikke. Alt teknisk skal være færdigt og køre live, med rigtige penge, rigtig MitID, rigtig fragt og app i butikkerne, inden **20. december**. Januar og februar er kun marketing, butikker og drift. Efter nytår rettes kun kritiske fejl.

---

## 1. Rækkefølgen og hvorfor
Princippet:
1. Først det, der har lang ventetid hos andre.
2. Dernæst det, alt andet bygger på.
3. Test og sikkerhed til sidst, når koden ligger fast.

| # | Hvad | Hvem | Hvorfor her |
|---|---|---|---|
| 1 | Stripe live-aktivering | Filip | Den længste ventetid. Alt med rigtige penge venter på den. |
| 2 | Advokat og revisor (betingelser, privatliv, fakturaer, DAC7) | Filip | Svarene tager uger, og meget afhænger af dem. |
| 3 | DAO-kontrakt + Shipmondo | Filip | Uden nøgler kan fragten ikke gøres færdig. |
| 4 | Idura (MitID-produktion) og Google Play-konto | Filip | Har ventetid. |
| 5 | Dinero (betalt plan) og Resend (opgradering) | Filip | Hurtigt. |
| 6 | Dagens arbejde på produktion | Mig | Grundlaget for alt andet. |
| 7 | Glidende gebyrer + blokering af kontaktinfo | Mig | Priser og regler skal ligge fast før den samlede test. |
| 8 | Fragt via Shipmondo | Mig | Den sidste store tekniske ukendte. |
| 9 | Appen: nyt design (7B), statistik, CAPTCHA, nye regler, nye builds | Mig | Appen er den primære platform og skal være helt i orden fra start. Den skal til Apple tidligt, fordi gennemgangen kan drille. |
| 10 | Admin: staff må ikke kunne spærres ude | Mig | Lille, men skal være lukket før lancering. |
| 11 | Dine tests i browser og på telefon | Filip | Når funktionerne er færdige. |
| 12 | Funktionsstop 20. nov. | Alle | Derefter kun fejlrettelser. |
| 13 | Stor sluttest + sikkerhedsgennemgang nr. 2 | Mig | Til sidst, på den endelige kode. |
| 14 | Svarene fra advokat og revisor indarbejdet | Mig | Når de er kommet. |
| 15 | Stripe live, MitID og Dinero i produktion | Begge | Når aktiveringerne er på plads. |
| 16 | Appen sendt til gennemgang | Mig | Uge 50. |
| 17 | Blød lancering med rigtige penge | Alle | Uge 50-51, så januar ikke er første gang. |
| 18 | Teknik færdig | Mig | 20. dec. |
| 19 | CAPTCHA slået til | Mig | Februar, når appen understøtter det. |

## 2. Sådan bliver vi hurtigere
1. **Eksterne ting startes nu**, ikke når koden er færdig.
2. **Funktionsstop 20. nov.** Nye idéer går på en liste til efter lanceringen.
3. **Shipmondo** (egne DAO- og GLS-aftaler) i stedet for DAO direkte. Den er bygget og giver retur via API.
4. **Én udgivelse om ugen.** Jeg samler det, der er færdigt, du pusher, og migrationerne køres samme dag.
5. **Blød lancering i december** på produktion med inviterede og små rigtige handler.
6. **Appen er den primære platform** (Filip, 27. okt.): nyt design (7B) og statistik kommer med før lanceringen. Vi starter dem i uge 45, så de er færdige til funktionsstoppet.

---

## 3. De næste 14 dage (til 10. nov.)
**Filip**
- [ ] Stripe: live-aktiveringen sendt ind (firma, bank, ID).
- [ ] Advokat og revisor: materialet sendt, svar aftalt senest 30. nov.
- [ ] Idura: MitID-produktion bestilt.
- [ ] Dinero (betalt plan), Google Play-udviklerkonto og opgraderet Resend.
- [ ] DAO-kontrakt underskrevet, og Shipmondo bekræftet med Dea. Plan og nøgler sendt til mig.
- [ ] Firma-delen testet på test.bidhamr.dk, især opret auktion og bankkonto-trinnet. Appen testet via TestFlight.
- [ ] `main` pushet, og ja givet til produktionsmigrationerne.

**Mig** (færdigt, reviewet, testet og på produktion)
- [ ] Måned 1-regel og fakturarettelser.
- [ ] Skift af e-mail.
- [ ] Kontaktinfo blokeret i beskrivelser.
- [ ] Glidende gebyrer.
- [ ] Sikkerhedsstramningen, med push-funktionen deployet igen.
- [ ] Fragt via Shipmondo med rigtige nøgler (labels, retur, sporing, ikke-afhentet). Kræver nøglerne.
- [ ] Appen: CAPTCHA, fejlkoden for indsigelse, visningsnavn, nye gebyrer og blokering. Nyt TestFlight-build + første Android-build.
- [ ] Admin: staff kan ikke spærres ude via login-loftet.
- [ ] Skift af e-mail: advarslen til den gamle adresse og log-ud af andre enheder skal sendes, selv hvis serveren dør midt i skiftet (outbox eller cron), og recovery-token ryddes igen efter skiftet (review 27. okt., småt 1-2).
- [ ] Samlet test af hele siden og appen, med fundene rettet.

---

## 4. Måned for måned

### November: alt bygget og testet
- **Uge 45-46 (2.-15. nov.)**
  - Mig: fragt via Shipmondo, appen (nyt design 7B, statistik, CAPTCHA og nye builds) og staff-login.
  - Filip: test appen og firma-delen.
- **Uge 47 (16.-22. nov.)**
  - Mig: fejlrettelser. **Funktionsstop 20. nov.**
  - Filip: send listen over det, der ikke virker.
- **Uge 48 (23.-30. nov.)**
  - Mig: stor sluttest, sikkerhedsgennemgang nr. 2, belastningstest, overvågning og backup.
  - Filip: advokatens og revisorens svar kommet.

### December: live
- **Uge 49 (1.-6. dec.)**
  - Mig: indarbejd advokat og revisor. Stripe live-opsætning (betalingsmetoder, webhooks, Connect, fakturaer, branding). MitID og Dinero i produktion.
  - Filip: godkend betingelserne. Skift Vercel til live-nøgler sammen med mig.
- **Uge 50 (7.-13. dec.)**
  - Mig: appen sendt til App Store- og Play-gennemgang.
  - Alle: **blød lancering** med rigtige penge for inviterede.
- **Uge 51 (14.-20. dec.)**
  - Mig: ret alt fra den bløde lancering. Appen godkendt, sat til manuel udgivelse 1. marts.
  - **Teknik færdig 20. dec.**
- **Jul:** siden kører lukket. Jeg holder øje med drift.

### Januar 2027: marketing og butikker (ingen kodning)
- Filip: videoer efter udgivelsesplanen, venteliste og sociale medier. Onboard butikker, og sælg Ugens butik for marts. Møder og presse.
- Mig: drift og overvågning. Kun kritiske fejl.

### Februar 2027: generalprøve (ingen kodning)
- Filip: butikkerne har auktioner klar. Pressemeddelelse.
- Mig: go-live-listen (`HUSKELISTE.md`, `docs/GO-LIVE-STRIPE.md`, `docs/FRAGT.md`). CAPTCHA og beskyttelse mod lækkede adgangskoder slås til. Sidste test på produktion 25. feb.

### 1. marts 2027: lancering
- Slå `LANCERET`, `TILMELDING_AABEN` og `SEO_INDEKSERING` til, luk invitationsværnet, og udgiv appen.
- Jeg holder øje med drift, betalinger og fejl hele dagen.

---

## 5. Åbne beslutninger (Filip)
- [x] En særpris udelukker velkomstrabatten for måned 1 (Filip, 27. okt.) – bygges.
- [x] En introrabat sat efter, at Starts gratis måned er i gang, gælder i måned 2-7 (Filip, 27. okt.).
- [x] Chefens pakkeskift i admin i en gratis periode er fortsat gratis for firmaet (Filip, 27. okt.).
- [x] Nej – appen er den primære platform, så statistik og nyt design kommer med før lanceringen (Filip, 27. okt.).
- [x] Shipmondo (med egne DAO- og GLS-aftaler) i stedet for DAO direkte (Filip, 27. okt.).

## 6. Det, der kan få planen til at skride
- **Stripe live-aktivering:** kan kræve ekstra dokumenter. Start i dag.
- **Advokat og revisor:** aftal en fast svardato.
- **Apples gennemgang:** første app kan blive afvist en eller to gange. Derfor sendes den i uge 50.
- **Idura/MitID-produktion:** kræver aftale og opsætning hos dem.
- **Fragt-nøgler:** uden dem kan fragten ikke testes med rigtige labels.

## 7. Henvisninger
- Beslutninger: `ROADMAP-BESLUTNINGER.md`
- Roadmap: `ROADMAP.md`
- Huskeliste til lanceringsdagen og sikkerhed: `HUSKELISTE.md`
- Stripe go-live: `docs/GO-LIVE-STRIPE.md` og `STRIPE-ERHVERV-NOTE.md`
- Fragt: `docs/FRAGT.md`
- Sikkerhed og CAPTCHA: `docs/SIKKERHED-AUTH.md`
