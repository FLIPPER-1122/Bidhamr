# Fragt – Shipmondo (DAO, GLS og PostNord) eller DAO direkte

> **Shipmondo igen (Filip, 15. okt. 2026, `FRAGTFIRMA=shipmondo`):** køberen vælger selv fragtfirma i
> checkout – **DAO, GLS eller PostNord** – til pakkeshop eller døren. Prisen er den samme for alle tre (låst på
> auktionen). Migration `20261024010000_fragt_shipmondo_transportoer.sql` (kolonnen `transportoer`). Se afsnittet
> **"Shipmondo (verificeret mod sandboxen 9. og 15. okt. 2026)"** nederst for produkter, labelfri, annullering,
> sporing og retur pr. fragtfirma.

Server-delen af fragten (ROADMAP fase 2). Beslutninger: ROADMAP-BESLUTNINGER.md afsnit 2
("Fragtfirma og priser", Filip 9. okt. 2026). Migrationer: `supabase/migrations/20261012010000_fragt_dao_shipmondo.sql`
og `20261013020000_afhentning_valg.sql` (afhentning som valg i checkout, BHT04/BHT05).

> **DAO direkte (13. okt. 2026, `FRAGTFIRMA=dao`):** adapteren `src/lib/fragt/dao.ts` og migrationen
> `20261021010000_fragt_dao_direkte.sql` er bygget, men mangler nøgler og hændelseskoder – se
> **docs/DAO-API.md, "Bygget" og "Mangler"**. Forskelle fra Shipmondo herunder: DAO kan annullere en label (en
> bekræftet annulleret DAO-label tæller ikke i "højst 2 labels" – loft 10), der er intet opslag på reference (efter
> et ukendt udfald laver næste forsøg en ny forsendelse, og kendte forældreløse annulleres), sporingen kommer via et
> token-feed i fragt-cron'en (ingen webhook), og 14 dage uden leveringsmelding giver en efterlysning
> (`fragt_efterlysninger`) og en markering til staff.

> **Produktion:** migrationen må IKKE køres i produktion, før både hjemmesiden OG appen viser den låste
> fragtpris (`fragt_pakkeshop_oere`) og har checkout før betaling. Ellers ser byderne 35 kr. og betaler
> 40/50/65 kr., og betalingen kan ikke startes uden leveringsvalg. Kør migrationen og deploy hjemmesiden
> lige efter hinanden (koden læser de nye kolonner).

## Flowet

1. **Opret auktion**: sælgeren vælger forsendelse + pakkestørrelse (Lille ≤ 1 kg, Mellem ≤ 5 kg, Stor ≤ 15 kg)
   og vægt (altid krævet). Databasen håndhæver grænserne (også fra appen) og **låser
   fragtprisen på auktionen** (`auctions.fragt_pakkeshop_oere` / `fragt_doer_oere`). Over 15 kg: kun afhentning.
   Sælgeren kan desuden sætte flueben i "Køberen må også hente varen hos mig" (`auctions.afhentning_mulig`).
   Uden forsendelse er auktionen kun afhentning (flaget er da altid false).
2. **Budpanelet** viser `fragt_pakkeshop_oere` (billigste levering) før buddet.
3. **Auktionen slutter**: betalingen oprettes med pakkeshop-prisen som fragt.
4. **Checkout (før betaling)**: køberen vælger *pakkeshop* (søg + vælg shop) eller *levering til døren*
   (kun Lille/Mellem) – eller *afhent hos sælger – 0 kr.*, når auktionen tilbyder både forsendelse og
   afhentning. Valget gemmes på handlen (`handel_levering`), og betalingens fragt, total og
   BidHamrs gebyr (application fee) rettes. **Betalingen kan ikke startes uden et gyldigt valg**
   (`startBetaling` svarer `{ fejl, kode: "vaelg_levering" }`; databasen afviser også en PaymentIntent).
   Kun afhentning (auktionen tilbyder ikke forsendelse) kræver intet valg.
   **Afhentning som valg** (kun før betaling): fragten bliver 0 (også i application fee), BidHamr Beskyttelse
   trækkes fra (ingen sag ved afhentning – gemmes i `handel_levering.beskyttelse_ved_forsendelse_oere` og lægges
   på igen ved skift tilbage), og `trades.afhentning` sættes til true, så afhentningsflowet bruges (kode ved
   afhentning, 7 dages frist, ingen sag). Samme PaymentIntent-regler som ved prisskift: en gammel PaymentIntent
   annulleres hos Stripe, før beløbet ændres (pi_forsoeg + 1). Efter betaling kan leveringsformen ikke skiftes.
5. **Send pakke**: sælgeren udfylder sin afsenderadresse → forsendelsen oprettes hos Shipmondo med køberens
   fragtfirma → PDF-label + labelfri: DAO's kode, PostNords QR-kode (PNG, vises på skærmen) – GLS har ingen
   labelfri udgående via Shipmondo, så dér printes PDF'en. Sælgeren tager stadig de to pakkebilleder og trykker "Send pakke"
   som i dag (labelen flytter ikke handlen). Højst 2 labels pr. handel (også annullerede) – flere kræver,
   at staff godkender (`fragtGodkendEkstraLabel` i `src/app/actions/adminFragt.ts`).
   Svarer fragtfirmaet ikke (timeout/netværk/5xx, eller fejl efter oprettelsen), bliver forsøget stående,
   og næste "Send pakke" (efter mindst 1 minut) genbruger samme reference – der bestilles aldrig en ny label,
   før det er afklaret. Drift-loggen får "Fragt: ukendt udfald". Et genoptaget forsøg markeres aldrig
   'fejlet' af systemet – staff afslutter det med `fragtAfslutHaengendeLabel` (adminFragt.ts): "markér
   fejlet" (intet oprettet hos Shipmondo, note krævet) eller "tilknyt" (Shipmondos forsendelses-id; referencen
   skal være BidHamrs forsendelses-id). Begge logges i medarbejder-loggen. Knappen bygges af frontend.
6. **Annullering**: så længe pakken ikke er indleveret. DAO kan ikke annullere via Shipmondo (422) – labelen
   annulleres i BidHamr, og staff får en markering (bed Shipmondo/DAO kreditere den). GLS og PostNord
   annulleres hos Shipmondo; svarer Shipmondo `cancelled_at_carrier: true`, sættes
   `forsendelser.annullering_bekraeftet_kl`, og labelen tæller ikke i "højst 2 labels" (loft 10). I sandboxen
   svarer de `false` – så tæller labelen som før.
7. **Sporing**: kun via Shipmondos webhook "Shipment Monitor" → `/api/fragt/webhook/shipmondo` (JWT HS256 med
   `SHIPMONDO_WEBHOOK_NOEGLE`; hændelser fra en anden transportør end forsendelsens gemmes ikke; ukendte
   statuskoder gemmes i `fragt_ukendte_koder` og ændrer aldrig status).
   "Pakken er kommet frem" (`pakke_leveret`) til køberen og "Pakken er indleveret" (ny type
   `pakke_indleveret`, påkrævet) til sælgeren. Vejer fragtfirmaet pakken tungere end størrelsens maksimum,
   markeres forsendelsen og betalingen til staff (udbetalingen holdes); modregning hos sælgeren er ikke bygget. **Levering/afhentning udløser aldrig
   udbetaling** – kun købers bekræftelse eller de eksisterende regler i autoFrigiv.
8. **Retur i sager**: returlabel (køber → pakkeshop nær sælgeren). Bag `FRAGT_RETURLABEL_AKTIV` (slået fra i
   produktion). DAO: Shop2Shop med køberen som afsender og `shopid=0` (DAO vælger shoppen nærmest sælgeren).
   **Køberen betaler selv returfragten, før returkoden laves** (Filip, 13. okt. 2026 -
   `src/lib/betaling/returfragt.ts`, `20261022010000_returfragt_betaling.sql`): handelssiden viser køberen
   "Send varen retur" med prisen (= fragten ud), adresse + mobil og Stripes Payment Element ("Betal returfragt
   (X kr.)"), når sagen afventer retur, og ankefristen er udløbet. Betalingen går til BidHamrs platformskonto
   (ingen destination charge). Koden laves først, når webhooken har bekræftet betalingen; databasen afviser en
   returlabel uden betalt returfragt. Fejler labelen, prøver cron'en igen (5-80 min), og staff markeres på
   returforsendelsen (Fragt → "Kræver handling"); efter 5 fejl, 48 timer, eller hvis sagen ikke længere kræver
   retur, refunderes hele returfragten automatisk, og køberen får besked. Efter betaling vises koden, PDF'en og
   den nærmeste pakkeshop; sælgeren ser "Returen er på vej" med sporing. Staff (admin/chef, ikke inhabile)
   kan trykke "Refundér returfragt" på sagen i admin, når der ikke er en aktiv returkode (logges i
   moderation_log). Annulleres returkoden, og har fragtfirmaet BEKRÆFTET annulleringen, kan køberen få en ny
   uden at betale igen. Kan fragtfirmaet ikke annullere selv (DAO), bliver koden stående, staff markeres, og
   der refunderes aldrig automatisk - staff afgør (noten vises ved knappen). Appen læser kun via
   `min_returfragt` (aldrig `select('*')` på `returfragt_betalinger`). Nødstoppet for nye
   betalinger annullerer også åbne returfragt-betalinger. En refusion i Stripe-dashboardet spejles
   (charge.refunded), så der aldrig laves en kode på en refunderet returfragt.
9. **Ikke-afhentet pakke** (`20261016030000_ikke_afhentet_pakke.sql`, `src/lib/betaling/ikkeAfhentet.ts`):
   fragtfirmaet sender pakken retur, fordi køberen ikke hentede den. Én adapter-neutral indgang
   `registrerIkkeAfhentet` → `handel_ikke_afhentet_registrer` (låser betaling og handel, idempotent - én
   hændelse pr. handel i `handel_ikke_afhentet`, som aldrig kan ændres eller slettes). Handlen annulleres,
   køberen refunderes `bud − returfragt` (= total − købergebyr − BidHamr Beskyttelse − fragt − returfragt,
   aldrig under 0), sælgeren beholder varen og får intet udbetalt. Returfragten er fragten ud (Filip,
   10. okt. 2026). Er returfragten mindst buddet, får køberen 0 kr. og skylder intet, og sælgerens del
   tilbageføres stadig automatisk (BidHamr dækker resten). Kaldes af:
   - **fragten**: en udgående pakke meldt `returneret`, som aldrig er `leveret`, når adapteren har
     `returErIkkeAfhentet: true` (testfragtfirmaet; DAO-adapteren sætter den, når DAO's returkode er kendt).
     Shipmondo gætter `returneret` ud fra en tekst og har den derfor ikke - der bliver det kun en markering.
     Webhookens handelseffekter registrerer med det samme; betalings-cron'en er reserve
     (`koerIkkeAfhentet`, før den automatiske frigivelse). Refusionen laves af betalings-cron'en (lovede
     refusioner).
   - **staff**: knappen "Ikke afhentet" under Admin → Handler (på handlen og på en returneret forsendelse
     under fanen Fragt), med begrundelse; logges i medarbejder-loggen (`handel_ikke_afhentet`) af databasen i
     samme transaktion. Med returmelding fra fragtfirmaet: medarbejder, admin og chef; uden returmelding kun
     admin og chef (`kraever_admin`). Aldrig når pakken er leveret eller køberen har trykket "modtaget"
     (`leveret`). Ikke inhabil. Refusionen laves med det samme (`20261016031000_ikke_afhentet_rettelser.sql`).
   - Reserven i betalings-cron'en henter kandidater med `ikke_afhentet_fragt_kandidater`, som sorterer
     registrerede og ikke-registrerbare handler fra i databasen.
   - Beskederne sendes som påkrævet type `betaling_modtaget` (som afhentningsfristen).
   - En returneret pakke frigives aldrig automatisk (`handel_auto_frigiv`), og køberen får ikke
     påmindelsen "Har du modtaget din vare?".
   - Appen: `supabase.rpc("mit_ikke_afhentet", { p_trade })` → køberen `{ rolle: 'koeber', registreret_kl,
     refusion_oere, koebergebyr_oere, beskyttelse_oere, fragt_oere, returfragt_oere, refunderet }`,
     sælgeren `{ rolle: 'saelger', registreret_kl }`, ellers `null`. Handlen står som `annulleret`.

## Priser – ét sted

Tabellen `fragt_pakkestoerrelser` (læses af alle; kun service_role/SQL skriver):

| kode | maks | pakkeshop | døren |
|---|---|---|---|
| lille | 1 kg | 40 kr. | 60 kr. |
| mellem | 5 kg | 50 kr. | 85 kr. |
| stor | 15 kg | 65 kr. | – |

Ændres prisen i tabellen, gælder den for **nye** auktioner (og når en sælger ændrer størrelsen før første bud).
Igangværende auktioner beholder den pris, byderne har set. DAO's kostpris (ekskl. moms) står i
`fragt_kostpriser` + `fragt_tillaeg` og gemmes pr. forsendelse i `forsendelser.forventet_kostpris_oere`.
`admin_fragt_tilskud(fra, til)` (kun service_role, efter `assertRole('chef')`) giver BidHamrs fragttilskud.

## Hjemmesiden (server actions, `src/app/actions/fragt.ts`)

| Action | Hvem | Svar |
|---|---|---|
| `hentFragtpriser()` | alle | `{ ok, priser: [{ kode, navn, maksGram, pakkeshopOere, doerOere }] }` |
| `soegPakkeshopsAction({ postnummer, adresse?, by?, antal?, transportoer?, indlevering? })` | logget ind | `{ ok, fragtfirma, transportoer, pakkeshops: Pakkeshop[] }` |
| `hentCheckoutAction(tradeId)` | køber | `{ ok, checkout }` (se Checkout i `src/lib/fragt/handlinger.ts`) |
| `gemLeveringsvalgAction(tradeId, { maade, transportoer?, pakkeshopId?, pakkeshopPostnummer?, pakkeshopAdresse?, modtager, gemForslag? })` – eller `{ maade: "afhentning" }` | køber | `{ ok, fragtOere, totalOere, beskyttelseOere, afhentning, prisAendret }` |
| `lavFragtlabel(tradeId, afsender?)` | sælger | `{ ok }` – uden afsender bruges sidst brugte adresse |
| `annullerFragtlabel(tradeId, forsendelseId)` | sælger | `{ ok }` |
| `hentFragtlabelLink(forsendelseId)` | sælger (udgående) / køber (retur) | `{ url }` (5 min) |
| `hentMinForsendelse(tradeId)` | køber og sælger | aktiv udgående forsendelse (som før) |
| `hentForsendelserAction(tradeId)` | køber og sælger | alle forsendelser + sporingstidslinje |
| `startReturfragtAction(tradeId)` | køber | `{ ok, clientSecret, beloebOere, customerSessionClientSecret }` eller `{ fejl, betalt? }` |
| `gemReturAfsenderAction(tradeId, afsender)` | køber | `{ ok }` - adresse og mobil, lige før betalingen |
| `lavReturlabelAction(tradeId, afsender)` | køber | `{ ok, forsendelseId }` - kun efter betalt returfragt (ny/rettet adresse) |

Alle fejl returneres som `{ fejl: "<dansk tekst>" }`, der kan vises direkte.

`Pakkeshop = { id, navn, adresse, postnummer, by, lat, lng, afstandM, aabningstider: [{ dag, tider }] }`.
`modtager = { navn, telefon, adresse?, postnummer?, by? }` – adresse krævet ved levering til døren.
`afsender = { navn, adresse, postnummer, by, telefon? }`.

Labelen, labelfri-koden og QR-koden vises kun for den part, der skal sende pakken (`harLabel`, `labelfriKode`,
`qrBillede` = data-URL med PNG). `ForsendelseVisning.transportoer` er fragtfirmaet (`dao` | `gls` | `postnord`).
`Checkout.transportoerer` er listen, køberen kan vælge imellem (`[{ kode, navn, leveringstid, labelfri }]`, tom =
intet valg), og `valgt.transportoer` / `forslag.transportoer` er valget.
Labelfri-koden (DAO) skrives på pakken eller vises i pakkeshoppen, så sælgeren ikke behøver printer.
**I sandboxen er koden altid `123-456-789`.**

## Appen (Expo)

Alle kald: `POST https://bidhamr.dk/api/fragt/app/<handling>` med
`Authorization: Bearer <session.access_token>` og `Content-Type: application/json`.
Svar: `200 { ok: true, ... }` eller `409 { fejl, kode: "afvist" }` (vis `fejl`), `401` (log ind igen),
`429` (for mange forsøg), `400/413` (forkert krop), `500`.

| handling | krop | svar |
|---|---|---|
| `pakkeshops` | `{ postnummer, adresse?, by?, antal?, transportoer?, indlevering? }` | `{ fragtfirma, transportoer, pakkeshops }` |
| `checkout` | `{ trade_id }` | `{ checkout }` |
| `levering` | `{ trade_id, maade: "pakkeshop" \| "doer", transportoer?, pakkeshop_id?, pakkeshop_postnummer?, pakkeshop_adresse?, modtager: { navn, telefon, adresse?, postnummer?, by? }, gem_forslag? }` eller `{ trade_id, maade: "afhentning" }` | `{ fragtOere, totalOere, beskyttelseOere, afhentning, prisAendret }` |
| `book` | `{ trade_id, afsender? }` | `{ forsendelseId }` |
| `annuller` | `{ trade_id, forsendelse_id }` | `{}` |
| `forsendelser` | `{ trade_id }` | `{ forsendelser }` |
| `label` | `{ forsendelse_id }` | `{ url }` (PDF, 5 min) |
| `returfragt` | `{ trade_id, afsender }` | `{ clientSecret, beloebOere, customerSessionClientSecret }` til PaymentSheet (`409 kode "betalt"`, hvis den er betalt) |
| `retur` | `{ trade_id, afsender }` | `{ forsendelseId }` - kun efter betalt returfragt |

Direkte fra Supabase i appen (med brugerens session):

- Priser: `supabase.from("fragt_pakkestoerrelser").select("kode, navn, maks_gram, pakkeshop_oere, doer_oere").order("sortering")`
- Auktionens fragt: kolonnerne `pakkestoerrelse, vaegt_gram, fragt_pakkeshop_oere, fragt_doer_oere, afhentning_mulig` på `auctions`.
- Fragtfirma (Shipmondo): `checkout.transportoerer` fra `POST /api/fragt/app/checkout`. Køberen vælger ét
  (`transportoer` = `"dao" | "gls" | "postnord"`); pakkeshop-søgningen og `levering` sendes med samme
  `transportoer`. Sendes den ikke, bruges DAO (ældre app). Pakkeshop-id'er gælder kun hos deres eget fragtfirma.
- Checkout-overblik: `supabase.rpc("handel_checkout", { p_trade })` (kun køberen) →
  `{ afhentning, kun_afhentning, afhentning_mulig, pakkeshop_oere, doer_oere, beskyttelse_ved_forsendelse_oere, valgt, betaling, label_lavet }`.
  `afhentning` = afhentning er valgt (eller eneste mulighed); `kun_afhentning` = intet valg; `afhentning_mulig` = vis
  kortet "Afhent hos sælger – 0 kr." (`valgt.maade` er da `"afhentning"`, når det er valgt).
- Eget leveringsvalg inkl. adresse: `supabase.rpc("mit_leveringsvalg", { p_trade })`.
- Forslag (sidst brugte adresse/pakkeshop): `supabase.from("leveringsforslag").select("*").maybeSingle()`;
  slet: `supabase.rpc("slet_mit_leveringsforslag")`.
- Sælger ændrer pakkestørrelse/vægt før første bud: `supabase.rpc("saet_auktion_fragt", { p_auktion, p_pakkestoerrelse, p_vaegt_gram })`
  → `{ kode: "ok" | "har_bud" | "for_tung" | "stoerrelse" | "ikke_aktiv" | "skjult" | "ikke_fundet" | "ugyldig", ... }`.

**Appen skal ændre:**

1. Opret auktion: send `pakkestoerrelse` (`lille`/`mellem`/`stor`) og `vaegt_gram` (altid krævet)
   sammen med `forsendelse_mulig` – og `afhentning_mulig: true`, hvis sælgeren også tilbyder afhentning
   (ved redigering før første bud: `rediger_auktion(..., p_afhentning_mulig)`, null = uændret). Fejlkoder fra insert/update: `BHT01` (over 15 kg – kun afhentning),
   `BHT02` (vægten passer ikke til størrelsen), `BHT03` (vægt mangler), `BHT04` ("Angiv en gyldig vægt" – vægt 0
   eller negativ) og `BHT05` ("Ukendt pakkestørrelse"). Sendes størrelsen ikke (den
   nuværende app), bliver den Mellem uden krav om vægt – når appen sender størrelsen, gøres kravet generelt.
2. Auktionssiden/budpanelet: vis `fragt_pakkeshop_oere` i stedet for de faste 35 kr.
3. Checkout-skærm før betalingen (pakkeshop med kort/liste, levering til døren, eller "Afhent hos sælger – 0 kr."
   når `afhentningMulig`) → `levering`. Først derefter "Betal". Ved afhentning: vis den nye total (uden fragt og
   uden BidHamr Beskyttelse) og efter betaling afhentningskoden som ved kun afhentning. Får betalingen `kode: "vaelg_levering"`, så send køberen til checkout.
4. "Send pakke": afsenderadresse → `book`, vis PDF (`label`) og labelfri-koden.
5. Tidslinje fra `forsendelser`, notifikationstypen `pakke_leveret` findes allerede.

## Go-live (produktion)

1. Appen sender `pakkestoerrelse` + `vaegt_gram`, viser den låste fragtpris og har checkout før betaling.
2. Hjemmesiden er klar (budpanel, opret, checkout, Send pakke).
3. **Fjern undtagelsen** i `auctions_fragt` (klienter uden størrelse får Mellem uden vægt) i en ny migration,
   så vægt altid kræves ved forsendelse.
4. Kør migrationen og deploy hjemmesiden lige efter hinanden.
5. Opret Shipmondo-webhooks (se nedenfor) og sæt `SHIPMONDO_*` + `FRAGTFIRMA=shipmondo` i Vercel (Filip).

## Shipmondo (verificeret mod sandboxen 9. og 15. okt. 2026)

Pr. fragtfirma (sandbox 15. okt. 2026 – oprettet med BidHamrs adapter og annulleret igen):

| | Pakkeshop | Døren | Labelfri udgående | Retur (køber → sælger) | Annullering |
|---|---|---|---|---|---|
| **DAO** | `DAO_STS` | `DAO_STH` (≤ 5 kg) | ja – kode (`labelless_code`, sandbox `123-456-789`) | `DAO_STS`, automatisk daoSHOP nær sælgeren, kode | **nej** (422) – annulleres kun i BidHamr + staff |
| **GLS** | `GLSDK_SD` | `GLSDK_HD` | **nej** – PDF (QR_CODE afvises med 422, intet `labelless_code`) | `GLSDK_SR` (ShopReturn) + QR til sælgerens adresse; afvises den: `GLSDK_SD` til en GLS-pakkeshop nær sælgeren (PDF) | ja – `cancelled_at_carrier: false` i sandbox |
| **PostNord** | `PDK_MC` + `QR_CODE` | `PDK_MH` + `QR_CODE` | ja – QR (`GET /shipments/{id}/qr_code?file_format=png`) | `PDK_MC` + QR, automatisk pakkeshop nær sælgeren | ja – `cancelled_at_carrier: false` i sandbox |

- GLS kræver `EMAIL_NT` (modtagerens e-mail). Alle andre: mindst én af `EMAIL_NT`/`SMS_NT`.
- **Reference højst 35 tegn** (PostNord afviser længere: "referenceNo ... cannot be longer than 35 characters").
  Derfor sendes BidHamrs forsendelses-id **uden bindestreger** (32 tegn); `hentEksisterende` oversætter tilbage.
- `GLSDK_SR` og `PDK_RDO` er formelt "business location"-produkter. ShopReturn til en privat sælger blev accepteret
  i sandboxen, men bør bekræftes med Shipmondo/GLS (ellers bruges reserven `GLSDK_SD` automatisk).
- Shipmondo-annullering: "This doesn't refund the shipment in Shipmondo" – en annulleret label kan stadig koste.
- Pakkeshops: `GET /service_point/service_points?product_code=<fragtfirmaets pakkeshop-produkt>` – kun det valgte
  fragtfirmas shops (id'erne overlapper ikke på tværs). Åbningstider kommer som "man:"/"Monday:".
- QR-koden gemmes i `forsendelser.qr_png` (base64, ingen læseadgang for brugere) og vises som billede til den,
  der skal aflevere pakken.
- Sporing (Shipment Monitor) er ens for alle tre: `EN_ROUTE` → i_transit (sætter også afleveret_kl),
  `AVAILABLE_FOR_DELIVERY` → klar_til_afhentning, `DELIVERED` → **leveret** (eneste kode, der sætter leveret_kl);
  `INFORMED`/`PICKUP_REQUESTED`/`GENERAL` → ingen hændelse; `current_state: DANGER` → en ekstra `fejl`-hændelse
  (markering). En tekst med "retur/return/til afsender" giver `returneret` (også ved `DELIVERED` – leveret tilbage
  til afsenderen må aldrig frigive penge). Ukendte statusser og transportører gemmes i `fragt_ukendte_koder`.
- Webhook-hændelser vurderes med forsendelsen (`vurderMonitorHaendelse`): på en **returpakke** bruges returteksten
  aldrig; på en **udgående** kun ved DELIVERED. `leveret` kræver, at Shipmondos by/postnummer passer med pakkeshoppen
  eller modtageren – ellers en markering til staff, og leveret_kl sættes ikke.
- **Shipmondos leveret frigiver ikke pengene efter 14 dage**, før `SHIPMONDO_LEVERET_FRIGIVER=true`
  (`forsendelser.leveret_frigiver`, sat ved oprettelsen; `handel_auto_frigiv` kræver den). Købers "modtaget" er uændret.
- Køberens fragtfirma: mangler det (gammel kode, appen), bruges DAO. Koden tåler, at migrationen ikke er kørt endnu.
- "Ikke afhentet" automatisk kun med `SHIPMONDO_RETUR_ER_IKKE_AFHENTET=true` (Shipment Monitor har ingen
  retur-status – det er en tekst). Ellers markering til staff, som trykker "Ikke afhentet".
- Efterlysning efter 14 dage: Shipmondo har intet API til det – staff får opgaven (`fragt_efterlysninger`, status
  `manuel`) og efterlyser hos fragtfirmaet. Pengene holdes tilbage (`handel_auto_frigiv`).

Fra 9. okt. 2026 (gælder stadig):

- DAO-produkter: `DAO_STS` (daoSHOP drop-off = Shop2Shop, 250 g–15 kg, pakkeshop krævet) og
  `DAO_STH` (daoHOME drop-off = Shop2Home, 250 g–5 kg). Notifikation: mindst én af `EMAIL_NT`/`SMS_NT`.
  `DAO_P`/`DAO_H` (afhentning hos afsender) og `DAO_R` (retur kun til erhverv) bruges ikke.
- Idempotens: `reference` = BidHamrs forsendelses-id (uden bindestreger). Findes referencen allerede hos
  Shipmondo, genbruges forsendelsen (verificeret 15. okt.: samme reference to gange → samme forsendelse). Bemærk: Shipmondos søgning på reference er ikke opdateret med det samme
  (få sekunder) – databasen (`forsendelse_claim`) forhindrer derfor selv dobbeltbestilling, og en
  fejl med ukendt udfald logges i drift med referencen.
- Pakkeshops: `GET /service_point/service_points` (højst 20 pr. kald). Afstand fra Shipmondo, når
  adressen er med – ellers beregnet fra postnummerets midte.
- QR-kode (`/shipments/{id}/qr_code`) kræver servicen `QR_CODE`, som DAO ikke har → PDF-label + labelfri-kode.
- Sporing: intet sporings-endpoint i API v3 (tjekket igen 15. okt.) – kun webhooken. `hentSporing` giver derfor
  ingen hændelser, og fragt-cron'ens polling er kun reserve for andre firmaer. Shipmondo prøver **ikke** igen,
  hvis vi ikke svarer 200 inden for 3 sekunder; mister vi en webhook, kommer den næste status ("latest") stadig,
  og efterlysningen efter 14 dage fanger en pakke uden leveringsmelding. Shipmondo skriver, at Shipment
  Monitor "updates once a day".
- Målt vægt: shipmondo.dev's eksempel på en Shipment Monitor-hændelse har `"weight": "0.6"` (tekst, kg;
  også `length`/`height`/`width`). Det kan **ikke** verificeres i sandboxen: OpenAPI-specifikationen beskriver
  ikke Shipment Monitor-payloaden, sandboxen har ingen rigtige scanninger, og webhooks kan ikke nå localhost.
  Koden læser `weight` som kg, hvis den er et tal, og ignorerer den ellers. Bekræft med Shipmondo, om DAO
  sender den målte vægt (og i hvilken enhed), før den bruges som bevis.
- Webhook: `{ "data": "<JWT>" }`, HS256 med webhook-nøglen. Kun `alg: HS256` accepteres. Ruten svarer
  200 hurtigt og sender beskeder bagefter (`after()`); fragt-cron'en sender manglende beskeder.

### Opret webhooken (Filip/chef – når der er en offentlig https-adresse)

`POST /webhooks` hos Shipmondo (eller i Shipmondo under Indstillinger → Webhooks), to gange:

```json
{ "name": "BidHamr sporing (latest)", "endpoint": "https://bidhamr.dk/api/fragt/webhook/shipmondo",
  "key": "<SHIPMONDO_WEBHOOK_NOEGLE>", "action": "latest", "resource_name": "Shipment Monitor" }
{ "name": "BidHamr sporing (delivered)", "endpoint": "https://bidhamr.dk/api/fragt/webhook/shipmondo",
  "key": "<SHIPMONDO_WEBHOOK_NOEGLE>", "action": "delivered", "resource_name": "Shipment Monitor" }
```

Localhost kan ikke modtage webhooks fra Shipmondo – test på en Vercel-preview eller med en tunnel.

## Chefens valg (Filip kan ændre)

- Leveringsvalget kan ændre prisen, indtil betalingen er gennemført. Er der en PaymentIntent, annulleres den
  hos Stripe først, og en ny laves med det nye beløb (pi_forsoeg + 1). Efter betaling kan køberen skifte
  pakkeshop, men ikke leveringsmåde. Ingen ændring, når sælgeren har lavet labelen.
- Auktioner uden pakkestørrelse (ældre klienter/appen) bliver Mellem. Eksisterende auktioner med forsendelse
  beholder 35 kr. til pakkeshop (det byderne så); levering til døren til Mellem-pris (85 kr.).
- Pakkestørrelsen på labelen er auktionens – sælgeren kan ikke vælge en anden ved "Send pakke".
  Vægten på labelen er sælgerens vægt eller størrelsens maksimum.
- Pakkeshop uden hjemmeadresse: labelen bruger pakkeshoppens adresse som modtageradresse.
- DAO-kostpris: Shop2Shop har 7 priser for 8 vægttrin – 33 kr. for både 250 g og 500 g (så 1 kg = 35 kr.,
  som giver Filips "ca. 54/70/88 kr."). Energitillæg 15 % + 2 % regnes begge af grundprisen. Labelfri (2 kr.)
  regnes altid med.
- DAO kan ikke annullere: labelen annulleres i BidHamr, og staff markeres. GLS/PostNord: se tabellen ovenfor.
- Shipment Monitor har ingen retur-status: en tekst med "retur/return/til afsender" giver `returneret`,
  `DANGER` giver en ekstra `fejl` – begge kun som markering til staff (medmindre
  `SHIPMONDO_RETUR_ER_IKKE_AFHENTET=true`). Staff trykker "Ikke afhentet", når pakken er sendt retur, fordi
  køberen ikke hentede den (se Flowet, punkt 9).
- Ikke-afhentet pakke: returfragten = fragten ud (det køberen betalte - Filip, 10. okt. 2026). Er den
  mindst buddet, får køberen 0 kr.; refusionsvejen tilbagefører kun sælgerens del (X = U) og afslutter
  betalingen uden Stripe-refusion (`betaling_ikke_afhentet_uden_refusion`).
- Returlabel i sager: køberen betaler returfragten (= fragten ud, `betalinger.fragt_oere`; under 3 kr.: auktionens
  pakkeshop-pris) før koden laves. Stadig bag `FRAGT_RETURLABEL_AKTIV`. Appen: `supabase.rpc("min_returfragt",
  { p_trade })` → køberen `{ rolle: 'koeber', sag: { kode }, id, status, beloeb_oere, betalt_kl, label_klar,
  label_fejl, refunderet_kl, refusion_aarsag }` (`sag.kode = 'ok'` = må sendes nu), sælgeren
  `{ rolle: 'saelger', retur_paa_vej }`.
- Vægt er krævet for ALLE størrelser, når klienten sender en størrelse, og over 15 kg kan aldrig sendes.
  Midlertidigt: uden størrelse (nuværende app) bliver det Mellem uden vægt – se go-live.
- Målt vægt over størrelsens maksimum: kun markering til staff + udbetalingen holdes; sælgeren betaler
  forskellen (ROADMAP), men modregningen er ikke bygget.
- Højst 2 udgående labels pr. handel (inkl. annullerede); flere kræver staffs godkendelse.
- Gamle handler, hvor køberen har startet betalingen før checkout: den gamle PaymentIntent annulleres, når
  køberen prøver at betale, og køberen får én besked "Vælg levering" (fragt-cron).
- Afhentning som valg: BidHamr Beskyttelse kan ikke bruges ved afhentning (ingen sag), så den trækkes fra
  betalingen, når køberen vælger afhentning, og lægges på igen ved skift til forsendelse før betaling.
  Leveringsformen (afhentning/forsendelse) kan kun skiftes før betaling. Eksisterende auktioner med forsendelse
  tilbyder ikke afhentning (`afhentning_mulig` = false), før sælgeren slår det til.
- Ingen automatisk betaling (Filip 9. okt.): alle vindere går gennem checkout. Autobetalingskoden er
  fjernet (`20261012020000_ingen_autobetaling.sql`, docs/BETALINGSMODEL-PLAN.md 1.3); et gemt kort forudfylder kun checkout.
