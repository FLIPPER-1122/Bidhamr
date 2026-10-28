# Faktura fra firma til køber

Beslutning: ROADMAP-BESLUTNINGER.md, "Faktura fra firma til køber – klar til afsendelse (Filip, 27. okt. 2026)" og "Oplysninger til fakturaen indsamles ved oprettelse".
Migration: `supabase/migrations/20261102330000_firma_fakturaer.sql` (kørt på testdatabasen 28. okt. 2026).

**Firmaet udsteder og sender fakturaen. BidHamr er kun værktøjet.**

## Intet sendes automatisk

- Status `sendt` kan kun sættes af `public.firma_faktura_send(p_id)`. Den kræver `auth.uid()` = firmakontoen bag fakturaen. Service role, cron, webhooks og triggere har intet `auth.uid()` og bliver afvist (42501).
- Triggeren `firma_fakturaer_laas` afviser alle andre veje til `sendt`, også en direkte `UPDATE` med alle felter udfyldt.
- I koden kaldes `firma_faktura_send` kun fra server action'en `sendFirmaFaktura` (`src/app/actions/firmaFaktura.ts`). Den kaldes kun fra knappen "Ja, send" i `FirmaFakturaKnapper`, efter bekræftelsen "Send faktura nr. … til …?".
- Appen kan ikke sende. Firmaer administrerer på computeren.
- Testene `tests/enhed/firmaFaktura.test.ts` ("ingen automatisk afsendelse") og `tests/penge-db/firmaFakturaer.test.ts` holder reglen.

## Flow

1. **Køberen betaler.** Triggeren `betalinger_firma_faktura_kladde` laver en kladde (`firma_fakturaer`, status `kladde`). Triggeren fanger alle fejl, så den aldrig vælter betalingen. Kladder til ældre salg laves, når firmaet åbner sine fakturaer (`firma_fakturaer_liste`).
2. **Momsordningen låses på kladden:** auktionens `momsordning`, ellers firmaets standard.
3. **Firmaet ser kladden** (Firma oversigt → Fakturaer eller Salg → "Se din faktura"). Det kan rette købers navn og adresse, leveringsdato og varetekst og tilføje købers firmanavn og CVR.
4. **Send er spærret**, så længe der mangler noget: købers navn, adresse, postnummer, by eller e-mail. Det samme gælder, hvis købet er betalt tilbage. Et spærret forsøg bruger intet nummer.
5. **"Send" + bekræftelse.** I én transaktion låses firmaets indstillinger (`for update`). Næste nummer tages, øjebliksbilledet (`data`) gemmes, og status bliver `sendt`. Derefter laves PDF'en, som gemmes i den private bucket `firma-fakturaer`, og mailen sendes via Resend.
6. **Mail:** afsender `"Firmanavn via BidHamr" <noreply@bidhamr.dk>`, reply-to og bcc (kopi) til firmaets svar-e-mail (indstillinger, ellers `firmaer.kontakt_email`) og PDF'en vedhæftet. Fejler mailen, er fakturaen stadig udstedt. Firmaet ser en advarsel og kan selv trykke "Send mailen igen".
7. **Rettelser:** en sendt faktura kan aldrig ændres eller slettes (trigger). Det eneste, der kan ændres, er PDF-stien (én gang) og mailstatus. Rettelser sker med "Lav kreditnota": en fuld kreditnota med modsat fortegn, et eget nummer i samme serie og en henvisning til fakturaen. Der kan laves én kreditnota pr. faktura.

## Nummerserie

- Hvert firma har sin egen serie i `firma_faktura_indstillinger`: præfiks, `naeste_nummer` og antal cifre, fx `BH-0001`. Standarden er `F-0001`.
- Nummeret tildeles først ved afsendelsen. Nummeret er fortløbende og uden huller: rækkelåsen gør, at samtidige afsendelser venter på hinanden, og et unikt indeks `(firma_id, nummer)` er ekstra værn.
- Præfiks, startnummer og cifre kan kun ændres, før den første faktura er sendt (BHF11).
- Samtidige afsendelser er testet på testdatabasen 28. okt. 2026. Session A tog F-0003 og holdt låsen i 30 sekunder. Session B startede, mens A holdt låsen, ventede og fik F-0004.

## Indhold og beløb

- **Linjer:** kun varen. Beløbet er buddet inkl. moms (`betalinger.bud_oere`), antal 1, med titel og stand. Firmaet får hele buddet (prismodel `erhverv2`).
- **Fragt står ikke på firmaets faktura.** Fragten betales til BidHamr (application fee) og går videre til fragtfirmaet, så firmaet modtager aldrig fragtbetalingen (`src/lib/betaling/beregn.ts`).
- **BidHamrs gebyrer står heller ikke på firmaets faktura.** Dem fakturerer BidHamr selv (docs/FAKTURA.md).
- **Almindelig moms:** netto = round(beløb × 4/5) pr. linje, moms = beløb − netto (samme regel som `public.faktura_moms`). Fakturaen viser beløb ekskl. moms, moms 25 % og total.
- **Brugtmoms:** ingen moms vises. Fakturaen viser i stedet teksten "Brugtmoms – særordning for brugte varer".
- Samme beregning findes i `src/lib/erhverv/firmaFaktura.ts` (`beregnFaktura`) og kontrolleres ved afsendelse (`fakturaTalStemmer`).

## Købers oplysninger (ét sted)

`public.firma_faktura_koeber_auto(trade)` er den eneste kilde. I koden hentes den med `hentKoeberFakturaOplysninger(tradeId)` (`src/lib/erhverv/koeberFakturaOplysninger.ts`).

- **Navn:** navnet fra MitID, når køberen er verificeret (Filip, 27. okt. 2026). Ellers navnet til handlen, ellers profilnavnet.
- **Adresse:** findes i denne rækkefølge:
  1. `public.bruger_adresser` (kontoen, 20261102340000)
  2. `handel_levering` (levering til døren)
  3. `users.adresse` (gammel fri tekst)

  Har køberen ingen række i `bruger_adresser`, bruges de næste kilder. Findes der ingen adresse, laves kladden alligevel, men Send er spærret, indtil firmaet har skrevet adressen ind. Selve handlen påvirkes aldrig.
- **E-mail:** e-mailen til handlen, ellers kontoens e-mail.
- **Firmanavn og CVR:** udfyldes af køberen selv på handlen (hjemmesiden eller `POST /api/firma-faktura`) eller af firmaet i kladden.
- Alt låses i øjebliksbilledet ved afsendelsen.

## Adgang (RLS)

- **Firmaet:** ser sine egne fakturaer (policy `firma_fakturaer_select_firma`) og har alle RPC'erne til sine egne.
- **Køberen:** ser kun sendte fakturaer til sig selv (`firma_fakturaer_select_koeber`). Hun ser aldrig kladder.
- **Chefen:** `admin_firma_fakturaer(p_firma)` kræver chef og to-trins-login og logges i `moderation_log` (`firma_faktura_opslag`). Det er samme regel som `firma_faktura_salg`, fordi det er købers persondata. Der er ingen direkte RLS-adgang for chefen, så hvert opslag bliver logget. Der er endnu ingen side i admin, kun RPC'en.
- **Ingen skriveadgang** for `authenticated`. Alt går gennem security definer-RPC'er med `auth.uid()`. Interne funktioner (`firma_faktura_byg`, `_koeber_auto`, `_opret_kladder` osv.) er lukket. `firma_faktura_gem_pdf` og `firma_faktura_mail_resultat` er kun for service role og kan ikke ændre status.

## Sider og ruter

| Hvad | Hvor |
|---|---|
| Liste, eksport (CSV / PDF-ZIP) | `/firma/fakturaer` |
| Se kladde/faktura, ret, Send, kreditnota | `/firma/fakturaer/[id]` |
| PDF (firmaet; kladde med "KLADDE") | `/firma/fakturaer/[id]/pdf[?download=1]` |
| Eksport | `/firma/fakturaer/eksport?fra&til&format=csv|zip` |
| Indstillinger | `/firma/fakturaer/indstillinger` |
| Knapper ved hvert betalt salg | `/firma/salg` og `/firma/salg/[trade_id]` |
| Momsordning pr. auktion | Opret/Redigér auktion (kun firmaer); låst fra første bud (BHM01) |
| Køberen: fakturaer + firmanavn/CVR | handelssiden (`KoeberFirmaFakturaBoks`) |

## Appen (kun køberen)

- `GET /api/firma-faktura?trade=<trade_id>` med `Authorization: Bearer <access_token>` returnerer `{ ok, kanOplyseFirma, firma: { firmanavn, cvr } | null, fakturaer: [{ id, type, fakturanummer, udstedt_dato, sendt_kl, firmanavn, total_oere, pdf }] }`.
- `GET /api/firma-faktura/<id>` med samme Bearer-token returnerer PDF'en (`?download=1` giver en vedhæftet fil). Det virker kun for køberen eller firmaet og kun for sendte fakturaer.
- `POST /api/firma-faktura` med `{ trade_id, firmanavn, cvr }` oplyser firmanavn og CVR før afsendelse. Tomme strenge fjerner dem. Svarer 409 `allerede_sendt` eller `ingen_faktura`.
- Fejlsvar: 400 `ugyldig`, 401 `ikke_logget_ind`, 429 `for_mange` og 500 `fejl`.

## Krav til en fuld faktura (momsbekendtgørelsen § 58, stk. 1)

PDF'en og øjebliksbilledet har:

| Krav | Hvor |
|---|---|
| Udstedelsesdato | `udstedt_dato` (dagen for "Send", dansk tid) |
| Fortløbende nummer | `fakturanummer` (serie pr. firma) |
| Sælgers CVR/momsnummer | `saelger.cvr` |
| Sælgers navn og adresse | `saelger.firmanavn`, `adresse`, `postnummer`, `by` |
| Købers navn og adresse | `koeber.*` (Send spærret uden) |
| Mængde og art af varen | linjen: antal 1 + titel og stand |
| Leveringsdato | `leveringsdato` (modtaget → afsendt → betalt; kan rettes) |
| Beløb ekskl. moms, momssats, momsbeløb | `beloeb_ekskl_moms_oere`, 25 %, `moms_oere` |
| Henvisning ved brugtmoms (og ingen moms) | `brugtmoms_tekst` |

**Kilder, der skal tjekkes:** jeg kunne ikke slå kilderne op online, da jeg byggede det (ingen netadgang). Henvisningerne herunder skal derfor tjekkes mod den gældende tekst, før vi går live. Det er spørgsmål 26–32 til revisor.

- **Momsbekendtgørelsen § 58, stk. 1 (fuld faktura) og § 58, stk. 1, nr. 14 (særordningerne, herunder brugte genstande).** Retsinformation.dk: søg "momsbekendtgørelsen". Tjek især den præcise formulering for brugtmoms. Direktivets ordlyd (momssystemdirektivet art. 226, nr. 14) er "Fortjenstmargenordning – brugte genstande". Den valgte tekst "Brugtmoms – særordning for brugte varer" skal bekræftes.
- **Momsloven § 52 (fakturapligt) og § 69-71 (brugtmoms).**
- **Skattestyrelsens Juridiske Vejledning**, afsnittet om fakturakrav (skat.dk → Den juridiske vejledning → Moms → fakturering).
- **Bogføringsloven:** opbevaring i 5 år fra udgangen af regnskabsåret.

## Opbevaring

Fakturaer slettes aldrig (trigger mod delete og truncate). PDF'en ligger i den private bucket `firma-fakturaer/<firma_id>/<id>.pdf` og kan altid laves igen ud fra øjebliksbilledet. Firmaet kan hente alt som CSV og ZIP.

## Til Filip / åbne punkter

- Jura: `jura/noter-til-advokat.md` nr. 147–151 og `jura/spoergsmaal-til-revisor.md` nr. 26–32.
- Logo: firmaets profilbillede (`users.avatar_url`) bruges som logo, men kun fra BidHamrs egen avatar-bucket og kun som PNG eller JPEG. Det kan slås fra i indstillingerne.
- Der er ingen delvis kreditnota. Hvis der bliver brug for det, er det en udvidelse.
