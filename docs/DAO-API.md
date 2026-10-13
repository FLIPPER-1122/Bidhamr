# DAO's API – notat og plan for DAO-adapteren

Kilde: DAO's offentlige dokumentation, https://api.dao.as/docs/v1/ (samme side som `?shell`), "Protocol for dao
parcelservice", **version 132, gældende fra 28. aug. 2026**. Læst 12. okt. 2026. Siden er én lang
Slate/OpenAPI-side. Der er ikke logget ind nogen steder, og der er ikke sendt nogen kald til DAO.

**Adapteren er bygget (13. okt. 2026), men ikke afprøvet mod DAO**: vi har endnu ingen nøgler og intet
testmiljø, så alt er testet mod egne eksempelsvar (fixtures). Se "Bygget" og "Mangler" lige herunder. Resten af
notatet er planen og dokumentationens indhold, som adapteren bygger på.

---

## Bygget (13. okt. 2026 – mangler nøgler)

| Del | Fil | Status |
|---|---|---|
| Adapter (`Fragtfirma`) | `src/lib/fragt/dao.ts` | Shop2Shop (`c2cindleveringsordre.php`), Shop2Home (`ShoptildirekteLeveringsordre.php`), labelfri kode, PDF via `HentLabel.php`, pakkeshops med åbningstider (`FindPakkeshop.php`), annullering (`AnnullerePakke.php`), sporing (`TrackNTrace_v2.php` med stregkode og med token), efterlysning (`createclaim.php`, bortkommet). Ingen webhook (svarer 404). |
| Parsning | `src/lib/fragt/daoParse.ts` | Tolerant: `OK`/`FEJL`/`ERROR`, engelske feltnavne, "pæne" anførselstegn, tal som tekst, dansk tid -> UTC, sanitering. |
| Hændelseskoder | `src/lib/fragt/daoKoder.ts` | Kun dokumentationens eksempler (10 og 11 -> "undervejs"). **Ukendt kode ændrer aldrig status** (gemmes i `fragt_ukendte_koder`, drift får en advarsel første gang). |
| Valg af firma | `src/lib/fragt/index.ts` | `FRAGTFIRMA=dao`. Tom i udvikling/test = testfragtfirmaet (som før). Shipmondo-adapteren bliver liggende. |
| Migration | `supabase/migrations/20261021010000_fragt_dao_direkte.sql` | `'dao'` i alle checks og funktioner, lempet labelgrænse for DAO, `fragt_sporing_token`, `fragt_ukendte_koder`, `fragt_foraeldreloese`, `fragt_efterlysninger`, `forsendelse_gem_label`. Kørt to gange på testdatabasen. |
| Sporing i cron | `koerFragtCron`/`koerSporingsfeed` i `src/lib/fragt/server.ts` | Ét feed-kald højst hvert 10. minut i betalings-cron'en (hvert 5. minut). Tokenet gemmes først, når alle hændelser er gemt (compare-and-set). Pakke-for-pakke kun som reserve (hver 12. time). |
| "Pakken er kommet frem" | `udfoerHandelseffekter` (uændret) | Køberen får `pakke_leveret` (påkrævet, nøgle `fragt_leveret:<handel>`), så snart DAO's leveret-kode er kendt og står i `daoKoder.ts`. |
| Efterlysning efter 14 dage | `koerEfterlysninger` + `fragt_efterlysning_*` | Én pr. forsendelse. Kalder kun DAO med `FRAGT_EFTERLYSNING_AKTIV=true` (ellers manuel). Staff får altid en markering under Fragt. Pengene holdes af `handel_auto_frigiv` (frigiver aldrig efter 14 dage uden `leveret_kl`). Opret-kaldet genforsøges aldrig. |
| Retur i sager | `opretReturForsendelse` + `ReturlabelBoks` | Shop2Shop med køberen som afsender, sælgeren som modtager og `shopid=0` (DAO vælger shoppen nærmest sælgeren). **Stadig bag `FRAGT_RETURLABEL_AKTIV`** – returfragten opkræves ikke (se docs/FRAGT.md). |
| Ikke afhentet | `DAO_RETUR_ER_IKKE_AFHENTET` i `daoKoder.ts` | Koblet på, men **slået fra** (`false`), indtil returkoden er set på en rigtig pakke. Indtil da kun markering til staff. |
| Annullering og labelgrænse | `forsendelse_claim` | En DAO-label, som DAO har bekræftet annulleret, tæller ikke i "højst 2 labels". Loft: 10 DAO-labels i alt pr. handel (også annullerede). Adapteren sætter kun 'annulleret', når DAO svarer OK. |
| Idempotens uden opslag | `opretForsendelse` i `server.ts` | `genforsoegOpretterNy`: efter et ukendt udfald laver næste forsøg (når sælgeren trykker igen) en NY forsendelse. En kendt, forældreløs stregkode gemmes i `fragt_foraeldreloese` og annulleres (straks og af cron'en, højst 5 gange, derefter staff). |
| Label uden PDF | `sikrLabelPdf` | Kan PDF'en ikke hentes, men der er en labelfri kode, gemmes forsendelsen alligevel, og PDF'en hentes, når sælgeren trykker "Hent label". |
| Tests | `tests/fragt/*.test.ts`, `src/lib/fragt/__fixtures__/dao/` | `npm run test:fragt` (70 tests): mapping, fejlhåndtering, genforsøg kun på læsekald, ét forsøg på ordrer, URL-sanitering, feed-token. |

**Sikkerhed:** `kundeid` og `kode` står i URL'en. URL'en logges aldrig, og ingen fejl indeholder den: fejl bygges
af stien, DAO's fejlkode og en saniteret fejltekst (`saniter()` fjerner også selve værdierne og URL-kodede udgaver).
Kun `https://*.dao.as` accepteres som base-URL, og redirects afvises.

**Fejl:** HTTP 200 med `FEJL`/`ERROR` er en `DaoFejl` (en `FragtFejl` med dansk tekst). Læsekald: 6 s timeout og op til
2 genforsøg. Skrivekald (ordre, annullering, efterlysning): ét forsøg (20 s); udebliver svaret på en ordre, er det
`FragtUkendtUdfald`.

## Mangler (før DAO kan slås til)

1. **Nøgler**: `DAO_KUNDEID` og `DAO_KODE` (Filip – se HUSKELISTE.md). Uden dem svarer alt "Fragt er ikke sat op
   endnu.", og cron'en kalder ikke DAO.
2. **Hændelseskoder**: kald `TrackNTraceKoder.php` (kun læsning) og send rigtige pakker (se "Sådan kan vi teste"),
   og udfyld `daoKoder.ts`: indleveret, klar til afhentning, **leveret** (uden den får køberen ikke "Pakken er kommet
   frem", og 14-dages-frigivelsen sker ikke), retur og fejl. `fragt_ukendte_koder` viser de koder, vi har set.
3. **Ikke afhentet**: sæt `DAO_RETUR_ER_IKKE_AFHENTET = true` først, når returkoden er set på en pakke, der ikke
   blev hentet.
4. **Allans svar** (spørgsmålene herunder), især: idempotens/reference (1), base-URL og nøgler i header (2),
   telefonformat med eller uden 45 (11), om `HentLabel.php` virker på c2c-stregkoder (7), hvad `pris` betyder i
   `createclaim.php` (vi sender buddet i hele kroner) (9), tidszone i `tidspunkt` (3), og om mål (`l`, `h`, `b`) er
   krævet (sendes ikke nu).
5. **Vægtgrænse**: aftalen med DAO. Adapteren bruger Shipmondos grænser (Shop2Shop 15 kg, Shop2Home 5 kg).
6. **Returfragt i sager**: opkrævningen hos køberen er ikke bygget (kræver en beslutning og evt. Stripe) – derfor
   er `FRAGT_RETURLABEL_AKTIV` stadig slået fra.
7. **Efterlysning**: slå `FRAGT_EFTERLYSNING_AKTIV=true` til, når Allan har bekræftet `createclaim.php`.

---

## Resumé

- **Alt det, vi skal bruge, findes:** Shop2Shop (`c2cindleveringsordre.php`, altså C2C), Shop2Home,
  pakkeshopsøgning med åbningstider, labelfri kode, PDF-label, annullering, retur, Track & Trace V2 og
  endda **reklamation/efterlysning** (`createclaim.php`).
- **Labelfri findes via API'et**, som en tekststreng (`labellesskode`, fx `123 456 789`), som sælgeren skriver
  på pakken. Der er **ingen QR-kode** (hverken billede eller streng). PDF-label hentes separat
  (`HentLabel.php`).
- **Sporing kan kun polles. Der er ingen webhook.** Til gengæld har Track & Trace V2 et **token-system**:
  ét kald giver alle nye hændelser på alle vores pakker siden sidste token. Det er bedre end at polle
  pakke for pakke.
- **Ingen prisberegning, intet opslag på reference og ingen vægt i sporingen.** Prisen står allerede i
  vores database. Men vi mister to ting, Shipmondo gav os: genbrug af en forsendelse efter timeout
  (opslag på reference) og den målte vægt.
- **Auth er gammeldags:** `kundeid` og `kode` sendes som **query-parametre** i URL'en på næsten alle kald.
  Fejl kommer som HTTP 200 med `"status": "FEJL"` og en numerisk `fejlkode`. Kun de nye label-endpoints
  (`apiv2.dao.as`) bruger OAuth-token (Keycloak). Der findes et `test=1`-flag på alle ordre-endpoints,
  men intet egentligt testmiljø til pakkeshop-produkterne.

---

## Generelt

| | |
|---|---|
| Base-URL | `https://api.dao.as` (de gamle PHP-endpoints). Dokumentationen skriver `{{baseurlapi}}`, så det skal bekræftes. Nye label-endpoints: `https://apiv2.dao.as` / `https://services.dao.as`. Auth: `https://auth.dao.as`. Testserver kun nævnt for hjemmeretur: `https://homereturnapitest.azurewebsites.net` |
| Auth (gamle endpoints) | `kundeid` (kunde-id hos DAO) og `kode` ("issued password for dao's parcel-api") som query-parametre. OpenAPI'en nævner også et `apikey`-skema, men kun ét endpoint henviser til det, og der står ikke, hvilken header det er. |
| Auth (label v1 på apiv2) | `Authorization: Bearer <token>`. Tokenet hentes med OAuth2 client credentials: `POST https://auth.dao.as/realms/external/protocol/openid-connect/token` (form-urlencoded: `grant_type=client_credentials`, `client_id`, `client_secret`). Svar: `access_token`, `expires_in`, `token_type`. Fejl: 401 med `error`/`error_description`. **Det er andre oplysninger end kunde-id og kode.** |
| Metode | Næsten alt er `GET` med query-parametre. `POST` findes kun til daoHOME-ordre og Track & Trace V2. |
| Format | `format=JSON` (standard), `XML`, nogle steder `CSV`. Al tekst er UTF-8. |
| Svar | `{ status: "OK" \| "FEJL", fejlkode: N3, fejltekst: A80, resultat: {...} }`. **HTTP-status er 200, også ved fejl**, så adapteren skal læse `status`. FindPakkeshop skriver `"ERROR"` i stedet for `"FEJL"`. Pickup-endpoints bruger engelske navne (`errorcode`, `errortext`, `result`, `barcode`). |
| Fejlkoder | Hele listen hentes med `GET /FejlKoder.php?kundeid&kode` → `resultat: [{ fejlkode, fejltekst }]` (eksempel: `1` = "Vej ikke fundet"). Listen er ikke trykt i dokumentationen. |
| Feltlængder | Fra daoHOME-ordren: navn, adresse, postnr og vægt højst 45 tegn, mobil 12, e-mail 60. Ellers står der intet. |
| Testflag | `test=1` på ordre-endpoints: "prevents a new barcode and order lines from being created" (daoGLOBAL: der kommer et realistisk svar, men ingen ordre). |
| Rate limits | Ikke nævnt. Token-systemet i Track & Trace V2 er begrundet med "så I ikke flooder vores API". |
| Vægt og mål | Ingen grænser i dokumentationen. Vægt angives i gram (`vaegt`), mål i cm (`l`, `h`, `b`). Ved daoHOME-ordren står der, at målene ikke bruges. Fra Shipmondos sandbox ved vi, at DAO_STS har vægttrin 250 g til 15 kg og DAO_STH 250 g til 5 kg (se `shipmondo.ts`). |

Dokumentationens eksempler bruger "pæne" anførselstegn (”OK”), og nogle feltnavne er stavet forkert
(`longtide`, `jobdaddressno` i eksemplerne, men `jobaddressno` i ændringsloggen). Adapteren skal derfor
parse tolerant og ikke stole blindt på feltnavnene, før vi har set et rigtigt svar.

---

## Endpoint for endpoint

### 1. Oprettelse af forsendelse

**SHOP2SHOP (det, vi skal bruge til pakkeshop):** `GET /DAOPakkeshop/c2cindleveringsordre.php`
Sælgeren indleverer i en daoSHOP, og køberen henter i en anden. Endpointet hedder "c2c", så det er lavet til
private afsendere.

- Modtager: `shopid` (destinationsshop, `0` = DAO vælger den nærmeste ud fra modtagerens adresse), `postnr`
  (kan have landekode, standard DK), `adresse`, `navn`, `mobil` og/eller `email` (mindst én skal være sat; de
  bruges til DAO's SMS/mail).
- Afsender: `afsender` (navn), `afsender_adresse`, `afsender_postnr` (begge valgfrie), `afs_mobil`, `afs_email`,
  `afs_notifikation` (`0` = DAO sender ikke beskeder til afsender; standard `1`).
- Pakke: `vaegt` (gram), `l`, `h`, `b` (cm).
- `idkrav`: kommasepareret liste over legitimation ved udlevering (kørekort, pas, sygesikringsbevis,
  udleveringskode). Standard er udleveringskode: en firecifret kode, som DAO sender til modtageren.
- `reference` (vores reference), `test`, `format`.
- Svar: `stregkode` (A20, GS1-128, det er sporingsnummeret), **`labellesskode`** ("123 456 789", skrives på
  pakken), `udsortering`.
- **Afsenderens indleveringsshop kan ikke vælges**. Der er ingen parameter til den. Sælgeren kan formentlig
  bruge en hvilken som helst daoSHOP (skal bekræftes).
- Svaret mangler `effektivPakkeshopId`, som daoSHOP-ordren har. Vi kan derfor ikke se, om pakken er omdirigeret
  til en anden shop, fordi køberens shop er lukket (se åbne spørgsmål).

**SHOP2HOME (levering til døren):** `GET /DAODirekte/ShoptildirekteLeveringsordre.php`
Pakken indleveres i en pakkeshop og leveres med daoHOME.

- Samme felter som Shop2Shop, bare uden `shopid` og `idkrav`.
- Svar: `stregkode`, **`labellesskode`**, `labelTekst1-3` (rute, rutebetegnelse, kontrolkode), `udsortering`,
  `jobaddressno`.

**Andre ordretyper (bruges ikke af BidHamr):**

- `GET /DAOPakkeshop/leveringsordre.php` (daoSHOP-ordre, B2C): har `shopid`, `dato`, `priority`, `faktura`,
  `afsenderid` og `afsender_*` og svarer med `ETA` og `effektivPakkeshopId`. Den er til pakker, som DAO
  henter hos en erhvervsafsender, og den giver ingen labelfri kode.
- `GET|POST /DAODirekte/leveringsordre.php` (daoHOME, B2C) og `GET /DAODirekte/LeveringsForespoergsel.php`
  (forespørgsel om ETA og sortering før en hjemmelevering).
- Pickup: `hometohomeorder.php` og `hometoshoporder.php` (DAO henter pakken hos afsenderen med
  `pickup_form` 1-3 og `pickup_date`), `POST /api/AddressVerifierAndScheduler/VerifyAddress` (dækning for
  afhentning på en adresse, svar `days`). Det kan blive relevant senere til store pakker, men ikke nu.
- `daoGLOBAL` (`UdlandLeveringsOrdre.php`): kun til udlandet.

**Label (PDF):** `GET /HentLabel.php?kundeid&kode&stregkode&papir=…`
`papir` er en af `60x100`, `100x150`, `A4Foldable`, `150x100`, `100x150l` eller `100x150p`. Svaret er en PDF
(`application/pdf`) eller JSON med `FEJL`. Det passer til `Label = { type: "pdf", data }`.

Nye label-endpoints på apiv2 kræver bearer-token: `GET /shipment/label/v1/label/{zpl|pdf}/{standard|small}/{barcode}`
og `POST` med `gfCommand` (eget logo på labelen, lavet med `POST /shipment/label/v1/label/gf/generate` ud fra et
base64-billede). Fejl kommer her som rigtige HTTP-fejl (401). Det er ikke nødvendigt i første omgang. Et
BidHamr-logo på labelen kan komme senere.

### 2. Pakkeshopsøgning

`GET /DAOPakkeshop/FindPakkeshop.php?kundeid&kode&adresse&postnr&antal`

- Input: `postnr` (heltal) og `adresse`, og evt. `antal`. **Koordinater kan ikke bruges som input.**
  Teksten nævner "postnr og adresse ELLER shopid", men der står ingen `shopid`-parameter i tabellen.
- Svar: `resultat.pakkeshops[]` med `shopId`, `type` (fx "Priority"), `navn`, `adresse`, `postnr`, `bynavn`,
  `udsortering`, `latitude`/`longitude` (som strenge), `afstand` (km, streng), `afstand_direkte`,
  `afstand_minutter` og **`aabningstider`** `{ man, tir, ons, tor, fre, lor, son }` (fx `"07:30 - 21:00"`).
  Desuden `resultat.udgangspunkt` (`latitude`, `longtide` [sic], `position_from_postal` = true, når
  adressen ikke blev fundet og postnummerets midte blev brugt) og `antal`.
- `GET /DAOPakkeshop/ShopInfoRequest.php?shopid&dato` giver kun sorteringskoder for en shop, ikke navn og
  adresse. Det kan ikke bruges til at slå én shop op.
- `GET /DAOPakkeshop/OpdaterShopid.php?stregkode&shopid`: skift destinationsshop på en oprettet pakke.

### 3. Prisberegning

**Findes ikke.** Der er intet pris-endpoint, og ordresvarene indeholder ingen pris. Prisen kommer kun fra aftalen
og fakturaen.

### 4. Annullering

To endpoints:

- `GET /AnnullerePakke.php?kundeid&kode&stregkode` ("Cancel parcel data"): annullerer forsendelsen. Svarer
  `status`/`fejlkode`/`fejltekst`. Dokumentationen siger ikke, hvor længe det kan nås (formentlig indtil
  pakken er indleveret).
- `GET /DAOPakkeshop/HjemkaldPakke.php?stregkode` ("Revoke parcel"): kalder en pakke hjem fra en pakkeshop.
  Det er til en pakke, der allerede ligger i shoppen, ikke til en label, der skal annulleres.

Til sammenligning kan Shipmondo ikke annullere DAO (422). Direkte hos DAO er der altså et endpoint.

### 5. Retur

`GET /DAOPakkeshop/returordre.php` ("daoSHOP return order", dokumentationen kalder det ikke daoSHOPRETURN)

- Modtager: `postnr`, `adresse`, `navn` (den, der skal have returen). Afsender: `afsender`,
  `afsender_adresse`, `afsender_postnr`, `afs_mobil`, `afs_email` (de fleste er valgfrie).
- `type`: `labelless` (standard, svaret har en labelfri kode) eller `withlabel` (svaret har labeldata).
- `faktura` (reference), `test`, `format`.
- Svar: `labellesskode`, `stregkode`, `labelTekst1` (kontrolkode).
- **Ingen `shopid`, ingen mobil/e-mail på modtageren og ingen vægt.** Det ligner en webshop-retur, der
  leveres til DAO-kundens egen adresse. Det svarer til Shipmondos "DAO_R kun til erhvervsadresser".
  **Til BidHamr-retur (køber → privat sælger) bør vi bruge SHOP2SHOP med køberen som afsender og sælgeren som
  modtager (`shopid=0`, altså nærmeste shop ved sælgeren).** Det passer præcis til vores interface ("Retur:
  altid til en pakkeshop tæt på modtageren") og giver også en labelfri kode.
- Hjemmeretur med afhentning (`/DAOHomeReturn/CreateHomeReturn.php` og `UpdateHomeReturn.php`) findes også,
  men vi har ikke brug for den.

### 6. Track & Trace V2

`GET /TrackNTrace_v2.php?kundeid&kode&(stregkode | token)&sprog=DA|EN&format=JSON` (findes også som `POST`
med `stregkode` i body; kundeid og kode skal stadig i query).

- **Med stregkode:** `resultat: { stregkode, pakketype, eta, afsender, modtager: { navn, adresse, post, land },
  ekstern_tracking, haendelser: [{ tidspunkt, haendelse, beskrivelse, pakketype: "Home"|"Shop"|…, sted }] }`.
- **Med token:** start med `token=0`. Svaret giver `token` (næste token, N10) og
  `resultat: [{ stregkode, haendelser: [{ tidspunkt, haendelse, beskrivelse, sted, shopid }] }]` for **alle
  vores pakker** siden det forrige token. Hver gang gemmer vi det nye token og bruger det næste gang.
- `tidspunkt` er `"YYYY-MM-DD HH:MM:SS"` uden tidszone (formentlig dansk tid, skal bekræftes).
  `haendelse` er en numerisk kode.
- Bemærk: for HOME-pakker står leveringsteksten i `sted`, for andre i `beskrivelse`.
- **Hændelseskoder:** de står ikke i dokumentationen. De hentes med `GET /TrackNTraceKoder.php` →
  `resultat: { direkte: [{ haendelse, beskrivelse }], pakkeshop: [{ haendelse, beskrivelse }] }` (separate lister for
  daoHOME og daoSHOP). Eneste eksempler: `10` "Pakke modtaget på fordelingscenter"/"Pakke ankommet" og
  `11` "Pakken har forladt DAO terminal". **Hvilke koder der betyder indleveret, klar til afhentning,
  leveret og retur, kan vi først mappe, når vi har kaldt TrackNTraceKoder med rigtige oplysninger.**
- **Vægt og mål står ikke i svaret.**
- **Ingen webhook/push.** Kun polling (med token).
- V1 (`TrackNTrace.php`) er forældet. Den må ikke bruges.

### 7. Andre nyttige endpoints

- `GET /createclaim.php?type=bortkommet|beskadiget&stregkode&referencenr&pris`: opretter en
  **reklamationssag** hos DAO. Den passer til roadmap-punktet "ingen leveringsmelding efter 14 dage → efterlysning
  hos DAO" (`bortkommet`) og til reklamation ved transportskade (`beskadiget`). Den har ingen billeder, ingen
  status og intet sags-id i svaret.
- `GET /DAOPakkeshop/OpdaterKontaktOplysning.php?stregkode&mobil&email`: ret modtagerens mobil eller e-mail.
  DAO sender beskeden igen, hvis den allerede er sendt.
- `GET /OpdaterVaegt.php?stregkode&l&h&b`: ret vægt og mål, før pakken er scannet på den første terminal.
  Tabellen nævner kun `l,h,b` og ikke `vaegt`. Det er nok en fejl i dokumentationen.
- `GET /SetGiverOplysninger.php`: giveroplysninger på en gave (bruges ikke).

---

## Mapping til BidHamrs fragt-interface (`src/lib/fragt/types.ts`)

| `Fragtfirma` | DAO | Passer? |
|---|---|---|
| `navn` / `visningsnavn` | `"dao"` / `"DAO"` | Kræver `"dao"` i `FRAGTFIRMAER` **og en migration**: check-constraints og funktioner har `('test','gls','shipmondo')` hardkodet (`20261006010000_fragt_skelet.sql`, `20261012010000_fragt_dao_shipmondo.sql`, `20261013020000_afhentning_valg.sql`). |
| `beregnPris` | Intet endpoint | Som Shipmondo: kast `FragtFejl("Fragtprisen står på auktionen.")`. Prisen kommer fra `fragt_pakkestoerrelser`, og kostprisen fra `fragt_kostpriser`. |
| `opretForsendelse` (pakkeshop) | `c2cindleveringsordre.php` med `shopid = pakkeshopId` | Passer. `forsendelsesId` = `sporingsnummer` = `stregkode` (DAO har ikke to id'er). `qrKode` = `labellesskode`. `label` = PDF fra `HentLabel.php` (A4Foldable eller 100x150). `prisOere` = null. `produkt` = `"DAO_C2C"` (eget navn). |
| `opretForsendelse` (døren) | `ShoptildirekteLeveringsordre.php` | Passer, inkl. labelfri kode. Grænsen på 5 kg håndhæves af os som i dag. |
| `opretReturforsendelse` | `c2cindleveringsordre.php` med `shopid=0` (køber → sælger) | Passer. `returordre.php` passer formentlig ikke til private modtagere (se ovenfor). |
| Idempotens (`reference`, `FragtUkendtUdfald`) | `reference` kan sendes, men **der er intet opslag på reference** | **Mangler.** Ved timeout kan vi ikke finde forsendelsen igen. Se forslag nedenfor. |
| `annullerForsendelse(id)` | `AnnullerePakke.php?stregkode=id` | Passer. `FEJL` efter indlevering → `FragtAnnulleringIkkeMulig`. Dermed kan grænsen "højst 2 labels, fordi DAO ikke kan annullere" formentlig lempes. |
| `hentSporing(sporingsnummer)` | `TrackNTrace_v2.php?stregkode=…` | Passer. `noegle` = `stregkode:haendelse:tidspunkt`. `raa` = `{ haendelse, beskrivelse, sted, shopid, pakketype }`. |
| Sporing af alle pakker | `TrackNTrace_v2.php?token=…` | **Nyt.** Interfacet og `koerFragtCron` kender kun sporing pakke for pakke. Se forslag. |
| `fortolkWebhook` | Ingen webhook | Returnér `{ ok: false, status: 404, fejl: "DAO har ingen webhook" }`. Ruten `/api/fragt/webhook/dao` bliver ubrugt. |
| `SporingsType`-mapping | Numeriske koder fra `TrackNTraceKoder.php` | **Mangler data.** Mappingen kan først skrives, når vi har kodelisten. Ukendte koder ignoreres (gemmes kun i `raa`), så vi aldrig gætter "leveret". |
| `returErIkkeAfhentet` | Afhænger af, om DAO har en entydig kode for "ikke afhentet – retur til afsender" | Sættes først til `true`, når koden er kendt og set i praksis. |
| `soegPakkeshops` | `FindPakkeshop.php` | Passer. `afstandM` = `afstand × 1000`. `aabningstider` = man…son → "Mandag"…"Søndag". `lat`/`lng` = `Number(...)`. `by` bruges ikke, kun `postnummer` og `adresse`. |
| `hentPakkeshop(id, naer)` | Intet opslag på id | Som Shipmondo: søg nær køberen (`antal: 20`) og find id'et i listen. |
| Målt vægt (`raa.maalt_vaegt_gram`, bruges i `server.ts` linje ~917) | Ikke i sporingen | **Mangler.** Markeringen "pakken vejer mere end størrelsens maksimum" virker ikke med DAO direkte, før DAO giver os vægten på en anden måde. |
| `Adresse.telefon` | `mobil`/`afs_mobil` (heltal; pickup-endpoints vil have `45` foran 8 cifre) | Formatet skal afprøves (med eller uden 45). |

**Ikke i interfacet i dag, men nyttigt:** reklamation (`createclaim`), skift af destinationsshop
(`OpdaterShopid`), ret modtagerens kontaktoplysninger og ret vægten. De kan tilføjes som valgfrie metoder på
`Fragtfirma`, når et roadmap-punkt skal bruge dem (efterlysning efter 14 dage og reklamation ved transportskade).

---

## Forslag til adapterens filer og funktioner

```
src/lib/fragt/dao.ts          adapteren (export const daoFirma: Fragtfirma)
src/lib/fragt/daoKoder.ts     DAO-hændelseskode → SporingsType (ren tabel, kan testes)
src/lib/fragt/__fixtures__/dao/*.json   rigtige svar (anonymiserede) til test
```

`dao.ts` (samme mønster som `shipmondo.ts`):

- `konfig()`: env `DAO_API_URL` (standard `https://api.dao.as`, kun https og kun dao.as tilladt),
  `DAO_KUNDEID`, `DAO_KODE` og `DAO_TESTMODE` (`"true"` sender `test=1` på alle ordrer). Senere evt.
  `DAO_CLIENT_ID`/`DAO_CLIENT_SECRET` til apiv2. Mangler noget, kastes `FragtFejl(FRAGT_IKKE_SAT_OP)`.
- `kald(sti, params)`: GET med `URLSearchParams` (kundeid, kode, `format=JSON`) og timeout på 15 sek.
  Netværksfejl/timeout/5xx på en **ordre** → `FragtUkendtUdfald`. Svaret parses tolerant. `status !== "OK"` →
  `DaoFejl(fejlkode, fejltekst)`. **URL'en må aldrig logges eller lægges i en fejlbesked, fordi `kode` står i
  den.** Fejltekster bygges kun ud af sti, `fejlkode` og `fejltekst`.
- `hentLabelPdf(stregkode)`: `HentLabel.php`, kræver `content-type: application/pdf`, ellers parses JSON-fejlen.
- `opret(input, retur)`: validering (vægt, døren ≤ 5 kg, pakkeshop valgt, mobil eller e-mail) → c2c- eller
  shop2home-ordre → PDF. Fejl fra DAO før oprettelse (`FEJL`) → `FragtFejl` med en dansk tekst ud fra
  `fejlkode`. Fejl efter oprettelsen (fx når PDF'en hentes) → `FragtUkendtUdfald`, **men med stregkoden i
  beskeden**, så staff kan tilknytte den.
- `tilPakkeshop(p)`, `aabningstider(obj)` og `soeg(q)`.
- `hentSporing(stregkode)`: V2 med stregkode → `Sporingshaendelse[]` via `daoKoder.ts`.
- `hentSporingFeed(token)`: **ny valgfri metode** på `Fragtfirma`:
  `hentSporingFeed?(token: string): Promise<{ nyToken: string; haendelser: WebhookHaendelse[] }>`.
  `koerFragtCron` kalder den én gang pr. kørsel for DAO, finder forsendelsen ud fra sporingsnummeret
  (`findForsendelse`) og gemmer hændelserne med `registrerForsendelseshaendelse(…, "sporing")`.
  Tokenet gemmes i en lille tabel (fx `fragt_sporing_token(fragtfirma pk, token, opdateret_kl)`, kun
  service_role). Det nye token gemmes først, **når** alle hændelser er gemt, så et nedbrud giver en
  gentagelse og aldrig et hul. Det går fint, fordi hændelser er idempotente via `noegle`. Polling pakke for
  pakke beholdes som reserve (fx til forsendelser uden hændelser efter X timer).
- `daoFirma` med `returErIkkeAfhentet: false`, indtil returkoden er kendt.

Andre ændringer:

- `types.ts`: `"dao"` i `FRAGTFIRMAER` og den valgfrie `hentSporingFeed`.
- `index.ts`: `case "dao": return daoFirma`.
- Migration: tilføj `'dao'` i check-constraints og funktioner (søg efter `'shipmondo'` i migrationerne) og
  tabellen med sporingstoken.
- `server.ts`: `hentEksisterende` er i dag Shipmondo-specifik (staff "tilknyt"). Til DAO skal staff kunne
  tilknytte ud fra en **stregkode**: sporing via V2 og label via `HentLabel`. Den labelfri kode kan formentlig
  ikke hentes igen (der er intet endpoint til det), så det skal spørges.
- `docs/FRAGT.md` opdateres, når adapteren er bygget.

**Idempotens uden opslag på reference (forslag):** DAO siger, at forsendelser, der aldrig indleveres, ikke
faktureres. En "forældreløs" forsendelse fra en timeout koster altså ingenting. Ved `FragtUkendtUdfald` kan
næste forsøg derfor lave en **ny** forsendelse i stedet for at vente på staff, og sælgeren ser kun den nye
labelfri kode. Det kræver en lille ændring af claim-logikken i `server.ts` (et flag på adapteren, fx
`genforsoegOpretterNy: true`), og det skal reviewes. Hvis DAO bekræfter, at `reference` er idempotent, er
det ikke nødvendigt.

---

## Åbne spørgsmål til DAO (nye)

Filips spørgsmål, som dokumentationen faktisk besvarer (helt eller delvist):

- **Annullering:** ja, `AnnullerePakke.php` findes (og `HjemkaldPakke.php` til pakker i shoppen). Det er stadig
  uklart, hvor længe en Shop2Shop-pakke kan annulleres, og om en annulleret label er gratis.
- **Webhook:** der står ingen i dokumentationen. Token-polling er DAO's løsning. Spørg kun, om der findes en
  udokumenteret push.
- **Fuld dokumentation:** siden ser ud til at være den fulde (version 132, 28. aug. 2026). Kun
  fejlkodelisten og sporingskoderne mangler, og de hentes via API'et.
- **Kunde-id/API-nøgle:** auth er `kundeid` + `kode` (query). Bed også om **Keycloak `client_id`/`client_secret`**,
  hvis vi vil bruge de nye label-endpoints.
- **Retur:** `returordre.php` findes med labelfri kode som standard, men den ser ud til at levere til
  DAO-kundens adresse. Se spørgsmål 6.
- **Private afsendere:** Shop2Shop-endpointet hedder `c2cindleveringsordre` og har afsenderfelter. Det er
  lavet til det.
- **Erstatning:** `createclaim.php` findes, men beløbsgrænser og regler står der intet om.
- **Pris:** intet pris-endpoint.

Nye spørgsmål:

1. **Idempotens:** kan vi slå en forsendelse op ud fra `reference`, eller afviser DAO en ny ordre med samme
   `reference`? Hvad gør vi, hvis svaret på en ordre aldrig når frem (timeout)?
2. **Base-URL:** er `{{baseurlapi}}` = `https://api.dao.as` for de gamle PHP-endpoints? Kan `kundeid`/`kode`
   sendes i en header eller i en POST-body i stedet for i URL'en (af sikkerhedshensyn)?
3. **Hændelseskoder:** hvilke `haendelse`-koder betyder (a) indleveret i pakkeshop, (b) klar til afhentning,
   (c) udleveret til modtager, (d) ikke afhentet/returneret til afsender, (e) fejl/skadet? Er koderne de
   samme for Shop2Shop og Shop2Home? Er `tidspunkt` dansk tid?
4. **Token-polling:** hvor ofte må vi kalde `TrackNTrace_v2` med token? Er der rate limits på de andre kald
   (FindPakkeshop ved hver checkout)? Hvor længe er et token gyldigt, hvis vi ikke kalder i flere dage?
5. **Shop2Shop – indleveringsshop:** kan sælgeren indlevere i en hvilken som helst daoSHOP? Hvorfor svarer
   `c2cindleveringsordre` ikke med `effektivPakkeshopId`? Hvordan får vi besked, hvis køberens shop er lukket,
   og pakken omdirigeres?
6. **Retur til privatperson:** kan `returordre.php` levere til en pakkeshop eller en privat adresse, eller skal vi
   bruge Shop2Shop med køberen som afsender til retur i sager?
7. **Labelfri kode:** kan koden hentes igen senere ud fra stregkoden (fx hvis sælgeren mister den)? Hvor længe
   er den gyldig? Findes der en QR-version, som shoppen kan scanne fra mobilen? Kan `HentLabel.php` lave en
   PDF-label til en c2c-stregkode?
8. **Vægt:** vejer DAO pakken på terminalen, og kan den målte vægt og målene hentes via API (bevis i sager og
   efteropkrævning ved for lille pakkestørrelse)? Hvordan opkræves overvægt? Hvilke vægt- og målgrænser
   gælder for Shop2Shop og Shop2Home?
9. **Reklamation (`createclaim`):** hvordan sendes billeder og dokumentation? Får vi et sagsnummer, og kan vi
   følge status via API? Hvor længe efter afsendelse kan der oprettes en "bortkommet"-sag?
10. **`test=1`:** hvad svarer endpointet med (dummy-stregkode og dummy-labelfri kode)? Virker `HentLabel` og
    `TrackNTrace_v2` på en teststregkode? Findes der en testserver for pakkeshop-produkterne (som
    `homereturnapitest`)?
11. **Telefonformat:** `mobil`/`afs_mobil` med eller uden `45`? Og hvad hvis køberen kun har e-mail?
12. **`idkrav`:** hvilke værdier skal stå i listen (præcise strenge)? Kan vi få udleveringskoden at vide
    (bevis for, at køberen har hentet pakken)?
13. **Faktura og afstemning:** kan vi få forsendelser og priser pr. stregkode (API eller fil), så vi kan afstemme
    DAO's faktura med `forsendelser.forventet_kostpris_oere`?

---

## Sådan kan vi teste uden et testmiljø

DAO siger, at forsendelser, der aldrig indleveres, ikke faktureres. Planen er derfor:

1. **Kun læsning mod den rigtige API (gratis):** `FindPakkeshop`, `FejlKoder`, `TrackNTraceKoder` og
   `ShopInfoRequest`. De giver os kodelisterne, som mappingen i `daoKoder.ts` skal bygges på, og rigtige
   svar som fixtures.
2. **`test=1` på ordrer:** afprøv parametre, telefonformat og fejlkoder (manglende mobil/e-mail, forkert postnummer,
   ukendt shop) uden at der oprettes noget. Det styres af `DAO_TESTMODE=true` i `.env.local`.
3. **Rigtige ordrer, der aldrig indleveres:** opret nogle Shop2Shop- og Shop2Home-forsendelser til Filips egen
   adresse (ingen rigtige brugere): label-PDF, labelfri kode, Track & Trace V2 (kun "oprettet") og
   **`AnnullerePakke`**. Alle laves fra `npm run dev` mod **testdatabasen** (`pjiigmzqwlfepxnjdvug`). Skriv
   stregkoderne ned, så de kan annulleres og afstemmes med fakturaen.
4. **Få rigtige pakker hele vejen (koster almindelig fragt):** Filip sender 2-3 pakker til sig selv eller til en
   kollega for at få de rigtige sporingskoder: indleveret, i transit, klar til afhentning og leveret, og én,
   der **ikke hentes**, så vi ser returkoden (tager ca. en uge). Først derefter må
   `returErIkkeAfhentet` sættes til `true`.
5. **Automatiske tests med fixtures:** `daoKoder.ts` og parsningen (tolerant JSON, `FEJL` og `ERROR`, strenge til
   tal, åbningstider) testes mod gemte svar. Token-feeden testes med to svar i træk (nyt token gemmes først efter
   hændelserne).
6. **Testfragtfirmaet** (`testFirma.ts`) bruges fortsat til e2e-test af handelsflowet. DAO-adapteren slås kun
   til med `FRAGTFIRMA=dao` lokalt, indtil ovenstående er gennemført.
