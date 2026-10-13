# Betaling fra appen

`POST SITE/api/betaling/app/<handling>` med `Authorization: Bearer <session.access_token>` og
`Content-Type: application/json`. Samme kode som hjemmesidens server actions
(`src/lib/betaling/betalingHandlinger.ts`). Fejl: `{ fejl, kode }`, hvor `fejl` er dansk og kan vises direkte.
Kun Stripes testmiljø indtil fase 6.

## Handlinger

| Handling | Krop | Svar (200) |
|---|---|---|
| `betal` | `{ trade_id, levering? }` | `{ clientSecret, totalOere, customerId, customerSessionClientSecret, publishableKey, levering? }` |
| `indstillinger` | `{}` | `{ gemtKort: { maerke, sidste4, udloeb } \| null, saelger: { harKonto, detaljerIndsendt, overfoerslerAktiv, udbetalingerAktiv, manglerOplysninger, afvist, frakoblet, frosset, venterPaaBank } }` |
| `gem-kort` | `{}` | `{ clientSecret (seti_…), customerId, customerSessionClientSecret, publishableKey }` |
| `bekraeft-kort` | `{ setup_intent_id }` | `{ gemtKort }` |
| `fjern-kort` | `{}` | `{ ok }` |
| `udbetalingskonto` | `{}` | `{ url }` – Stripes onboarding-link (engangs, kun til brugeren selv) |
| `udbetalingskonto-status` | `{}` | `{ saelger }` – hentet frisk fra Stripe |
| `stripe-oversigt` | `{}` | `{ url }` – engangs-link til Stripes Express Dashboard |

`levering` i `betal` er valgfri og har samme felter som `/api/fragt/app/levering`
(`maade`, `pakkeshop_id`, `pakkeshop_postnummer`, `pakkeshop_adresse`, `modtager`, `gem_forslag`). Send den kun, når
køberen har ændret valget. Ændrer valget beløbet, annulleres den gamle PaymentIntent, og der laves en ny. Uden
`levering` genbruges den samme PaymentIntent.

## Checkout (PaymentSheet)

```ts
const s = await post("betal", { trade_id });            // evt. med levering
await initPaymentSheet({
  merchantDisplayName: "BidHamr",
  paymentIntentClientSecret: s.clientSecret,
  customerId: s.customerSessionClientSecret ? s.customerId : undefined,
  customerSessionClientSecret: s.customerSessionClientSecret ?? undefined,
  returnURL: "bidhamr://stripe-redirect",
  applePay: { merchantCountryCode: "DK" },
  googlePay: { merchantCountryCode: "DK", testEnv: true },
});
await presentPaymentSheet();
```

- `StripeProvider publishableKey` = `s.publishableKey` (`pk_test_…`).
- **Ingen ephemeral key.** Med en ephemeral key viser PaymentSheet alle kundens kort, kan fjerne dem og tilbyde "gem
  kort" (gemmes til brug uden køberen). Det strider mod reglen om, at et gemt kort kun forudfylder. Kundesessionen
  (`mobile_payment_element`) viser kun det gemte kort og slår "gem" og "fjern" fra. Kræver
  `@stripe/stripe-react-native` 0.56 eller nyere (0.39–0.55: parameteren er markeret eksperimentel).
- `customerSessionClientSecret` er `null` uden gemt kort. Udelad så `customerId`.
- 3D Secure er tvunget (`request_three_d_secure: "any"`). PaymentSheet viser selv bankens vindue.
- Betalingen er først gennemført, når webhooken har registreret den. Hent handlen igen (`betaling_modtaget`).

## Gem kort

`gem-kort` → `initPaymentSheet({ setupIntentClientSecret, customerId, customerSessionClientSecret, … })` →
`presentPaymentSheet()` → `bekraeft-kort { setup_intent_id }` (id = `clientSecret` før `_secret_`). Kortet gemmes
`on_session`, kun kort (Apple Pay/Google Pay gemmes som kort).

## Udbetalingskonto

`udbetalingskonto` → `WebBrowser.openAuthSessionAsync(url, "bidhamr://udbetalingskonto")`. Stripe sender til
`SITE/api/betaling/app/retur`, som sender videre (303) til:
- `bidhamr://udbetalingskonto?status=retur` → kald `udbetalingskonto-status` og vis status.
- `bidhamr://udbetalingskonto?status=udloebet` → linket er udløbet eller brugt: kald `udbetalingskonto` igen.

Valget: Stripe kræver https i live-tilstand, så et `bidhamr://`-link kan ikke gives direkte til Stripe. Retur-siden
giver ingen data og laver aldrig et nyt link uden login.

## Fejlkoder

| Status | `kode` | Betyder |
|---|---|---|
| 400 / 413 | `ugyldig` | Forkert krop / over 4 KB |
| 401 | `ikke_logget_ind` | Manglende eller udløbet token |
| 403 | `ikke_tilladt` | Fremmed `Origin` |
| 404 | `ugyldig` / `ikke_fundet` | Ukendt handling / handlen findes ikke (eller er ikke din) |
| 409 | `betalt` | Allerede betalt eller under behandling – hent handlen igen |
| 409 | `vaelg_levering` | Vælg levering først |
| 409 | `levering` | Leveringsvalget blev afvist (fx "Vælg en pakkeshop.") |
| 409 | `venter` | Venter på sælgerens Stripe-konto |
| 409 | `afvist` | Fx fristen er overskredet, kortet blev ikke gemt, udbetalingskontoen er lukket |
| 429 | `for_mange` | Rate limit (`betaling_app_ip`, `betaling_app_bruger`, `fragt_handling_bruger`) |
| 503 | `pause` | Nødstop: nye betalinger er midlertidigt sat på pause |
| 500 | `fejl` | Noget gik galt (logget i /admin/drift) |

Testkort: `4242 4242 4242 4242`, `4000 0027 6000 3184` (3D Secure), `4000 0000 0000 9995` (afvist).

## Mangler stadig (handelstrin, ikke bygget)

Disse går i dag direkte til RPC'en fra appen, og så sendes beskeden eller udbetalingen ikke med det samme:
- `send-pakke` (`trade_marker_sendt`): køberen får ikke "Din pakke er på vej".
- `modtaget` (`trade_marker_modtaget`): sælgeren får ikke "Pakken er kommet frem".
- `godkend` (`handel_godkend_med_bedoemmelse`): afregningsbeskederne sendes ikke, og udbetalingen starter først, når cron kører.
- `andenchance-tilbud`, `andenchance-svar`, `genopsaet`: kan kun kaldes af serveren. Brug en webvisning af
  `SITE/andenchance/<id>` indtil videre.
- `sag-opret` og `anke`: virker direkte fra appen. Cron sender beskederne (`sager.notificeret_kl`).
