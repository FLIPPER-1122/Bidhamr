# Plan mod lancering 1. marts 2027 (ny udgave)

Lavet 27. okt. 2026. **Regel: fra 1. januar 2027 kodes der ikke.** Alt teknisk skal være færdigt og køre live (rigtige penge, rigtig MitID, rigtig fragt, app i butikkerne) inden jul. Januar og februar er kun marketing, butikker og drift. Kun kritiske fejl rettes efter nytår.

**Mig** = Claude og agenterne. **Filip** = dig.

## Sådan bliver vi hurtigere
1. **Start alt, der afhænger af andre, NU – ikke når koden er færdig.** Stripe live-aktivering, advokat, revisor, Idura/MitID-produktion, Dinero, Google Play-konto og DAO-kontrakt tager uger hos andre. De kører parallelt med koden fra i dag.
2. **Funktionsstop 20. nov.** Derefter kun fejlrettelser, test og live-opsætning. Nye idéer går på en liste til efter lanceringen.
3. **Vælg Shipmondo nu** (egne DAO- og GLS-aftaler). Adapteren findes allerede, og den giver retur via API. DAO direkte lægges på hylden.
4. **Én udgivelse om ugen** (fx torsdag): jeg samler det færdige, reviewer og tester, du pusher, migrationerne køres samme dag. Ingen løse ender i flere uger.
5. **Gå live i det stille i december** (blød lancering på produktion med inviterede og små rigtige handler). Så er januar ikke første gang, noget kører med rigtige penge.
6. **Skær det fra, der ikke skal bruges til lanceringen:** statistik i appen og appens nye design (fase 5, 7B) flyttes til efter lanceringen, medmindre du siger andet.

## Nu – uge 44 (27. okt. – 1. nov.)
**Filip (start i dag, de tager tid)**
- Stripe: start live-aktiveringen (firma, bank, ID). Den kan aktiveres uden at gå live.
- Advokat: send betingelser, privatlivspolitik og `jura/noter-til-advokat.md`, og aftal svar senest 30. nov.
- Revisor: fakturaer, bogføring af Stripe-fakturaer (nr. 100) og DAC7, svar senest 30. nov.
- Idura: bestil MitID-produktion.
- Dinero: vælg den betalte plan.
- Google Play-udviklerkonto. Tjek, at Apple Developer er aktiv.
- Underskriv DAO-kontrakten, og bekræft Shipmondo (Essentials eller Pro) med Dea.
- Opgrader Resend.

**Mig**
- Gør dagens arbejde færdigt: måned 1-regel, fakturaer, skift af e-mail, kontaktinfo i beskrivelser, glidende gebyrer. Review, samlet test og prod-migrationer med dit ja.

## November – alt bygget og testet
**Uge 45-46 (2.-15. nov.)**
- Mig: fragt via Shipmondo med rigtige nøgler (labels, retur, sporing, ikke-afhentet). Appen: CAPTCHA, kode `indsigelse`, nyt TestFlight- og Android-build. Admin: staff må ikke kunne spærres ude.
- Filip: test appen på telefonen via TestFlight, og test firma-rejsen.

**Uge 47 (16.-22. nov.)**
- Mig: fejlrettelser fra dine tests. **Funktionsstop 20. nov.**
- Filip: send listen over det, der ikke virker.

**Uge 48 (23.-30. nov.)**
- Mig: stor sluttest af hele siden og appen, sikkerhedsgennemgang nr. 2, belastningstest, overvågning og backup.
- Filip: advokatens og revisorens svar skal være kommet.

## December – live
**Uge 49 (1.-6. dec.)**
- Mig: indarbejd advokatens og revisorens svar. Stripe live-opsætning (betalingsmetoder, webhooks, Connect, fakturaer, branding). MitID og Dinero i produktion.
- Filip: godkend betingelser og privatlivspolitik, og skift Vercel til live-nøgler sammen med mig.

**Uge 50 (7.-13. dec.)**
- Mig: send appen til App Store- og Play-gennemgang med sider, skærmbilleder og privatlivsoplysninger.
- Alle: **blød lancering**. Siden kører live med rigtige penge for inviterede (dig, familie, de første butikker). Små rigtige handler hele vejen igennem: betaling, fragt, udbetaling og faktura.

**Uge 51 (14.-20. dec.)**
- Mig: ret alt fra den bløde lancering. Appen godkendt (sat til manuel udgivelse 1. marts).
- **Teknik færdig 20. dec.** Herefter kun kritiske fejl.

**Jul**
- Siden kører i lukket tilstand. Jeg holder øje med drift.

## Januar 2027 – marketing og butikker (ingen kodning)
- Filip: videoerne efter udgivelsesplanen, venteliste og sociale medier. Onboard butikker (firmapakker), sælg Ugens butik for marts. Møder og presse.
- Mig: drift, overvågning og svar på spørgsmål. Kun kritiske fejl rettes.

## Februar 2027 – generalprøve (ingen kodning)
- Filip: butikkerne har auktioner klar til 1. marts. Pressemeddelelse.
- Mig: gennemgå go-live-listen (`HUSKELISTE.md`, `docs/GO-LIVE-STRIPE.md`, `docs/FRAGT.md`). Slå CAPTCHA og beskyttelse mod lækkede adgangskoder til. Sidste test på produktion 25. feb.

## 1. marts 2027 – lancering
- Slå `LANCERET`, `TILMELDING_AABEN` og `SEO_INDEKSERING` til, luk invitationsværnet, og udgiv appen.
- Jeg holder øje med drift, betalinger og fejl hele dagen.

## Det, der kan få planen til at skride
- **Stripe live-aktivering:** kan kræve ekstra dokumenter. Start i dag.
- **Advokat og revisor:** aftal en fast svardato.
- **Apples gennemgang:** første app kan blive afvist en eller to gange. Derfor sendes den allerede uge 50.
- **Idura/MitID-produktion:** kræver aftale og opsætning hos dem.
