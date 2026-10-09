# Fragt – DAO via Shipmondo

Server-delen af fragten (ROADMAP fase 2). Beslutninger: ROADMAP-BESLUTNINGER.md afsnit 2
("Fragtfirma og priser", Filip 9. okt. 2026). Migration: `supabase/migrations/20261012010000_fragt_dao_shipmondo.sql`.

> **Produktion:** migrationen må IKKE køres i produktion, før både hjemmesiden OG appen viser den låste
> fragtpris (`fragt_pakkeshop_oere`) og har checkout før betaling. Ellers ser byderne 35 kr. og betaler
> 40/50/65 kr., og betalingen kan ikke startes uden leveringsvalg. Kør migrationen og deploy hjemmesiden
> lige efter hinanden (koden læser de nye kolonner).

## Flowet

1. **Opret auktion**: sælgeren vælger forsendelse + pakkestørrelse (Lille ≤ 1 kg, Mellem ≤ 5 kg, Stor ≤ 15 kg)
   og vægt (altid krævet). Databasen håndhæver grænserne (også fra appen) og **låser
   fragtprisen på auktionen** (`auctions.fragt_pakkeshop_oere` / `fragt_doer_oere`). Over 15 kg: kun afhentning.
2. **Budpanelet** viser `fragt_pakkeshop_oere` (billigste levering) før buddet.
3. **Auktionen slutter**: betalingen oprettes med pakkeshop-prisen som fragt.
4. **Checkout (før betaling)**: køberen vælger *pakkeshop* (søg + vælg shop) eller *levering til døren*
   (kun Lille/Mellem). Valget gemmes på handlen (`handel_levering`), og betalingens fragt, total og
   BidHamrs gebyr (application fee) rettes. **Betalingen kan ikke startes uden et gyldigt valg**
   (`startBetaling` svarer `{ fejl, kode: "vaelg_levering" }`; databasen afviser også en PaymentIntent).
   Afhentning hos sælger kræver intet valg.
5. **Send pakke**: sælgeren udfylder sin afsenderadresse → forsendelsen oprettes hos Shipmondo (DAO) →
   PDF-label + DAO's labelfri-kode. Sælgeren tager stadig de to pakkebilleder og trykker "Send pakke"
   som i dag (labelen flytter ikke handlen). Højst 2 labels pr. handel (også annullerede) – flere kræver,
   at staff godkender (`fragtGodkendEkstraLabel` i `src/app/actions/adminFragt.ts`).
   Svarer fragtfirmaet ikke (timeout/netværk/5xx, eller fejl efter oprettelsen), bliver forsøget stående,
   og næste "Send pakke" (efter mindst 1 minut) genbruger samme reference – der bestilles aldrig en ny label,
   før det er afklaret. Drift-loggen får "Fragt: ukendt udfald". Et genoptaget forsøg markeres aldrig
   'fejlet' af systemet – staff afslutter det med `fragtAfslutHaengendeLabel` (adminFragt.ts): "markér
   fejlet" (intet oprettet hos Shipmondo, note krævet) eller "tilknyt" (Shipmondos forsendelses-id; referencen
   skal være BidHamrs forsendelses-id). Begge logges i medarbejder-loggen. Knappen bygges af frontend.
6. **Annullering**: så længe pakken ikke er indleveret. DAO kan ikke annullere via Shipmondo – labelen
   annulleres i BidHamr, og staff får en markering (bed Shipmondo/DAO kreditere den).
7. **Sporing**: kun via Shipmondos webhook "Shipment Monitor" → `/api/fragt/webhook/shipmondo`.
   "Pakken er kommet frem" (`pakke_leveret`) til køberen og "Pakken er indleveret" (ny type
   `pakke_indleveret`, påkrævet) til sælgeren. Vejer fragtfirmaet pakken tungere end størrelsens maksimum,
   markeres forsendelsen og betalingen til staff (udbetalingen holdes); modregning hos sælgeren er ikke bygget. **Levering/afhentning udløser aldrig
   udbetaling** – kun købers bekræftelse eller de eksisterende regler i autoFrigiv.
8. **Retur i sager**: returlabel (køber → pakkeshop nær sælgeren). Slået fra (`FRAGT_RETURLABEL_AKTIV`),
   indtil opkrævningen af returfragten hos køberen er bygget.

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
| `soegPakkeshopsAction({ postnummer, adresse?, by?, antal? })` | logget ind | `{ ok, fragtfirma, pakkeshops: Pakkeshop[] }` |
| `hentCheckoutAction(tradeId)` | køber | `{ ok, checkout }` (se Checkout i `src/lib/fragt/handlinger.ts`) |
| `gemLeveringsvalgAction(tradeId, { maade, pakkeshopId?, pakkeshopPostnummer?, pakkeshopAdresse?, modtager, gemForslag? })` | køber | `{ ok, fragtOere, totalOere, prisAendret }` |
| `lavFragtlabel(tradeId, afsender?)` | sælger | `{ ok }` – uden afsender bruges sidst brugte adresse |
| `annullerFragtlabel(tradeId, forsendelseId)` | sælger | `{ ok }` |
| `hentFragtlabelLink(forsendelseId)` | sælger (udgående) / køber (retur) | `{ url }` (5 min) |
| `hentMinForsendelse(tradeId)` | køber og sælger | aktiv udgående forsendelse (som før) |
| `hentForsendelserAction(tradeId)` | køber og sælger | alle forsendelser + sporingstidslinje |
| `lavReturlabelAction(tradeId, afsender)` | køber | `{ ok, forsendelseId }` (slået fra) |

Alle fejl returneres som `{ fejl: "<dansk tekst>" }`, der kan vises direkte.

`Pakkeshop = { id, navn, adresse, postnummer, by, lat, lng, afstandM, aabningstider: [{ dag, tider }] }`.
`modtager = { navn, telefon, adresse?, postnummer?, by? }` – adresse krævet ved levering til døren.
`afsender = { navn, adresse, postnummer, by, telefon? }`.

Labelen og labelfri-koden vises kun for den part, der skal sende pakken (`harLabel`, `labelfriKode`).
Labelfri-koden (DAO) skrives på pakken eller vises i pakkeshoppen, så sælgeren ikke behøver printer.
**I sandboxen er koden altid `123-456-789`.**

## Appen (Expo)

Alle kald: `POST https://bidhamr.dk/api/fragt/app/<handling>` med
`Authorization: Bearer <session.access_token>` og `Content-Type: application/json`.
Svar: `200 { ok: true, ... }` eller `409 { fejl, kode: "afvist" }` (vis `fejl`), `401` (log ind igen),
`429` (for mange forsøg), `400/413` (forkert krop), `500`.

| handling | krop | svar |
|---|---|---|
| `pakkeshops` | `{ postnummer, adresse?, by?, antal? }` | `{ fragtfirma, pakkeshops }` |
| `checkout` | `{ trade_id }` | `{ checkout }` |
| `levering` | `{ trade_id, maade: "pakkeshop" \| "doer", pakkeshop_id?, pakkeshop_postnummer?, pakkeshop_adresse?, modtager: { navn, telefon, adresse?, postnummer?, by? }, gem_forslag? }` | `{ fragtOere, totalOere, prisAendret }` |
| `book` | `{ trade_id, afsender? }` | `{ forsendelseId }` |
| `annuller` | `{ trade_id, forsendelse_id }` | `{}` |
| `forsendelser` | `{ trade_id }` | `{ forsendelser }` |
| `label` | `{ forsendelse_id }` | `{ url }` (PDF, 5 min) |
| `retur` | `{ trade_id, afsender }` | `{ forsendelseId }` (slået fra) |

Direkte fra Supabase i appen (med brugerens session):

- Priser: `supabase.from("fragt_pakkestoerrelser").select("kode, navn, maks_gram, pakkeshop_oere, doer_oere").order("sortering")`
- Auktionens fragt: kolonnerne `pakkestoerrelse, vaegt_gram, fragt_pakkeshop_oere, fragt_doer_oere` på `auctions`.
- Checkout-overblik: `supabase.rpc("handel_checkout", { p_trade })` (kun køberen).
- Eget leveringsvalg inkl. adresse: `supabase.rpc("mit_leveringsvalg", { p_trade })`.
- Forslag (sidst brugte adresse/pakkeshop): `supabase.from("leveringsforslag").select("*").maybeSingle()`;
  slet: `supabase.rpc("slet_mit_leveringsforslag")`.
- Sælger ændrer pakkestørrelse/vægt før første bud: `supabase.rpc("saet_auktion_fragt", { p_auktion, p_pakkestoerrelse, p_vaegt_gram })`
  → `{ kode: "ok" | "har_bud" | "for_tung" | "stoerrelse" | "ikke_aktiv" | "skjult" | "ikke_fundet" | "ugyldig", ... }`.

**Appen skal ændre:**

1. Opret auktion: send `pakkestoerrelse` (`lille`/`mellem`/`stor`) og `vaegt_gram` (altid krævet)
   sammen med `forsendelse_mulig`. Fejlkoder fra insert/update: `BHT01` (over 15 kg – kun afhentning),
   `BHT02` (vægten passer ikke til størrelsen) og `BHT03` (vægt mangler). Sendes størrelsen ikke (den
   nuværende app), bliver den Mellem uden krav om vægt – når appen sender størrelsen, gøres kravet generelt.
2. Auktionssiden/budpanelet: vis `fragt_pakkeshop_oere` i stedet for de faste 35 kr.
3. Checkout-skærm før betalingen (pakkeshop med kort/liste, eller levering til døren) → `levering`.
   Først derefter "Betal". Får betalingen `kode: "vaelg_levering"`, så send køberen til checkout.
4. "Send pakke": afsenderadresse → `book`, vis PDF (`label`) og labelfri-koden.
5. Tidslinje fra `forsendelser`, notifikationstypen `pakke_leveret` findes allerede.

## Go-live (produktion)

1. Appen sender `pakkestoerrelse` + `vaegt_gram`, viser den låste fragtpris og har checkout før betaling.
2. Hjemmesiden er klar (budpanel, opret, checkout, Send pakke).
3. **Fjern undtagelsen** i `auctions_fragt` (klienter uden størrelse får Mellem uden vægt) i en ny migration,
   så vægt altid kræves ved forsendelse.
4. Kør migrationen og deploy hjemmesiden lige efter hinanden.
5. Opret Shipmondo-webhooks (se nedenfor) og sæt `SHIPMONDO_*` + `FRAGTFIRMA=shipmondo` i Vercel (Filip).

## Shipmondo (verificeret mod sandboxen 9. okt. 2026)

- DAO-produkter: `DAO_STS` (daoSHOP drop-off = Shop2Shop, 250 g–15 kg, pakkeshop krævet) og
  `DAO_STH` (daoHOME drop-off = Shop2Home, 250 g–5 kg). Notifikation: mindst én af `EMAIL_NT`/`SMS_NT`.
  `DAO_P`/`DAO_H` (afhentning hos afsender) og `DAO_R` (retur kun til erhverv) bruges ikke.
- Idempotens: `reference` = BidHamrs forsendelses-id. Findes referencen allerede hos Shipmondo,
  genbruges forsendelsen. Bemærk: Shipmondos søgning på reference er ikke opdateret med det samme
  (få sekunder) – databasen (`forsendelse_claim`) forhindrer derfor selv dobbeltbestilling, og en
  fejl med ukendt udfald logges i drift med referencen.
- Pakkeshops: `GET /service_point/service_points` (højst 20 pr. kald). Afstand fra Shipmondo, når
  adressen er med – ellers beregnet fra postnummerets midte.
- QR-kode (`/shipments/{id}/qr_code`) kræver servicen `QR_CODE`, som DAO ikke har → PDF-label + labelfri-kode.
- Annullering: DAO svarer 422 "It's not possible to cancel this shipment." (GLS kan annulleres).
- Sporing: intet sporings-endpoint i API v3 – kun webhooken. `hentSporing` giver derfor ingen hændelser,
  og fragt-cron'en kan ikke hente sporing som reserve. Mister vi en webhook, kommer den næste status
  ("latest") stadig. Shipmondo skriver, at Shipment Monitor "updates once a day" – spørg på mødet.
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
- DAO kan ikke annullere: labelen annulleres i BidHamr, og staff markeres.
- Shipment Monitor har ingen retur-status: en tekst med "retur" giver `returneret`, `DANGER` giver `fejl` –
  begge kun som markering til staff.
- Returlabel er slået fra, indtil returfragten opkræves hos køberen.
- Vægt er krævet for ALLE størrelser, når klienten sender en størrelse, og over 15 kg kan aldrig sendes.
  Midlertidigt: uden størrelse (nuværende app) bliver det Mellem uden vægt – se go-live.
- Målt vægt over størrelsens maksimum: kun markering til staff + udbetalingen holdes; sælgeren betaler
  forskellen (ROADMAP), men modregningen er ikke bygget.
- Højst 2 udgående labels pr. handel (inkl. annullerede); flere kræver staffs godkendelse.
- Gamle handler, hvor køberen har startet betalingen før checkout: den gamle PaymentIntent annulleres, når
  køberen prøver at betale, og køberen får én besked "Vælg levering" (fragt-cron).
- Ingen automatisk betaling (Filip 9. okt.): alle vindere går gennem checkout. Autobetalingskoden fjernes
  af betalingsagenten; med fragt fejler den nu pænt (kræver leveringsvalg), og køberen betaler selv.
