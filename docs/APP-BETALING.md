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
| `boost-koeb` | `{ samtykke? }` | `{ koebId, clientSecret, beloebOere, point, customerId, customerSessionClientSecret, publishableKey }` – køb af boost-point (se nedenfor) |
| `boost-brug` | `{ auktion_id, noegle }` | `{ kode: 'ok' \| 'allerede', boostId, slutKl, saldo }` – booster egen auktion |

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
- Højst ét gemt kort vises: `mobile_payment_element` har ingen `payment_method_redisplay_limit` (kun webbens
  Payment Element har), så serveren sætter alle andre kort på kunden til `allow_redisplay: 'limited'`, før
  kundesessionen laves. Kan det ikke sikres, er `customerSessionClientSecret` `null`.
- 3D Secure er tvunget (`request_three_d_secure: "any"`). PaymentSheet viser selv bankens vindue.
- Betalingen er først gennemført, når webhooken har registreret den. Hent handlen igen (`betaling_modtaget`).

## Gem kort

`gem-kort` → `initPaymentSheet({ setupIntentClientSecret, customerId, customerSessionClientSecret, … })` →
`presentPaymentSheet()` → `bekraeft-kort { setup_intent_id }` (id = `clientSecret` før `_secret_`). Kortet gemmes
`on_session`, kun kort (Apple Pay/Google Pay gemmes som kort).

## Boost (køb af point og boost)

Regler (Filip, 13. okt. 2026): 100 point for 39 kr. (BidHamrs egen omsætning med moms, faktura). Et boost koster 50
point og lægger opslaget øverst i 24 timer. 10 point pr. gennemført salg (når pengene er frigivet). Kun private –
firmaer får `403 erhverv`. Tallene står i databasen (`boost_indstillinger`) – vis dem fra `mine_point`, ikke hårdkodet.

- **Køb:** `boost-koeb` → `initPaymentSheet({ paymentIntentClientSecret: s.clientSecret, customerId/customerSessionClientSecret som i betal, … })`
  → `presentPaymentSheet()`. Samme PaymentIntent ved gentagne kald, til den er betalt. Betalingen går til BidHamrs
  platformskonto (ingen destination charge), 3D Secure er tvunget. **Pointene kommer først, når webhooken har
  registreret betalingen** – hent `mine_point` igen (evt. et par gange med kort pause). `samtykke` bruges kun, hvis
  `mine_point().kraev_samtykke` er `true` (fortrydelsesret – afventer advokaten; i dag `false`).
- **Boost:** `boost-brug { auktion_id, noegle }`. `noegle` er en uuid, som appen laver én gang pr. skærm: samme
  nøgle giver samme boost (dobbelttryk/genforsøg trækker ikke point to gange). Fejl: `409 boostet` (har allerede et
  aktivt boost, `slutKl`), `409 for_faa_point` (`saldo`, `pris` – vis "Køb 100 point – 39 kr."), `409 ikke_aktiv` /
  `slutter_snart` (under 1 time tilbage), `403 ikke_ejer` / `erhverv` / `spaerret`.
- **Læsning direkte fra Supabase** (ingen endpoint nødvendig):
  - `supabase.rpc("mine_point")` → `{ saldo, kan_bruge, spaerret, pakke: { point, pris_oere }, boost: { point, timer },
    point_pr_salg, kraev_samtykke, aabent_koeb, historik: [{ id, type: 'koeb' | 'optjening' | 'forbrug' |
    'tilbagefoersel' | 'staff', point, oensket_point, saldo_efter, kl, auktion_id, auktion_titel }] }`.
  - `supabase.rpc("min_auktion_boost", { p_auktion })` → for ejeren `{ boostet, slut_kl, kan_booste, grund, saldo,
    pris, timer, pakke }`, ellers `null`. Vis knappen "Boost i 24 timer (50 point)", når `kan_booste` er true.
  - `supabase.rpc("aktive_boosts", { p_auktioner: [id, …] })` → `[{ auktion_id, slut_kl }]` – vis mærket **"Boostet"**
    på kort og auktionsside (markedsføringsloven). Også uden login.
  - `supabase.rpc("boost_top", { p_kategori, p_soeg })` → højst 4 boostede auktioner (roteret hvert 10. minut,
    sorteret efter boost-start), der skal stå øverst på forsiden (begge `null`), i en kategori eller i en søgning
    (titlen indeholder teksten). Hent kortene med de id'er, og vis dem før den almindelige liste.
- Tekster: `src/lib/boost/tekster.ts`.

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
| 403 | `erhverv` / `spaerret` / `ikke_ejer` | Boost: firmakonto, spærret konto, eller ikke din auktion |
| 409 | `boostet` / `for_faa_point` / `ikke_aktiv` / `slutter_snart` / `samtykke` | Boost (se ovenfor) |
| 404 | `ugyldig` / `ikke_fundet` | Ukendt handling / handlen findes ikke (eller er ikke din) |
| 409 | `betalt` | Allerede betalt eller under behandling – hent handlen igen |
| 409 | `vaelg_levering` | Vælg levering først |
| 409 | `levering` | Leveringsvalget blev afvist (fx "Vælg en pakkeshop.") |
| 409 | `venter` | Venter på sælgerens Stripe-konto |
| 409 | `afvist` | Fx fristen er overskredet, kortet blev ikke gemt, udbetalingskontoen er lukket |
| 429 | `for_mange` | Rate limit (`betaling_app_ip`, `betaling_app_bruger`, `fragt_handling_bruger`) |
| 503 | `pause` | Nødstop: nye betalinger er midlertidigt sat på pause |
| 500 | `fejl` | Noget gik galt (logget i /admin/drift) – også hvis serverens offentlige Stripe-nøgle mangler (`betal`, `gem-kort`, `boost-koeb`) |

Testkort: `4242 4242 4242 4242`, `4000 0027 6000 3184` (3D Secure), `4000 0000 0000 9995` (afvist).

## Mangler stadig (handelstrin, ikke bygget)

Disse går i dag direkte til RPC'en fra appen, og så sendes beskeden eller udbetalingen ikke med det samme:
- `send-pakke` (`trade_marker_sendt`): køberen får ikke "Din pakke er på vej".
- `modtaget` (`trade_marker_modtaget`): sælgeren får ikke "Pakken er kommet frem".
- `godkend` (`handel_godkend_med_bedoemmelse`): afregningsbeskederne sendes ikke, og udbetalingen starter først, når cron kører.
- `andenchance-tilbud`, `andenchance-svar`, `genopsaet`: kan kun kaldes af serveren. Brug en webvisning af
  `SITE/andenchance/<id>` indtil videre.
- `sag-opret` og `anke`: virker direkte fra appen. Cron sender beskederne (`sager.notificeret_kl`).
