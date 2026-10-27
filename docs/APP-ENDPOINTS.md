# App-endpoints: handelstrin, bud, konto og RPC'er

Bygget 15. okt. 2026. Supplerer `docs/APP-BETALING.md` (betaling), `docs/FRAGT.md` (fragt) og `docs/APP-SIGNUP.md`
(oprettelse). Alle endpoints genbruger hjemmesidens server-kode, så mails, push, klokke og udbetaling sker præcis som
på hjemmesiden:

| Endpoint | Fælles kode (samme som hjemmesidens server action) |
|---|---|
| `/api/handel/app/send-pakke`, `modtaget`, `godkend`, `afhentning-bekraeft` | `src/lib/handel/handelstrin.ts` (`sendPakke`, `markerModtaget`, `godkendPakke`, `bekraeftAfhentning`) |
| `/api/handel/app/status` | `src/lib/handel/handelStatus.ts` + `src/lib/betaling/betalingsstatus.ts` (som handelssiden) |
| `/api/handel/app/andenchance-*`, `genopsaet` | `src/lib/andenchance.ts` (`hentAndenchanceStatus`, `sendAndenchanceTilbud`, `svarAndenchance`, `genopsaetAuktion`) |
| `/api/bud/app` | `src/lib/bud/afgivBud.ts` (`afgivBud`, `saetMaksimum`) |
| `/api/konto/adgangskode`, `/api/konto/glemt` | `src/lib/adgangskodeSkift.ts` (`skiftAdgangskode`, `nulstilAdgangskode`) |
| `/api/konto/email`, `/api/konto/email/bekraeft` | `src/lib/emailSkift.ts` (`sendEmailSkiftKode`, `bekraeftEmailSkift`) |
| `/api/konto/data` | `src/lib/mineDataFil.ts` (`/konto/data`) |
| `/api/auktion/app/fjern-billeder` | `src/lib/auktionBilledOprydning.ts` (`redigerAuktion`) |

## Fælles regler

- `POST`, `Authorization: Bearer <session.access_token>` og `Content-Type: application/json` (undtagen
  `/api/konto/glemt`, der ikke kræver login, og `/api/konto/data`, der ikke har nogen krop).
- Tokenet valideres hos Supabase Auth (`getUser`). Brugeren findes altid ud fra tokenet, aldrig fra kroppen. RPC'erne
  kaldes **som brugeren** (`auth.uid()`), så RLS og databasens regler gælder som på hjemmesiden.
- Ingen cookies og ingen CORS-headere. Appen sender ingen `Origin`; en fremmed `Origin` afvises (403 `ikke_tilladt`).
- Svar: `200 { ok: true, ... }` eller `{ fejl, kode }`, hvor `fejl` er dansk og kan vises direkte.
- Proxyen (`src/lib/supabase/middleware.ts`) lukker stierne igennem uden cookie-login, så de selv svarer med JSON
  (401 `ikke_logget_ind`) i stedet for proxyens tekst "Log ind først".

| Status | `kode` | Betyder |
|---|---|---|
| 400 / 413 | `ugyldig` (og felt-koder herunder) | Forkert krop / for stor krop |
| 401 | `ikke_logget_ind` | Manglende eller udløbet token |
| 403 | `ikke_tilladt` | Fremmed `Origin` |
| 429 | `for_mange` | Rate limit |
| 500 | `fejl` | Noget gik galt (logget i /admin/drift) |

Grænser (`src/lib/rateLimit.ts`): `handel_app_ip` (600/time, før login), `handel_app_bruger` (60/10 min,
handlinger), `handel_app_laes_bruger` (300/10 min, `status` og `andenchance-status`), `bud_app_ip` (600/time) + hjemmesidens `bud_bruger` og `bud_ip`,
`konto_app_ip` (60/time) + hjemmesidens `adgangskode_bruger` / `nulstil_ip` / `nulstil_email`, `konto_data_app_ip`
(60/time), `auktion_app_ip` (300/time) og `auktion_app_bruger` (30/10 min).

## POST /api/handel/app/&lt;handling&gt;

Alle handlinger med `trade_id` slår handlen op først: **404 `ikke_fundet`**, hvis den ikke findes, og **403
`ikke_part`**, hvis kalderen hverken er køber eller sælger.

| Handling | Krop | Svar (200) |
|---|---|---|
| `status` | `{ trade_id }` | `{ annullering: { aarsag, refunderet } \| null, betaling: { sidsteFejl } \| null, fragt: { labelsAktiv, returlabelAktiv } }` |
| `send-pakke` | `{ trade_id, tracking, billeder: [{ sti, kategori: "aaben_kasse" \| "lukket_kasse" }] }` | `{ ok }` |
| `modtaget` | `{ trade_id }` | `{ ok }` |
| `godkend` | `{ trade_id, stjerner: 1-5, kommentar: string \| null }` | `{ ok }` |
| `afhentning-bekraeft` | `{ trade_id, kode: "123456" }` | `{ ok }` |
| `andenchance-status` | `{ trade_id }` | Samme felter som `hentAndenchanceStatus` (se nedenfor) |
| `andenchance-tilbud` | `{ trade_id }` | `{ tilbudId, budOere, udloeber }` |
| `andenchance-svar` | `{ tilbud_id, ja: boolean }` | `{ trade_id: string \| null }` |
| `genopsaet` | `{ trade_id, startpris, varighed_dage: 3 \| 5 \| 7 \| 10 }` | `{ auktion_id }` |

- **`status`** (køber og sælger): de oplysninger, handelssiden henter på serveren. Årsagen `'ubetalt'` /
  `'admin_annulleret'` gives til både køber og sælger. Til det er `erAnnulleretUbetalt` (hjemmesiden) ændret, så den
  slår op for køber ELLER sælger (`annulleretUbetaltAarsag` i `src/lib/handel/handelStatus.ts`); før kun køberen.
  Hjemmesiden kalder den stadig kun for køberen, så siden er uændret.
  - `annullering` er `null`, når handlen ikke er annulleret. `aarsag`: `'ubetalt'` (vinderen betalte ikke),
    `'admin_annulleret'` (BidHamr annullerede før betaling), `'afsendelsesfrist'` (ikke sendt inden 5 dage),
    `'afhentningsfrist'` (ikke hentet inden fristen), `'ikke_afhentet'` (pakken blev ikke hentet i pakkeshoppen og er
    sendt retur), `'sag'` (annulleret i en sag) eller `null` (anden årsag). `refunderet`: Stripe har gennemført
    refusionen.
  - `betaling` er kun sat, mens handlen afventer betaling. `sidsteFejl: true` = køberens seneste betalingsforsøg
    mislykkedes (vis "Betalingen kunne ikke gennemføres."). Altid `false` for sælgeren.
  - `fragt.labelsAktiv` (`FRAGT_LABELS_AKTIV`) og `fragt.returlabelAktiv` (`FRAGT_RETURLABEL_AKTIV`).
- **`send-pakke`** (sælgeren): billederne uploades først til `pakke-billeder` (`<sælger-id>/<handel-id>/<uuid>.jpg`,
  `upsert: false`). `{}` eller manglende `tracking`/`billeder` giver 400. Fejl fra `trade_marker_sendt` gives som
  `kode` (`allerede_sendt`, `annulleret`, `afhentning`, `billeder_kraeves`, `ugyldige_billeder`, `billede_mangler`,
  `for_mange_billeder`, `ugyldigt_tracking`, og `409 indsigelse`, når køberens bank har en åben eller tabt
  indsigelse - 20261102080000). Køberen får "Din pakke er på vej".
- **`modtaget`** (køberen): `409 ikke_klar` (ikke sendt), `409 allerede` (dobbelttryk). Sælgeren får "Pakken er
  kommet frem".
- **`godkend`** (køberen, uigenkaldeligt - vis en bekræftelse): `400 ugyldige_stjerner` / `kommentar_for_lang`
  (over 1.000 tegn), `409 ikke_klar` (kvittér først), `409 indsigelse` (bankens indsigelse), `409 ikke_mulig`
  (allerede godkendt). Afregning til sælgeren, "Tak for handlen" til køberen og udbetalingen starter med det samme.
- **`afhentning-bekraeft`** (sælgeren): samme tekster som hjemmesiden. `409 forkert` ("Du har N forsøg tilbage i
  denne time"), `409 laast_midlertidigt`, `409 laast`, `409 ikke_vist`, `400 ugyldig_kode`. Rigtig kode frigiver
  pengene (afregning + udbetaling).
- **`andenchance-status`** (sælgeren, 403 for køberen): `{ ubetalt, aarsag, nyHandelId, genopsatAuktionId,
  aktivtTilbud: { id, budOere, udloeber } | null, tilbud: [{ id, status, budOere, oprettet, udloeber, besvaretKl }],
  harFlereBydere, naesteBudOere, kanTilbyde, kanGenopsaette }` (+ `ok: true` som alle svar).
- **`andenchance-tilbud`** (sælgeren): `403 mitid` / `vilkaar` / `dac7` (krav mangler), `409 aktivt_tilbud`,
  `409 ikke_ubetalt`, `409 solgt`, `409 genopsat`, `409 ingen_flere_bydere`. Byderen får mailen.
- **`andenchance-svar`** (byderen; databasen tjekker, at kalderen er byderen): `{}` giver 400. `trade_id` er den nye
  handel ved "ja" (gå til checkout), `null` ved "nej". `404 ikke_fundet`, `409 besvaret` / `udloebet` / `solgt` /
  `genopsat` / `suspenderet`, `403 vilkaar`.
- **`genopsaet`** (sælgeren): serveren finder auktionen ud fra handlen - send ikke `auktion_id`. `400
  ugyldig_startpris` / `ugyldig_varighed`, `403 mitid` / `vilkaar` / `dac7`, `409 mangler_udbetalingskonto`,
  `409 allerede_genopsat` m.fl.

## POST /api/bud/app

```json
{ "auktion_id": "…", "beloeb_oere": 15000, "beskyttelse": true, "idempotens_noegle": "<uuid>" }
{ "auktion_id": "…", "maksimum_oere": 25000, "idempotens_noegle": "<uuid>" }
```

- Præcis ét af `beloeb_oere` (almindeligt bud) og `maksimum_oere` (automatisk bud). Øre, hele kroner (delelig med
  100) - ellers 400 `ugyldig`. `beskyttelse` er valgfri (BidHamr Beskyttelse; låst, mens man fører).
- Valgfrit `auktion_redigeret_kl` (auktionens `redigeret_kl`, som appen viste): afviser buddet, hvis sælgeren har
  ændret auktionen siden (`409 auktion_aendret`).
- Svar: `200 { ok: true, foerer: boolean, hoejeste_oere: number | null, forlaenget: boolean }`. `forlaenget` = buddet
  forlængede auktionen (anti-sniping); hent `slutter_kl` igen.
- Fejl: `409 { fejl, kode }`, hvor `kode` er databasens BH-kode, når den findes: `BHV01` (MitID), `BHV02`
  (brugerbetingelser), `BHK01` (kunst-kontrol), `BHE01` (firmakonto), `BHU03` (sælgeren er frosset), `BHU05`
  (sælgeren er spærret), `BHS02` (suspenderet), `BHB05` (over 500.000 kr.). Ellers `own_auction`, `samme_bud`,
  `minimum_bid`, `maks_for_lavt`, `maks_under_bud`, `maks_ugyldigt`, `beskyttelse_laast`, `auktion_aendret` eller
  `afvist` (fx "Auktionen er allerede slut"). `429 for_mange`.
- **Idempotens:** samme `idempotens_noegle` fra samme bruger giver det samme svar igen (dobbelttryk eller genforsøg
  efter et tabt svar afgiver ikke et nyt bud). Lav en ny nøgle pr. tryk på "Byd". Nøglen er bundet til auktion, type
  (bud eller maksimum) og beløb: samme nøgle med en anden auktion, type eller et andet beløb giver `409
  noegle_brugt`. Mens det første kald kører: `409 behandles`. Et afvist bud frigiver nøglen.
- Overbudte bydere og sælgeren får besked som ved bud på hjemmesiden.

## POST /api/konto/adgangskode

`{ nuvaerende, ny }` → `200 { ok }`. Samme krav som hjemmesiden (`vurderAdgangskode`: mindst 10 tegn, ikke
almindelig, ikke e-mail eller navn). Den nuværende adgangskode tjekkes, andre enheder logges ud (denne enhed beholder
sin session), og brugeren får en sikkerhedsmail. Fejl: `400 adgangskode` / `samme_adgangskode`, `403
forkert_adgangskode`, `403 genlog_ind` (log ud og ind igen), `429 for_mange`.

## POST /api/konto/email og /api/konto/email/bekraeft (skift af e-mail)

Samme kode som Indstillinger på hjemmesiden (`src/lib/emailSkift.ts`, migrationerne `20261102120000_skift_email.sql`
og `20261102160000_skift_email_rettelser.sql`).
Appen må **aldrig** kalde `supabase.auth.updateUser({ email })` - databasen afviser det altid (værn mod overtagelse
via en stjålet session).

1. `POST /api/konto/email` `{ ny_email, adgangskode }` → `200 { ok, besked }`. Svaret er **det samme**, uanset om
   adressen er ledig eller i brug (så sendes ingen kode), og det kommer tidligst efter ca. 1,5 sek. Mailen sendes i
   baggrunden. Vis `besked` og kode-skærmen. Fejl: `400 email` / `samme_email`, `403 forkert_adgangskode`,
   `403 staff` (medarbejdere skifter ikke selv - de kontakter chefen), `403 firma` (firmakonti skifter ikke selv -
   "Kontakt BidHamr for at skifte e-mail på en firmakonto"; appen viser teksten i stedet for knappen),
   `403 suspenderet` / `lukket` / `slettet`, `429 for_mange`, `503 ikke_tilgaengelig` (også mens et netop
   bekræftet skift gennemføres).
2. `POST /api/konto/email/bekraeft` `{ kode }` (6 cifre, mellemrum fjernes) → `200 { ok, email }`. E-mailen er
   skiftet, andre enheder er logget ud, og den gamle adresse har fået en mail. Kald
   `supabase.auth.refreshSession()`, så tokenet har den nye e-mail. Fejl: `400 kode_forkert` (prøv igen),
   `400 kode_udloebet` (brugt, udløbet efter 15 min. eller 5 forkerte - bed om en ny kode via trin 1),
   `409 optaget` (adressen blev taget, før koden blev brugt), `403 staff` / `firma` / `suspenderet` / `lukket` /
   `slettet`, `429 for_mange`. Ved skiftet holder alle gamle links og koder til den gamle adresse ("Glemt
   adgangskode", bekræftelse) op med at virke; sessionen og refresh-tokenet virker videre.

Grænser: `konto_app_ip`, `adgangskode_bruger` (deles med skift af adgangskode og sletning), `email_skift_bruger`
(5/time), `email_skift_ny_email` (3/time pr. ny adresse - tælles først efter en rigtig adgangskode) og
`email_skift_kode_bruger` (10/15 min).

## POST /api/konto/glemt

`{ email }` uden login → `200 { ok }` **altid** ved en gyldig e-mail, uanset om den findes. Mailen er den samme som
fra hjemmesiden; linket åbner hjemmesiden, hvor brugeren vælger en ny adgangskode. `400 email`, `429 for_mange`,
`503 ikke_tilgaengelig` (grænserne kunne ikke tjekkes).

## POST /api/konto/data?format=pdf

Bearer, ingen krop. `200 application/pdf` (uden `format`: `application/json`) med `Content-Disposition: attachment`.
Gem med `expo-file-system` og del/vis. `429 vent` = allerede hentet inden for den sidste time (grænsen deles med
hjemmesiden og `rpc("mine_data")`).

## POST /api/konto/henvisning (Henvis en ven)

Migration `20261102230000_henvis_en_ven.sql`. Samme kald som hjemmesidens `/konto/henvis` (`min_henvisning()`,
`auth.uid()`). Ingen krop. Grænse: `henvisning_app_ip` (300/time). Første kald laver brugerens kode.

- Firmakonto: `200 { ok: true, kan_henvise: false, grund: "erhverv" }` - vis "Henvis en ven er kun for private".
- Privat: `200 { ok: true, kan_henvise: true, kode, sti: "/?ven=KODE", url: "https://bidhamr.dk/?ven=KODE",
  kan_faa_point, grund: null | "spaerret", optjening_aaben (false = før lancering: ingen point endnu), point_pr_ven (10),
  maks_pr_maaned (10), maaned ("ÅÅÅÅ-MM"), belonnet_denne_maaned, tilbage_denne_maaned, antal_venner, antal_afventer,
  antal_belonnet, point_i_alt, venner: [{ navn, status, point, oprettet_kl, vurderet_kl }] }`.
- `navn` er vennens korte visningsnavn ("Kasper K."). `status`: `afventer` (venter på MitID), `belonnet`, `loft`,
  `firma`, `spaerret`, `foer_lancering`, `samme_person`, `tidligere_konto` (teksterne står i
  `src/lib/tekster/henvisning.ts`).
- Del-knappen: systemets delingsmenu (`Share.share`) med `url`. Kopiér: udklipsholderen.
- **Oprettelse:** åbner appen et link `https://bidhamr.dk/?ven=KODE` (Universal Link / App Link), gemmer appen
  koden og sender den som `henvisningskode` til `POST /api/konto/bekraeft` (docs/APP-SIGNUP.md). Kun en NY konto
  knyttes; svaret er det samme, uanset om koden blev brugt.
- Pointene gives af databasen, når vennen bliver MitID-verificeret (også via appens `/api/mitid/app/afslut`), og
  står i `mine_point().historik` med `type: "henvisning"` ("Henvist en ven").

## POST /api/auktion/app/fjern-billeder

`{ auktion_id, stier: string[] }` (højst 20; storage-stier `<bruger-id>/<fil>.jpg` eller de offentlige URL'er) →
`200 { ok }`. Kald den efter `rpc("rediger_auktion")`, når sælgeren har fjernet billeder. Kun ejeren (`403 ikke_ejer`,
`404 ikke_fundet`). Databasen (`auktion_billeder_sletbare`, kun service role) afgør i SQL for præcis de stier, hvad
der må slettes: kun filer i ejerens egen mappe, som ingen af ejerens auktioner bruger. Har ejeren en åben sag
(`app_bruger_har_aaben_sag`) - en DSA-anmeldelse, der ikke er afgjort (også når den er videresendt til admin), en
rapport (`pending`/`under_behandling`) eller en DSA-klage, der afventer, om ejeren eller **nogen** af ejerens
auktioner, eller en DSA-afgørelse, hvor klagefristen stadig løber - afvises hele kaldet med `409 sag_aaben`
("Billederne kan ikke slettes lige nu, fordi BidHamr behandler en sag om en af dine auktioner."), og intet slettes.
Svaret er `ok`, også når intet blev slettet. Samme regel gælder hjemmesidens oprydning efter en redigering.

**Sletning direkte i Storage** (`supabase.storage.from("auktion-billeder").remove(...)` med brugerens token) er låst
på samme måde: policyen `auktion_billeder_slet_ikke_laast` (`auktion_billede_laast`) afviser sletning af ethvert
billede i mappen, så længe ejeren har en åben sag (ud over billeder fra auktioner med bud eller handel, som før).
Svaret er da en tom sletning (intet slettet) - prøv ikke igen.

## GET og POST /api/firma/skift-pakke (firmaets pakkeskift)

Samme kode som Firma oversigt -> Abonnement (`src/lib/erhverv/pakkeskift.ts`, `velkomstSkiftForPakke` i
`src/lib/erhverv/betaling.ts`). Fuld kontrakt i toppen af `src/app/api/firma/skift-pakke/route.ts`.

Det viste beløb er det trukne (måned 1-reglen, rettelser 4, 27. okt. 2026):

1. Før bekræftelsen: `GET /api/firma/skift-pakke?til=<pakke-id>` (Bearer). Svaret er `velkomstSkift: false`
   (almindeligt skift - vis de almindelige tekster) eller `velkomstSkift: true` med `udfald` (`skift` / `venter` /
   `ret_rabat`), `beloeb` (`eksklOere`/`inklOere` - det, der trækkes i dag), `rabat` (slags, procent og `til` =
   rabattens slutdato som dansk dato), `visning`, `kanSkifte`, `tekst` (bekræftelsen) og `knap`. Ved
   `kanSkifte: false` (ret_rabat, eller pakken har ingen pris endnu) vises ingen knap - kun `tekst`.
   GET'en afgør "skift op" med databasens egen rang (`erhverv_pakke_rang`, og en arkiveret nuværende pakke er
   mindst) - præcis som POST'en, så `velkomstSkift: false` aldrig efterfølges af `409 visning_mangler`. En
   inaktiv eller arkiveret pakke giver `400 ugyldig_pakke` (som POST'en).
2. Ved tryk: `POST { pakkeId, visning }` med `visning` fra GET'en. Ved et skift op fra Starts gratis måned er
   `visning` krævet: uden den `409 visning_mangler`, før noget ændres. Send kun `visning`, når GET'en gav
   `velkomstSkift: true`: feltet tjekkes ved ALLE skift (også når det ikke bruges), så en ugyldig værdi altid
   giver `400 ugyldig_visning`, før noget ændres. Hjemmesiden gør det samme.
3. Afvist før noget er trukket (`409`): `pris_aendret` (hent GET igen og vis den nye pris), `rabat_venter`
   (introrabatten er sat op eller sættes op - hent GET igen), `ret_rabat` (BidHamr skal rette rabatten - vis
   `fejl`), `visning_mangler`. En sendt, men ugyldig `visning`: `400 ugyldig_visning`.

## BidHamr-bot: GET/POST /api/app/bot og POST /api/app/bot/medarbejder

Migration `20261102240000_bidhamr_bot.sql`. Samme kerne som hjemmesidens chatboble (`src/lib/bot/motor.ts`).
`Authorization: Bearer <token>` er **valgfri**: uden header er brugeren "ikke logget ind" (botten svarer på regler,
men slår ingen egne data op). Sendes en header, skal tokenet være gyldigt, ellers `401 ikke_logget_ind`.

- `GET /api/app/bot` → `200 { ok, tilgaengelig, maksTegn: 1000, loftPrDoegn: 30 }`. Vis kun botten, når
  `tilgaengelig` er `true` (falsk uden `ANTHROPIC_API_KEY`, og før lancering for alle uden adgang til den lukkede app).
- `POST /api/app/bot` `{ samtaleId?: uuid, besked: string }` (højst 1.000 tegn). Første besked uden `samtaleId`;
  gem det `samtaleId`, svaret giver, og send det med de næste gange. Svaret er en stream (`application/x-ndjson`), én
  JSON pr. linje:
  - `{ "type": "samtale", "samtaleId" }` altid først
  - `{ "type": "tekst", "tekst" }` tekststykker - sæt dem sammen i rækkefølge (ren tekst, ingen markdown/HTML)
  - `{ "type": "medarbejder" }` botten foreslår en medarbejder: fremhæv knappen
  - `{ "type": "fejl", "fejl" }` svaret blev afbrudt (vis teksten)
  - `{ "type": "slut" }` altid sidst
  Fejl før streamen: `{ fejl, kode }` - `400 tom|for_lang|ugyldig`, `404 ikke_tilgaengelig`, `409 ukendt_samtale|samtale_fuld`
  (start en ny samtale uden `samtaleId`), `429 loft_bruger|loft_ip|loft_alle|for_mange`, `500 fejl`.
  Historikken hentes fra serveren - appen sender kun den nye besked.
- `POST /api/app/bot/medarbejder` `{ samtaleId, email? }` (`email` kræves uden login) → `200 { ok, allerede }`.
  Vis knappen **"Kontakt en rigtig medarbejder"** efter brugerens første besked. Samtalen bliver en henvendelse i
  admin; medarbejderen svarer i Beskeder under "Fra BidHamr" (uden login: på mail). Dobbelttryk giver `allerede: true`.
  Fejl: `400 mangler_email|ugyldig_email|tom_samtale`, `404 ukendt_samtale|ikke_tilgaengelig`, `429 for_mange`.

UI-krav (som hjemmesiden): øverst "Du skriver med en AI – ikke et menneske." Under chatten: "Svarene er vejledende.
Det er BidHamrs regler og handelsbetingelser, der gælder."

## Ændret i eksisterende endpoints

- **DAO's handelsbetingelser (Filip, 20. okt. 2026):** `POST /api/fragt/app/book` tager nu
  `accepter_dao_betingelser?: boolean`. Første gang sælgeren laver en DAO-label (og når versionen af betingelserne
  ændres), svarer den `409 { fejl, kode: "dao_betingelser", betingelser: { url, version, tekst } }`. Vis en
  afkrydsning med `tekst` ("Jeg accepterer DAO's handelsbetingelser for forsendelsen") og et link til `url`
  (https://dao.as/handelsbetingelser/) – ingen advarselsboks – og send `book` igen med
  `accepter_dao_betingelser: true` (kun præcis `true` tæller). Appen kan på forhånd se, om sælgeren har accepteret:
  `supabase.from("fragt_betingelser_accept").select("version").eq("fragtfirma", "dao").eq("version", <version>)`
  (RLS: kun egne rækker) – men svaret fra `book` er det, der gælder. GLS og PostNord kræver ingen accept.
- **Fragtfirmaer (Filip, 20. okt. 2026): kun DAO og GLS.** `checkout.transportoerer` fra `/api/fragt/app/checkout`
  indeholder i dag kun `dao` og `gls` (PostNord er slået fra - `SHIPMONDO_POSTNORD_AKTIV=true` slår den til igen).
  `transportoer: "postnord"` giver `409 { fejl: "PostNord kan ikke vælges lige nu. Vælg DAO eller GLS.", kode: "afvist" }`
  fra `/api/fragt/app/pakkeshops` og `/levering` (`/api/betaling/app/betal` med levering: `kode: "levering"`); en gemt,
  ubetalt PostNord-levering giver ved `betal` `kode: "vaelg_levering"`. Pakkeshop-søgning med `indlevering: true`
  (retur) virker stadig for PostNord, og eksisterende PostNord-forsendelser (label, QR, sporing, retur) virker.
  GLS har `labelfri: false`: sælgeren skal printe PDF-labelen (`label`); der er ingen kode/QR på GLS-forsendelser.
- `POST /api/betaling/app/betal`: `levering.transportoer` (en af `checkout.transportoerer`) sendes videre (som
  `/api/fragt/app/levering`; udeladt = DAO). Svaret har desuden `saelgerNavn` (vis "Sælger: X" som hjemmesidens
  checkout; `null`, hvis navnet mangler).
- `POST /api/fragt/app/returfragt`: svaret har nu også `customerId` og `publishableKey` (som `betal`), så et gemt kort
  kan forudfyldes: `initPaymentSheet({ paymentIntentClientSecret, customerId: customerSessionClientSecret ? customerId
  : undefined, customerSessionClientSecret })`.
- `POST /api/betaling/app/boost-koeb` (boost-pakker, Filip 19. okt. 2026 – migration
  `20261026010000_boost_pakker.sql`): valgfrit `pakke` (pakkens id fra `mine_point().pakker`, fx `"point_300"`).
  Uden `pakke` købes 100-point-pakken som før, så den nuværende app virker uændret. Serveren vælger pris og point;
  svaret har desuden `pakke`. Nye fejl: `409 pakke_ukendt`, `409 behandles`, `400 ugyldig` (ikke en tekst-id). Se
  docs/APP-BETALING.md, "Boost".
- `mine_point()` og `min_auktion_boost({ p_auktion })` har nu `pakker: [{ id, point, pris_oere, boost, spar_oere,
  bedste }]`; `pakke` (100-point-pakken, nu også med `id`) er bevaret. `mine_point().historik[].beloeb_oere` = betalt
  beløb på køb.

## RPC'er (migration `20261025010000_app_endpoints.sql`)

Direkte fra appen med `supabase.rpc(...)`:

| RPC | Hvem | Svar |
|---|---|---|
| `auktion_budhistorik({ p_auktion })` | anon + indlogget | `[{ id, byder, beloeb, oprettet, automatisk, er_mig }]` |
| `mine_kunst_kontrol({ p_ids })` | indlogget | `[{ auction_id, kunst_kontrol }]` |
| `auktion_saelger_kan_saelge({ p_auktion })` | anon + indlogget | `boolean \| null` |
| `handel_chat_marker_laest({ p_trade })` | indlogget | `boolean` |
| `antal_ulaeste_handelsbeskeder()` | indlogget | `integer` |
| `min_auktion_boost({ p_auktion })` | indlogget (ejeren) | som før; `grund = 'kunst_kontrol'` når auktionen afventer kontrol |

- **`auktion_budhistorik`**: som auktionssiden. Højeste bud først, højst 50. `byder` er `"Byder 1"`, `"Byder 2"` ... i
  den rækkefølge, byderne først bød (blandt de viste bud) - og `"Dig"` for egne bud (`er_mig: true`). `beloeb` i hele
  kroner. `automatisk` = BidHamr bød automatisk (aldrig maksimum). Aldrig byder-id eller navn. Tom liste, hvis
  auktionen ikke kan ses (skjult, arkiveret eller afventer kunst-kontrol - undtagen for sælgeren, deltagere og staff).
- **`mine_kunst_kontrol`**: kun kalderens egne auktioner (højst 500 id'er). `kunst_kontrol`: `null`, `'afventer'`
  (vis "Afventer kontrol hos BidHamr" - auktionen er skjult for andre, og der kan ikke bydes), `'godkendt'` eller
  `'afvist'`.
- **`auktion_saelger_kan_saelge`**: svarer kun for en auktion, kalderen kan se (samme regel som auktionssiden/RLS),
  ellers `null`. `false` = auktionens sælger er frosset, og der kan ikke bydes (`BHU03`). Vis
  "Der kan ikke bydes lige nu. Sælgeren skal have godkendt sin udbetalingskonto hos Stripe, før der kan bydes på
  sælgerens auktioner igen." (`BUD_SAELGER_FROSSET_*` i `src/lib/betaling/frosset.ts`) i stedet for budknappen. Kun
  ja/nej. (Den første udgave, `saelger_kan_saelge(p_saelger)`, svarede for en vilkårlig bruger og er fjernet.) En spærret sælger (`BHU05`) vises ikke her (heller ikke på hjemmesiden) - buddet afvises med `BHU05`.
- **Handelschat læst-status**: kald `handel_chat_marker_laest` når handelschatten vises (og når en ny besked kommer
  ind, mens den er åben). `antal_ulaeste_handelsbeskeder` tæller beskeder fra modparten og fra BidHamr i dine
  handler efter din sidste læsning; spamblokerede beskeder tæller ikke. Rækkerne kan læses med
  `from("handel_chat_laest").select("trade_id, laest_kl")` (kun egne) - fx til en prik pr. handel ved at sammenligne
  med den nyeste besked. Ved migrationen blev alle eksisterende handler markeret som læst.

## Anbefaling: direkte bud fra appen

I dag kan appen stadig byde direkte (`from("bids").insert(...)` og `rpc("saet_maksimum")` som `authenticated`). Det
er lige så sikkert som før (RLS og alle bud-triggere gælder), men uden serverens rate limit pr. bruger og IP og uden
at de overbudte får besked med det samme (cron'en samler op). Anbefaling, når appen bruger `POST /api/bud/app`:

1. Ny app-version med `/api/bud/app` ude i butikkerne, og de gamle versioner tvunget opdateret.
2. En migration, der lukker direkte bud: `revoke insert on public.bids from authenticated` (og fjerner
   `bids_insert_own`), og `revoke execute on function public.saet_maksimum(...) from authenticated`. Hjemmesidens
   server actions skal så indsætte via en security definer-RPC, der udleder byderen af `auth.uid()` (eller
   service role med eksplicit bruger) - ellers holder hjemmesidens bud også op med at virke. Det er ikke gjort nu,
   fordi det bryder den nuværende app.
