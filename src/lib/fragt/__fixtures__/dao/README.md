# DAO-fixtures

Egne eksempelsvar, skrevet ud fra beskrivelsen i DAO's dokumentation
(https://api.dao.as/docs/v1/, version 132) - **ikke** rigtige svar og ikke kopieret ordret. Der er ingen
nøgler og intet testmiljø endnu (docs/DAO-API.md).

Bruges af `tests/fragt/` (`npm run test:fragt`). Når Filip har nøglerne, skal de første rigtige svar
(anonymiserede: ingen navne, adresser, telefonnumre eller e-mails) lægges her ved siden af, fx
`rigtig_findpakkeshop.json`, `rigtig_tracktracekoder.json`, og testene udvides med dem.

| Fil | Endpoint | Hvad |
|---|---|---|
| `c2c_ok.json` | `/DAOPakkeshop/c2cindleveringsordre.php` | Shop2Shop oprettet med labelfri kode |
| `shop2home_ok.json` | `/DAODirekte/ShoptildirekteLeveringsordre.php` | Shop2Home oprettet |
| `ordre_fejl.json` | ordre-endpoints | HTTP 200 med `status: FEJL` (fejlkode 1) |
| `ordre_ok_uden_stregkode.json` | ordre-endpoints | `OK`, men ingen stregkode (ukendt udfald) |
| `findpakkeshop_ok.json` | `/DAOPakkeshop/FindPakkeshop.php` | tre shops, tal som tekst, åbningstider |
| `findpakkeshop_error.json` | `/DAOPakkeshop/FindPakkeshop.php` | `status: ERROR` (FindPakkeshop bruger ERROR) |
| `paene_anfoerselstegn.txt` | - | svar med ”pæne” anførselstegn som i dokumentationens eksempler |
| `tracktrace_stregkode.json` | `/TrackNTrace_v2.php?stregkode=` | to kendte og én ukendt hændelse |
| `tracktrace_token_1.json` | `/TrackNTrace_v2.php?token=0` | første feed-svar: to pakker, nyt token |
| `tracktrace_token_2.json` | `/TrackNTrace_v2.php?token=…` | ingen nye hændelser, nyt token |
| `tracktrace_uden_token.json` | `/TrackNTrace_v2.php?token=…` | `OK` uden token (må aldrig gemmes) |
| `annuller_ok.json` / `annuller_fejl.json` | `/AnnullerePakke.php` | annulleret / kan ikke annulleres |
| `createclaim_ok.json` | `/createclaim.php` | efterlysning oprettet |
