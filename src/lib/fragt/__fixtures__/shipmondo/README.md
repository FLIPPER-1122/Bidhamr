# Shipmondo-fixtures

Bruges af `tests/fragt/shipmondo.test.ts` (`npm run test:fragt`).

**Rigtige svar fra Shipmondos sandbox (15. okt. 2026)** - testforsendelser med sandboxens testnavne og
-adresser (ingen rigtige personer). Alle testforsendelser blev annulleret bagefter; de to DAO-forsendelser
kunne ikke annulleres (DAO svarer 422), men sandboxen opretter intet hos DAO. Label-PDF'erne er erstattet af
en lille falsk PDF, og `reference` er sat til `REFERENCE` (testen sætter sin egen).

| Fil | Endpoint | Hvad |
|---|---|---|
| `opret_dao_pakkeshop.json` | `POST /shipments` | DAO_STS (daoSHOP) med `labelless_code` |
| `opret_dao_doer.json` | `POST /shipments` | DAO_STH (daoHOME) med `labelless_code` |
| `opret_gls_pakkeshop.json` | `POST /shipments` | GLSDK_SD (ShopDelivery) - ingen labelfri |
| `opret_gls_doer.json` | `POST /shipments` | GLSDK_HD (PrivateDelivery) - ingen labelfri |
| `opret_postnord_pakkeshop.json` | `POST /shipments` | PDK_MC (Service Point) + QR_CODE |
| `opret_postnord_doer.json` | `POST /shipments` | PDK_MH (Home) + QR_CODE |
| `opret_gls_retur.json` | `POST /shipments` | GLSDK_SR (ShopReturn) + QR_CODE, køber -> sælgers adresse |
| `opret_gls_retur_reserve.json` | `POST /shipments` | GLSDK_SD med automatisk valgt pakkeshop nær sælgeren |
| `opret_postnord_retur.json` | `POST /shipments` | PDK_MC + QR_CODE med automatisk valgt pakkeshop |
| `qr_postnord.json` / `qr_gls_retur.json` | `GET /shipments/{id}/qr_code?file_format=png` | `{ qr_codes: [PNG base64] }` |
| `qr_ingen.json` | samme | 404 "No QR Code found for the shipment" (DAO/GLS SD/HD) |
| `qr_code_ugyldig_service.json` | `POST /shipments` | 422 "Service code QR_CODE is invalid" (GLS SD med QR_CODE) |
| `annuller_ok_ikke_hos_transportoer.json` | `PUT /shipments/{id}/cancel` | GLS/PostNord i sandboxen |
| `annuller_dao_422.json` | samme | DAO: 422 "It's not possible to cancel this shipment." |
| `annuller_ok_bekraeftet.json` | samme | **egen** variant med `cancelled_at_carrier: true` |
| `service_points_*.json` | `GET /service_point/service_points` | 3 shops pr. transportør (Odense C) |

**Egne eksempler** (sandboxen sender ingen webhooks): `monitor_*.json` er Shipment Monitor-payloads skrevet
efter eksemplet på shipmondo.dev ("Webhooks → Resources and actions"). De dekrypterede felter er de samme
for alle transportører; statusserne er Shipmondos fælles: `INFORMED`, `EN_ROUTE`, `AVAILABLE_FOR_DELIVERY`,
`DELIVERED`, `PICKUP_REQUESTED`, `GENERAL`, og states `NEUTRAL`, `PROGRESSING`, `WARNING`, `DANGER`,
`SUCCESS`. Når de første rigtige webhooks er modtaget i produktion, bør de (anonymiseret) lægges her.
