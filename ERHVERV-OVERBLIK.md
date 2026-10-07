# Erhvervskonti på BidHamr – overblik

> Research-notat, 7. oktober 2026 (Claude). **Ikke juridisk rådgivning** – lovafsnittet er et overblik, som advokaten skal bekræfte. Hører til punktet "Virksomheder som sælgere" under "Senere" i `ROADMAP.md`.

## Kort fortalt

1. **Når en virksomhed sælger til en privatperson på en netauktion, har køberen 14 dages fortrydelsesret.** Undtagelsen for "offentlig auktion" gælder kun auktioner, hvor man kan møde op fysisk – ikke netauktioner som BidHamr. Det strider mod BidHamrs regel "man kan ikke fortryde et køb", så erhvervshandler skal have deres eget retur-flow.
2. **Virksomheden har 2 års reklamationsret** over for private købere – også på brugte varer. BidHamrs nuværende flow (48 timer til at oprette en sag, derefter udbetaling) dækker ikke det. Pengene er udbetalt, når køber klager efter fx 8 måneder.
3. **BidHamr skal altid vise, om sælger er erhverv eller privat** (forbrugeraftaleloven § 8 a). Det gælder allerede i dag og uanset størrelse. Der er også en dansk regel om, at en platform, der formidler et privat salg, kan blive behandlet som sælger, hvis det ikke er klart for køberen, at sælger er privat (købeloven § 4 a).
4. **DSA's krav om at kende sine erhvervssælgere (art. 30–32) gælder sandsynligvis ikke for BidHamr endnu**, fordi små platforme er undtaget (art. 29). Men produktsikkerhedsforordningen (GPSR) gælder, og det er billigt at gøre det rigtigt fra start (CVR-opslag + Stripe + evt. MitID Erhverv).
5. **Konkurrenterne gør det meget forskelligt:** Tradera tager 8 % (maks. 160 SEK pr. vare) og har butiksabonnementer; eBay tager gebyr af virksomheder, men er gratis for private (Tyskland); Vinted Pro er gratis for sælger, køber betaler; Catawiki tager 12,5 % + køber 9 %. Alle markerer erhvervssælgere tydeligt ("Pro", "Företag", "Gewerblich").

---

## 1. Sådan gør konkurrenterne

### Tradera (Sverige, også dansk side)
- **Bliv erhverv:** gratis virksomhedskonto, oprettes med BankID. Kontoen er knyttet til et organisationsnummer. Tradera lukker kontoen automatisk, hvis virksomheden ophører, og udbetaler ikke til en ophørt virksomhed.
- **Gebyrer:** 8 % provision, **maks. 160 SEK pr. vare**. Ingen fast pris for "Bas" (500 auktioner/Køb nu pr. måned). Ved mere end 500 annoncer pr. måned: 2,40–8 SEK pr. usolgt vare.
- **Butik (abonnement):** Lille 545 SEK/md. (500 varer), Mellem 1.145 SEK/md. (2.000), Stor 1.845 SEK/md. (5.000). Samlerbutik 275 SEK/md. Alle priser ekskl. moms. Private butikker må ikke sælge nyproduktion.
- **Salgsformer:** auktion, Køb nu, butiksannoncer, særskilt format til køretøjer.
- **Værktøjer:** ProLister (bulk-oprettelse, auto-udfyldning ud fra billeder, ordrestyring, statistik). Fragtaftaler med PostNord, DHL m.fl.
- **Fortrydelsesret:** køber har 14 dages fortrydelsesret ved køb fra virksomhed – også på auktion. Ved køb fra privat: ingen.
- Kilder: https://business.tradera.com/ · https://business.tradera.com/priser/ · https://info.tradera.com/da/butik-privat/ · https://www.tradera.com/support/dk/posts/saelja-pa-tradera/ · https://www.tradera.com/support/se/posts/staengt-eller-spaerrat-konto/ · https://lawline.se/answers/12947

### DBA (Vend/Schibsted)
- **Erhverv er primært annoncering**, ikke handel gennem DBA: "Vend Pro / Dealer Hub" er rettet mod forhandlere af biler, både, campingvogne, MC og erhvervskøretøjer.
- **Gebyrer:** fast pris pr. annonce med mængderabat (baseret på gennemsnit over 12 måneder). Synlighed købes ekstra ("Bump", "Pole Position"). De fleste private annoncer er gratis; biler, både m.m. koster.
- **Butiksside:** professionel butiksprofil, lead-styring, statistik over annoncer.
- Fortrydelsesret/retur håndteres af forhandleren selv – DBA er ikke part i handlen på samme måde som BidHamr.
- Kilde: https://www.dba.dk/vendpro

### Vinted Pro
- **Bliv erhverv:** for enkeltmandsvirksomheder, selskaber og **foreninger/non-profit** i udvalgte lande (bl.a. FR, DE, NL, IT, ES, UK – ikke nødvendigvis DK endnu). Kræver virksomhedsregistreringsnummer.
- **Gebyrer:** gratis for sælger. Køber betaler "Buyer Protection Pro" – samme model som hos private.
- **Mærkning:** "Pro"-mærke ved navnet og på alle annoncer. Selskaber skal vise adresse; enkeltmandsvirksomheder kan skjule den.
- **Krav til annoncen:** varens væsentlige egenskaber, identitet og kontaktoplysninger, CVR, momsnummer, info om fortrydelsesret og reklamationsret.
- **Retur:** 14 dages fortrydelsesret. Sælger har 2 dage til at acceptere retur (eller refundere og lade køber beholde varen) og vælger, hvem der betaler returfragten. Sælger har 2 dage til at bekræfte, at returvaren er i orden.
- **Nye varer:** små mærker må sælge egne nye varer (2025).
- Kilder: https://www.vinted.co.uk/help/1438 · https://vinted.fi/pro-guide · https://margeoapp.com/en/blog/vinted-pro-account-guide/ · https://www.nssmag.com/en/fashion/43475/vinted-small-brands-sell-own-products-2025

### eBay (business seller)
- **Bliv erhverv:** vælg "erhvervskonto" og angiv virksomhedsoplysninger. eBay betragter dig som erhverv, hvis du køber for at sælge videre, sælger egenproducerede varer, sælger store mængder eller ens varer jævnligt, eller har en eBay-butik. At udgive sig for privat er i strid med lov og eBays regler.
- **Gebyrer (eBay.de):** private sælger **gratis** i Tyskland (siden 2023). Erhverv betaler 5–16 % efter kategori (typisk 12 % op til 990 €, 3 % over), plus 0,35–0,45 € pr. ordre. Butiksabonnement fra ca. 39,95 €/md. med færre gebyrer. Desuden et "regulatorisk driftsgebyr" (fx 0,35 % i Irland).
- **Mærkning:** "Gewerblicher Verkäufer" og et felt med sælgers juridiske oplysninger (navn, adresse, telefon, e-mail, momsnr., CVR) på hver annonce.
- **Fortrydelsesret:** 14 dage ved køb fra erhverv – nye og brugte varer. Sælger refunderer pris + oprindelig fragt; køber betaler returfragt, hvis det er oplyst.
- **Værktøjer:** Seller Hub, bulk-upload, statistik, flere brugere på kontoen, butiksside.
- **Auktion og fast pris** begge tilladt for erhverv.
- Kilder: https://www.ebay.de/help/selling/selling/eu-consumer-protection-law-information-obligations?id=4839 · https://export.ebay.com/en/fees-regulations-policies/international-regulations/14-day-right-of-withdrawal-under-the-eu-consumer-rights-directive/ · https://www.ebay.ie/sellercentre/fees-business · https://www.cio.de/article/3700252/ebay-deutschland-streicht-gebuehren-fuer-private-verkaeufer.html · https://www.monsterdealz.de/magazin/ebay-verkaufen

### Etsy
- **Kun fast pris** (ingen auktion). Kun håndlavet, vintage (mindst 20 år) og hobbymaterialer.
- **Gebyrer:** 0,20 $ pr. annonce, 6,5 % transaktionsgebyr (inkl. fragt), betalingsgebyr ca. 3 % + 0,25 $. Valgfrit "Etsy Plus" 10 $/md.
- **Erhverv/"trader":** sælgeren vælger selv status. Erhvervssælgere skal bekræfte identitet, CVR, momsnummer, adresse og kontakt (DSA, DAC7, INFORM Act), og disse vises for EU-købere.
- Kilder: https://help.etsy.com/hc/articles/14553858116759 · https://blog.marmalead.com/etsy-fees-explained-2025/ · https://www.valueaddedresource.net/etsy-new-requirements-selling-eu/

### Catawiki (onlineauktion, tættest på BidHamr)
- **Gebyrer:** sælger 12,5 % (+ et fast beløb), køber 9 %. Gratis at indsende.
- **Mærkning:** erhvervssælgere har et "Pro"-ikon ved navnet.
- **Fortrydelsesret:** forbrugere har 14 dage ved køb fra Pro-sælger – **også selvom det er en auktion**. Køber betaler returfragt; den oprindelige fragt refunderes. Fortrydelsen meldes til Catawiki.
- **Moms:** erhvervssælgere kan bruge brugtmomsordningen.
- Hver auktion kurateres af eksperter (anderledes end BidHamr).
- Kilder: https://auction.catawiki.com/en/help/buyer-terms/eu-right-of-withdrawal-policy · https://www.catawiki.com/en/pages/p/seller-terms · https://www.catawiki.com/en/pages/p/how-to-sell

### Lauritz.com
- Auktionshus (ikke åben markedsplads): sælger på kommission, primært kunst, design, møbler. Opkøbt af Auktionshuset.com efter konkurs i 2023 og relanceret i 2024.
- Fortrydelsesret: generelt gælder 14 dage ved netauktion; Lauritz' egne vilkår kunne ikke hentes (siden svarede 404) – **ikke bekræftet**.
- Kilder: https://lauritz.com/en/about-us/about-lauritz-com · https://www.lauritz.com/en/selling/what-can-be-sold

### Mønstre på tværs
| | Mærkning | Erhverv betaler | Auktion for erhverv | 14 dages fortrydelse |
|---|---|---|---|---|
| Tradera | Ja | 8 % (maks. 160 SEK) + valgfri butik | Ja | Ja |
| eBay | "Gewerblich" + juridiske oplysninger | 5–16 % + evt. butik | Ja | Ja |
| Vinted Pro | "Pro" | 0 % (køber betaler) | Nej (kun fast pris) | Ja |
| Etsy | Trader-oplysninger | 6,5 % + 0,20 $ | Nej | Ja |
| Catawiki | "Pro" | 12,5 % | Ja | Ja |

**Ingen af dem fjerner fortrydelsesretten ved erhvervsauktioner.** De fleste har gratis grundkonto + valgfrit abonnement for store sælgere.

---

## 2. Lovkrav (overblik – advokaten afgør)

### Forbrugeraftaleloven – oplysning og fortrydelsesret
- **§ 8 a (fra Omnibus-direktivet):** markedspladsen skal før købet oplyse, **om sælger er erhvervsdrivende**, hvem og hvor sælger er, og – hvis sælger er privat – at forbrugerreglerne ikke gælder. Oplysningen må bygge på sælgers egen erklæring. Gælder **allerede i dag** for BidHamr. Desuden skal de vigtigste parametre for rækkefølgen i søgeresultater oplyses.
- **14 dages fortrydelsesret** ved fjernsalg fra erhverv til forbruger (§ 18). Undtagelsen i § 18, stk. 2, nr. 11 gælder kun **"offentlig auktion"** = en auktion, hvor forbrugeren kan være fysisk til stede. EU-direktivets betragtning 24 siger direkte, at onlineplatforme til auktioner **ikke** er offentlige auktioner. → **Undtagelsen gælder ikke BidHamr.**
- Erhvervssælgeren skal give oplysninger før købet: identitet, adresse, kontakt, samlet pris inkl. moms og fragt, fortrydelsesret (ellers forlænges fristen op til 12 måneder), reklamationsret.
- Ved fortrydelse: refusion inden 14 dage af pris + den billigste fragt; køber betaler returfragt, hvis det er oplyst.
- Kilder: https://danskelove.dk/forbrugeraftaleloven/8a · https://danskelove.dk/forbrugeraftaleloven/18 · https://www.lovguiden.dk/praksisoversigt/forbrugerret/fortrydelsesret-fjernsalg-forbrugeraftaleloven/tidslinje · https://eur-lex.europa.eu/eli/dir/2011/83/oj

### Købeloven – reklamationsret
- **2 års reklamationsret** ved forbrugerkøb (erhverv → privat), også på brugte varer. Fejl inden for **1 år** formodes at have været der fra start (omvendt bevisbyrde, fra 2022).
- "Købt som beset" virker ikke over for forbrugere, men en brugt vare skal kun svare til, hvad køber med rette kunne forvente (alder, beskrivelse).
- Undtagelsen for brugte varer på **offentlig auktion** (§ 77) gælder ikke netauktioner (Forbrugerklagenævnet, sag om stole købt på internetauktion).
- **§ 4 a, stk. 2:** køb, der formidles af en erhvervsdrivende, kan anses som forbrugerkøb, medmindre køberen vidste, at sælger var privat. Formidleren har bevisbyrden. → Vigtigt for BidHamr allerede i dag: mærkningen "privat sælger" skal være tydelig.
- Kilder: https://danskelove.dk/k%C3%B8beloven/4 · https://www.lovguiden.dk/praksisoversigt/mangelsbeskyttelse · https://www.lovguiden.dk/dokument/forbrugerklagenaevnet/2004-650-7-399-mangelfulde-brugte-stole-købt-på-internetauktion

### DSA (forordning om digitale tjenester)
- **Art. 30 – sporbarhed (KYBC):** før en erhvervssælger må sælge, skal platformen indsamle navn, adresse, telefon, e-mail, kopi af ID, betalingskonto, CVR og en erklæring om kun at sælge lovlige varer. "Bedste indsats" for at tjekke dem (fx i CVR). Suspendér ved forkerte oplysninger. Vis navn, adresse, kontakt og CVR for køberne. Gem oplysningerne i 6 måneder efter kundeforholdet.
- **Art. 31 – compliance by design:** grænsefladen skal gøre det muligt for erhvervssælgere at give de lovpligtige oplysninger (sælgeroplysninger, varens egenskaber, produktsikkerhed, fortrydelsesret). Stikprøver mod officielle lister over farlige varer.
- **Art. 32:** finder platformen ud af, at en ulovlig vare er solgt, skal købere inden for 6 måneder have besked.
- **Art. 29 – undtagelse:** art. 30–32 gælder **ikke** for platforme, der er mikro- eller små virksomheder (under 50 ansatte og under 10 mio. € omsætning), og først 12 måneder efter, man vokser ud af det. BidHamr er sandsynligvis undtaget – men det er god praksis at gøre det alligevel, og § 8 a og GPSR gælder uanset.
- Kilder: https://eur-lex.europa.eu/eli/reg/2022/2065/oj · https://www.springlex.eu/en/packages/dsa/dsa-regulation/article-29/ · https://www.ccpc.ie/enforcement-and-regulation/digital/the-digital-services-act · https://www.freshfields.com/en/our-thinking/blogs/technology-quotient/dsa-decoded-9-the-dsa-and-online-marketplaces-102lx12

### Produktsikkerhed (GPSR, forordning 2023/988) – nyt punkt
- Gælder fra december 2024 og omfatter også **brugte varer** (undtagen antikviteter og varer solgt til reparation).
- Erhvervssælgere skal i annoncen vise producentens navn/adresse, varens identifikation (model/type) og advarsler/sikkerhedsinfo.
- Markedspladsen skal have et kontaktpunkt for produktsikkerhed, registrere sig i EU's Safety Gate og designe oprettelsen, så felterne findes.
- Kilde: https://eur-lex.europa.eu/eli/reg/2023/988/oj

### Moms
- Erhvervssælgere skal vise priser til forbrugere **inkl. moms** (markedsføringslovens prisregler). Det passer med BidHamrs regel om, at alle beløb er inkl. moms.
- Momsregistrering er påkrævet ved omsætning over **50.000 kr. på 12 måneder**.
- **Brugtmomsordningen:** frivillig ordning, hvor videreforhandlere af brugte varer kun betaler moms af avancen. Kræver særlig faktura ("brugtmoms" – moms må ikke vises særskilt). Ellers moms af hele prisen.
- Konsekvens for BidHamr: erhvervssælgeren skal kunne lave en **faktura** til køberen (i dag laves kun kvittering). BidHamrs egne gebyrer er uændrede (BidHamr fakturerer dem med moms). Erhvervskøbere vil gerne have faktura med moms på gebyrerne til fradrag.
- Kilder: https://tax.dk/jv/da/D_A_18_4_4.htm · https://skat.dk (søg "brugtmoms")

### DAC7
- BidHamr skal indberette sælgere til Skattestyrelsen (via Stripe Platform Tax Reporting, som allerede er planlagt). For **virksomheder** skal der indsamles CVR, momsnummer, hovedsæde og evt. fast forretningssted.
- Sælgere med under 30 salg **og** under 2.000 € om året er undtaget – gælder både private og erhverv.
- Kilder: https://www.grantthornton.ie/insights/factsheets/dac-7-reporting-obligations-for-digital-platforms/ · https://www.belastingdienst.nl/wps/wcm/connect/en/business/content/information-for-sellers-dac7

### Markedsføringsloven
- Det er altid ulovligt at **udgive sig for at være forbruger**, når man handler som erhverv (bilag 1, "sortlisten", nr. 22). Gælder "skjulte forhandlere", der sælger som private.
- Skjult reklame er forbudt (§ 6) – fx hvis BidHamr fremhæver erhvervsauktioner mod betaling uden at mærke det "Annonce"/"Fremhævet".
- Kilder: https://www.retsinformation.dk/eli/lta/2021/2192 · https://forbrugerombudsmanden.dk/media/lrenbgej/hvornaar-gaelder-markedsfoeringsloven-afsnit-2.pdf

### Andet, advokaten bør se på
- **Klageadgang:** erhvervssælgere skal oplyse om klagemulighed (Nævnenes Hus/Forbrugerklagenævnet). EU's ODR-klageplatform blev nedlagt i 2025 – tjek, hvad der nu kræves.
- **Producentansvar** (elektronik, batterier, emballage) ved salg af nye varer.

---

## 3. Funktioner til en erhvervskonto

### Krævet af loven
| Funktion | Hvorfor |
|---|---|
| Sælger erklærer "privat" eller "erhverv" ved oprettelse af auktion/konto | Forbrugeraftaleloven § 8 a (må bygge på sælgers erklæring) |
| Tydeligt mærke "Erhvervssælger" / "Privat sælger" på auktion, profil og i købsflowet | § 8 a, købeloven § 4 a |
| Tekst ved private sælgere: "Ved køb fra private gælder forbrugerreglerne ikke (ingen fortrydelsesret)" | § 8 a, stk. 1, nr. 3 |
| Erhvervsprofil med navn, adresse, CVR, telefon, e-mail | Forbrugeraftaleloven, (DSA art. 30) |
| 14 dages fortrydelse for privatkøbere ved erhvervskøb, med retur-flow og refusion | § 18 |
| Reklamation i 2 år (sag kan oprettes længe efter udbetaling) | Købeloven |
| Priser inkl. moms; erhverv kan vælge brugtmoms eller almindelig moms | Moms, prisregler |
| Faktura/købsnota fra erhvervssælger til køber | Momsloven/bogføring |
| Felter til producent, model og sikkerhedsinfo i oprettelsen | GPSR |
| CVR, momsnummer og adresse til DAC7 | DAC7 |
| Fortrydelses- og reklamationsinfo vises før buddet | Forbrugeraftaleloven, DSA art. 31 |

### Bør være med til lancering af erhverv
| Funktion | Hvorfor |
|---|---|
| CVR-opslag ved oprettelse (navn, adresse, status "aktiv" hentes automatisk) | Forhindrer falske/ophørte virksomheder; næsten gratis |
| Stripe Connect som "company"/"enkeltmandsvirksomhed" (Stripe tjekker ejere) | Allerede understøttet |
| Login/verificering med MitID Erhverv (Criipto understøtter det) | Bevis for, at personen må handle for virksomheden |
| Erhvervssælgerens returvilkår (returadresse, hvem betaler returfragt) | Krav for at fortrydelse virker i praksis |
| Ordning for at trække refusion tilbage fra sælger efter udbetaling (fx reserve eller modregning) | Ellers hænger BidHamr på regningen ved reklamation |
| Butiksside: logo, beskrivelse, alle aktive auktioner, bedømmelser | Standard hos alle konkurrenter |
| Faktura på BidHamrs gebyrer med virksomhedens CVR (til fradrag) | Erhvervskøbere/-sælgere forventer det |
| Filter "Kun private sælgere" / "Kun erhverv" i søgning | Gennemsigtighed, købere vil vælge |
| Overvågning af "skjulte forhandlere" (mange ens varer, høj omsætning) med opfordring til at skifte | Markedsføringsloven, fair konkurrence |

### Kan komme senere
| Funktion | Hvorfor vente |
|---|---|
| Bulk-oprettelse (CSV/import), skabeloner i stor stil | Først relevant for store sælgere |
| Statistik (visninger, bud, konvertering) | Godt salgsargument, ikke nødvendigt |
| Flere brugere pr. erhvervskonto med roller | Først når større virksomheder kommer |
| Abonnement/butikspakker | Kræver volumen |
| "Køb nu"/fast pris for erhverv | Besluttet: ren auktionsside nu |
| API til lagersystemer | Kun for de største |
| Betalt fremhævning (mærket "Annonce") | Ny indtægt, men kræver mærkning |
| Erhvervskøb (B2B) uden fortrydelsesret, med faktura og moms | Lille målgruppe i starten |

---

## 4. Beslutninger Filip skal træffe

**1. Separat konto eller opgradering?**
- a) Opgradering af eksisterende profil ("Skift til erhverv") – samme login, ny status.
- b) Helt separat erhvervskonto (egen e-mail, eget login).
- c) Personlig profil kan "eje" en eller flere virksomhedsprofiler.
- **Anbefaling: c** på sigt, men start med **a**: én person kan skifte sin profil til erhverv. Simpelt og passer til enkeltmandsvirksomheder. Handelsdata fra før skiftet forbliver private handler.

**2. Hvem kan blive erhverv?**
- a) Kun aktivt CVR (ApS, A/S, I/S, enkeltmandsvirksomhed).
- b) Også foreninger (CVR via foreningen) – fx genbrugsbutikker, loppemarked for skoleklasse.
- c) Også udenlandske virksomheder.
- **Anbefaling: a + b**, kun dansk CVR i starten. Foreninger med salg i stor stil er også "erhvervsdrivende" i forbrugerlovens forstand (fx velgørenhedsbutikker) – spørg advokaten.

**3. Gebyrmodel for erhverv**
- a) Samme som private (5 % + 5 %).
- b) Lavere/højere procent, evt. med loft (som Tradera, maks. pr. vare).
- c) Gratis grundkonto + valgfrit abonnement med lavere gebyr.
- **Anbefaling: a ved lancering** (enkelt, ingen ny kode i betalingen, Stripe er på pause). Overvej c, når der er erhvervssælgere med volumen.

**4. Fast pris / "Køb nu" for erhverv?**
- a) Nej – samme rene auktion som private.
- b) Kun for erhverv.
- c) For alle.
- **Anbefaling: a.** Det følger beslutningen om ren auktionsside. Butikker med mange ens varer passer dårligt til auktion, men det er en ny forretning (lager, antal), der bør vente.

**5. Nye varer?**
- a) Kun brugte varer (som i dag).
- b) Nye varer tilladt for erhverv (fx overskudslager, returvarer, udgåede modeller).
- c) Nye varer kun i bestemte kategorier.
- **Anbefaling: b**, med krav om tilstand "Ny" og GPSR-felter. Overskudslager og dødsboer er netop de målgrupper, Filip nævner i roadmappen. Det kræver dog bedre kontrol af falske varer.

**6. BidHamr Beskyttelse ved erhvervskøb?**
- a) Samme tilkøb som i dag.
- b) Ingen Beskyttelse ved erhvervskøb (forbrugeren har jo fortrydelses- og reklamationsret).
- c) Indbygget og gratis for køber ved erhvervskøb (sælger betaler via gebyret).
- **Anbefaling: a, men advokaten skal se teksten.** Beskyttelsen må ikke få køber til at tro, at han ellers ikke har ret til at klage – det kan være vildledende, når loven allerede giver ret. Overvej at beskyttelsen ved erhvervskøb især handler om, at BidHamr tager sagen for køberen.

**7. Fortrydelse og retur i sagsflowet**
- a) BidHamr håndterer det hele i appen (knap "Fortryd køb", returlabel, refusion via Stripe, først når sælger har modtaget varen).
- b) Køber og erhvervssælger klarer det selv; BidHamr viser kun info.
- c) Erhvervssælgeren skal selv refundere via sit eget system.
- **Anbefaling: a.** Pengene går gennem BidHamrs Stripe-konto, så det er nemmest og tryggest. Spørgsmål: refunderes købergebyr og BidHamr Beskyttelse også? (se advokatspørgsmål).

**8. Reklamation efter udbetaling (op til 2 år)**
- a) Erhvervssælger skal have et depot/reserve hos Stripe i fx 14–30 dage.
- b) Udbetal som i dag; ved reklamation trækkes pengene fra sælgerens næste udbetalinger.
- c) Reklamation er alene mellem køber og sælger efter BidHamrs frist.
- **Anbefaling: b + c**: længere frigivelse for erhverv (efter fortrydelsesfristen på 14 dage), derefter modregning hvis muligt – ellers må køber gå direkte til sælger/Forbrugerklagenævnet. BidHamr skal hjælpe med kontaktoplysninger.

**9. Hvornår skal en privat over på erhverv?**
- a) Ingen grænse – sælger erklærer selv.
- b) Automatisk advarsel ved fx 30 salg eller 15.000 kr. på 12 måneder (DAC7-lignende), staff vurderer.
- c) Hårde regler: køb for at sælge videre, mange ens varer, nye varer = erhverv.
- **Anbefaling: b + c som tekst i reglerne.** Brug kriterierne fra eBay/EU: køber ind for at sælge, sælger mange ens/nye varer, sælger jævnligt og med fortjeneste. Systemet markerer mistanke; staff beder sælgeren skifte eller forklare. Lukning af konto kun efter advarselssystemet.

**10. Må erhverv også købe (B2B)?**
- a) Ja, med faktura og moms på gebyrer til fradrag.
- b) Nej, ikke ved lancering.
- **Anbefaling: a for faktura på BidHamrs gebyrer**, men ingen særlige B2B-regler endnu. Når en virksomhed køber, er der ikke fortrydelsesret – kræver at køberen markeres som erhverv.

**11. Hvad skal erhvervssælgere have vist på auktionen?**
- a) Kun "Erhvervssælger" + link til profil med alle oplysninger.
- b) Alle oplysninger på hver auktion (som eBay).
- **Anbefaling: a**, hvis advokaten godkender, at oplysningerne er "let tilgængelige" med ét klik.

---

## 5. Spørgsmål til advokaten

1. Bekræft, at undtagelsen for "offentlig auktion" (forbrugeraftaleloven § 18, stk. 2, nr. 11) **ikke** gælder BidHamr, så forbrugere har 14 dages fortrydelsesret ved køb fra erhvervssælgere.
2. Når en køber fortryder et erhvervskøb: skal BidHamrs **købergebyr, fragt og BidHamr Beskyttelse** refunderes (er de "accessoriske aftaler", der bortfalder automatisk)? Hvem bærer omkostningen – BidHamr eller sælger?
3. Har forbrugeren selv 14 dages fortrydelsesret over for **BidHamrs egne tjenester** (gebyr, BidHamr Beskyttelse), også ved køb fra private?
4. Hvordan skal vi formulere mærkningen af private sælgere, så BidHamr ikke anses som sælger efter **købeloven § 4 a, stk. 2** (formidling for privat sælger)?
5. Er BidHamr undtaget fra **DSA art. 30–32** efter art. 29 (mikro/lille virksomhed)? Og fra hvornår gælder de, hvis vi vokser?
6. Hvilke **GPSR**-pligter har BidHamr som markedsplads (kontaktpunkt, Safety Gate, felter i oprettelsen) – også når erhverv kun sælger brugte varer?
7. Må **BidHamr Beskyttelse** sælges ved køb fra erhverv, når forbrugeren allerede har fortrydelses- og reklamationsret – eller er det vildledende? Hvordan skal teksten skrives?
8. Hvilket **ansvar har BidHamr ved reklamation** (2 år), hvis erhvervssælgeren ikke betaler eller er gået konkurs, og pengene er udbetalt?
9. Hvilke oplysninger skal erhvervssælgeren vise før buddet, og er det nok med et link til profilen ("ét klik væk")?
10. Er **foreninger, velgørende genbrugsbutikker og dødsbo-boer/bobestyrere** "erhvervsdrivende" i forbrugerlovens forstand, når de sælger på BidHamr?
11. Hvilke **kriterier** må vi bruge til at kræve, at en privat sælger skifter til erhverv, og må vi lukke kontoen, hvis han nægter?
12. Skal erhvervssælgere kunne udstede **faktura** gennem BidHamr, og hvad kræver brugtmomsordningen af faktura og visning af pris (må brugtmoms-varer vises "inkl. moms" uden momsbeløb)?
13. Hvilke krav gælder for **klageoplysning** (Nævnenes Hus) nu, hvor EU's ODR-platform er lukket – for BidHamr og for erhvervssælgerne?
14. Skal **handelsbetingelserne** have et særskilt afsnit for erhvervssælgere (pligter, ansvar, skadesløsholdelse af BidHamr), og hvad skal der stå?
15. Har BidHamr **producentansvar** (elektronik, batterier, emballage), hvis erhverv sælger nye varer?
16. Gælder **DAC7** forskelligt for erhvervssælgere – fx skal vi indsamle momsnummer og fast forretningssted, og må vi stole på Stripes indsamling?
17. Hvis BidHamr sælger betalt **fremhævning** til erhverv: hvordan skal det mærkes (markedsføringsloven og forbrugeraftaleloven § 8 a om rangering)?
18. Må erhvervssælgere sætte **mindstepris eller reserve** på auktioner, og skal det oplyses særskilt for forbrugere?
