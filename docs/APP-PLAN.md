# BidHamr-appen – plan fra torsdag den 15. oktober 2026

Til Filip. Planen samler alt, hjemmesiden allerede har bygget til appen, ét sted, så du kan gå i gang på MacBook'en.
Appens kode ligger ikke i dette repo, så alt om den nuværende app er gætværk, indtil koden er flyttet til GitHub (trin 1).

Kilder: `ROADMAP.md` (fase 5), `ROADMAP-BESLUTNINGER.md`, `DESIGN.md`, `docs/APP-SIGNUP.md`, `docs/MITID.md`,
`docs/FRAGT.md`, `docs/DAO-API.md`, `docs/FAKTURA.md`, `docs/DAC7.md`, `docs/BETALINGSMODEL-PLAN.md` og koden i `src/`.

---

## 0. Det vigtigste først (læs dette, hvis du kun læser én ting)

1. **Den nuværende app virker sandsynligvis ikke mod produktionsdatabasen længere.** Alle migrationer, som appen
   skulle tilpasses til, er kørt i produktion (tjekket 13. okt. 2026: blandt andet `fjern_wallet`, `sikkerhed_app_afhaengig`,
   `niels_m03_vinder_id_app_afhaengig`, `mitid`, `fragt_dao_shipmondo`, `vilkaar_efternavn_chat`, `signup_billet_altid`
   og `returfragt_betaling`). Wallet findes ikke mere, `select('*')` på `auctions` og `trades` giver "permission denied",
   og `supabase.auth.signUp` bliver afvist. Derfor er planen at rette appen trin for trin og ikke at lappe den.
2. **Byg mod testdatabasen og en lokal hjemmeside, aldrig mod bidhamr.dk.** bidhamr.dk bruger produktionsdatabasen.
   Appens kald til `/api/...` skal gå til en hjemmeside, der kører på **samme** database som appen. Ellers afviser
   serveren appens login (401). Se afsnit 5, trin 0.
3. **Appen må aldrig selv flytte penge.** Alle betalinger går gennem hjemmesidens server og Stripe. Appen viser kun
   Stripes betalingsvindue (PaymentSheet). Der er ingen saldo, ingen wallet og ingen automatisk betaling.
4. **Hjemmesiden mangler stadig et par endpoints til appen**, før betaling og nogle handelstrin kan virke. Det største
   hul er selve checkout-betalingen. Se afsnit 6 – Claude kan bygge dem, mens du laver de første trin.
5. **Brug en "development build" fra starten, ikke kun Expo Go.** MitID (deep link `bidhamr://`), push-notifikationer,
   Apple Pay og Google Pay virker ikke rigtigt i Expo Go.

---

## 1. Kort overblik

BidHamr er én platform med to indgange: appen (det primære produkt) og hjemmesiden. Begge bruger **samme
Supabase-database, samme regler og samme Stripe-konto**. Reglerne ligger i databasen (triggere, RLS og RPC'er), så de
gælder automatisk for appen – appen kan ikke snyde sig uden om dem, og den skal ikke selv gentage dem.

- **Stripe holder pengene.** Vinderen betaler selv inden for 48 timer (sælgeren kan forlænge til højst 7 dage) med
  kort, MobilePay, Apple Pay eller Google Pay. Pengene står på sælgerens Stripe Connect-konto og udbetales først, når
  handlen er helt færdig.
- **Ingen saldo, ingen wallet, ingen automatisk betaling.** Et gemt kort bruges kun til at forudfylde checkout.
- **Gebyrer:** 5 % for køber og 5 % for sælger. **BidHamr Beskyttelse** er et tilkøb for køberen (5 %, mindst 25 kr. og
  højst 250 kr.), som vælges ved buddet og låses. Ordet "forsikring" bruges aldrig.
- **Tekster:** Al tekst er på dansk. BidHamr "modtager" eller "holder" aldrig pengene i teksterne – betalingen håndteres
  af vores betalingspartner Stripe.

```
                 ┌──────────────────────┐        ┌──────────────────────┐
                 │   Appen (Expo)       │        │  Hjemmesiden         │
                 │   iPhone / Android   │        │  bidhamr.dk (Next.js)│
                 └───┬───────────┬──────┘        └─────┬──────────┬─────┘
       læs/skriv     │           │ POST /api/...       │          │
       med login     │           │ (Bearer-token)      │          │
                     ▼           ▼                     ▼          │
            ┌────────────────┐  ┌──────────────────────────────┐  │
            │   Supabase     │◄─┤  Hjemmesidens server         │◄─┘
            │   (database,   │  │  - opret konto, MitID        │
            │   regler, RLS, │  │  - Stripe: betaling, kort,   │
            │   login,       │  │    udbetaling, refusion      │
            │   billeder)    │  │  - fragt (DAO), labels       │
            └────────────────┘  │  - mails og push (Expo)      │
                                └───────┬───────────┬──────────┘
                                        ▼           ▼
                                   ┌────────┐  ┌──────────┐  ┌───────┐
                                   │ Stripe │  │ DAO      │  │ Idura │
                                   │(penge) │  │ (fragt)  │  │(MitID)│
                                   └────────┘  └──────────┘  └───────┘
```

Tommelfingerregel for appen:
- **Læse data og simple handlinger** (bud, favoritter, beskeder, spørgsmål): direkte til Supabase med brugerens login.
- **Alt med penge, fragt, MitID, oprettelse og sletning af konto:** et kald til hjemmesidens server
  (`POST https://<hjemmeside>/api/...` med `Authorization: Bearer <access token>`). Appen har aldrig hemmelige nøgler.

---

## 2. Programmer og konti

| Ting | Hvad det er til | Pris |
|---|---|---|
| **macOS + Xcode** | Bygger og kører iPhone-appen, iPhone-simulatoren. Hentes i App Store. Kræver en nyere macOS-version. | Gratis (tjek, at din macOS kan køre den aktuelle Xcode) |
| **Xcode Command Line Tools** | Værktøjer, som Node og Expo bruger. | Gratis |
| **Android Studio** | Android-emulatoren, så du kan teste Android uden telefon. | Gratis |
| **Expo Go** (app på telefonen) | Hurtig test af skærme. Kan ikke MitID-deep link, push, Apple/Google Pay. Brug den kun i starten. | Gratis |
| **Development build** (`expo-dev-client`) | Din egen testversion af appen med alle funktioner. Den skal du bruge. | Gratis lokalt, eller via EAS |
| **Node.js (LTS)** | Kører Expo og hjemmesiden. Brug den aktuelle LTS-version. | Gratis (tjek aktuel LTS-version) |
| **Git + GitHub** | Gemmer koden, så den kan flyttes fra MacBook til den stationære og ses af Claude. Brug et **privat** repo. | Gratis |
| **VS Code eller Cursor** | Editor til koden. | VS Code gratis. Cursor: tjek aktuel pris |
| **Expo-konto + EAS** | EAS Build laver de rigtige app-filer til App Store og Google Play. EAS Submit sender dem ind. EAS Update sender små rettelser. | Gratis plan findes. Betalte planer: tjek aktuel pris |
| **Apple Developer Program** | Kræves for TestFlight og App Store, push på iPhone og Apple Pay. Tilmeld dig som virksomhed (CVR 46836219) – kræver et D-U-N-S-nummer. | 99 USD pr. år |
| **Google Play Console** | Kræves for at udgive på Android. Tilmeld dig som organisation. | 25 USD én gang |
| **Stripe React Native SDK** (`@stripe/stripe-react-native`) | Stripes betalingsvindue (PaymentSheet) i appen: kort, MobilePay, Apple Pay, Google Pay, 3D Secure. | Gratis (Stripe tager gebyr pr. betaling som i dag) |
| **Supabase JS** (`@supabase/supabase-js`) | Login, læsning og skrivning i databasen, billeder, live-opdateringer. | Gratis (BidHamr har allerede Supabase) |
| **Idura / MitID** | Ingen pakke i appen. Appen åbner hjemmesidens MitID-side i en in-app browser (`expo-web-browser`). Idura-aftalen ligger på hjemmesiden. | Ingen ekstra udgift for appen |
| **Expo Notifications** (`expo-notifications`) | Push-beskeder. Hjemmesidens server sender dem allerede via Expos push-tjeneste. På iPhone kræver det Apple Developer-kontoen, på Android en Firebase-opsætning (FCM). | Gratis |

Andre Expo-pakker, du får brug for: `expo-web-browser` og `expo-crypto` (MitID), `expo-linking` (deep links),
`expo-image-picker` og `expo-camera` (billeder – pakkebilleder skal tages med kameraet), `expo-image-manipulator`
(gør billeder mindre og laver HEIC om til JPEG), `expo-secure-store` (gemmer login sikkert), `expo-local-authentication`
(Face ID-login), `expo-location` (afstand i søgning), `react-native-maps` (pakkeshops på et kort),
`expo-file-system` + `expo-sharing` (PDF'er: labels og fakturaer) og `react-native-svg` + Tabler-ikonerne.

### Tjekliste: installation på MacBook'en

- [ ] Opdatér macOS (Indstillinger → Generelt → Softwareopdatering).
- [ ] Installér **Xcode** fra App Store, åbn det én gang, og accepter licensen. Installér en iOS-simulator under
      Xcode → Settings → Platforms.
- [ ] Kør i Terminal: `xcode-select --install`
- [ ] Installér **Homebrew** (følg vejledningen på brew.sh).
- [ ] `brew install node git watchman` – tjek bagefter med `node -v` og `git --version`.
- [ ] `brew install cocoapods` (bruges af iPhone-byggeriet).
- [ ] Installér **Android Studio** og opret en emulator (Device Manager → en nyere Pixel).
- [ ] Installér **VS Code** eller **Cursor**.
- [ ] Opret en **GitHub**-konto (eller brug din), og log ind på Mac'en: `brew install gh` og derefter `gh auth login`.
- [ ] Opret en **Expo-konto** på expo.dev, og kør `npx eas-cli login` (eller installér `eas-cli` globalt).
- [ ] Tilmeld **Apple Developer Program** som virksomhed (start nu – D-U-N-S og godkendelse kan tage flere dage).
- [ ] Tilmeld **Google Play Console** som organisation (kontrollen af identitet kan også tage tid).
- [ ] Installér **Expo Go** på din iPhone (kun til de første skærmtest).
- [ ] Klon også **hjemmesiden** (dette repo) på Mac'en, så du kan køre den lokalt mod testdatabasen (se trin 0).

---

## 3. Skærme og navigation

Fem faner i bunden. Klokken (notifikationer) og evt. søgefeltet står i toppen af Hjem.

```
┌─────────┬─────────┬─────────┬──────────┬──────────┐
│  Hjem   │   Søg   │  Sælg   │ Beskeder │ Min konto│
└─────────┴─────────┴─────────┴──────────┴──────────┘
```

### Alle skærme

**Uden for fanerne (før login og fælles)**
- Velkommen / log ind (`/login`) – e-mail + adgangskode, "Glemt adgangskode", Face ID efter første login.
- Opret konto (`/signup`) – fornavn, efternavn, e-mail, adgangskode, flueben for brugerbetingelserne.
- Indtast koden (`/tjek-indbakke`) – kodefelt + "Send ny kode".
- Glemt / nulstil adgangskode (`/glemt-adgangskode`, `/nulstil-adgangskode`).
- Velkommen efter oprettelse (`/velkommen`).
- Accept-vindue for brugerbetingelser (vises, når `mine_vilkaar` siger, at en ny version mangler).
- MitID (in-app browser + resultat).
- Faste sider: Brugerbetingelser, Privatlivspolitik, BidHamr Beskyttelse, Sådan virker det, FAQ, Pakkeguide,
  Forbudte varer, Kontakt, Om BidHamr, Anmeld ulovligt indhold (DSA), Tilgængelighed, Cookies.

**Hjem**
- Forside: søgefelt, tryghedsstribe, kategorier, "Slutter snart".
- Notifikationer (klokken med rødt tal).
- Auktionsside med bud og maksimumbud (`/auktion/[id]`).
- Sælgerprofil (`/profil/[id]`) med bedømmelser, "Følg", "MitID-verificeret".
- Erhvervssælgers profil (`/erhvervssaelger/[id]`).
- Tilbud til næste byder (`/andenchance/[tilbudId]`).

**Søg**
- Søgning med filtre: pris, kategori, slutter snart, afstand (`/auktioner`).
- Favoritter (`/favoritter`).

**Sælg**
- Opret auktion (`/opret-auktion`) – trin: billeder, titel/beskrivelse, kategori, stand, startpris, varighed, fragt,
  spørgsmål til/fra, forhåndsvisning.
- Redigér auktion (kun uden bud) (`/auktion/[id]/rediger`).
- Mine auktioner (aktive, solgte, usolgte, annullerede).
- Udbetalingskonto (Stripe) – skal være oprettet, før man kan sætte noget til salg.

**Beskeder**
- Liste over samtaler (handelschat + samtaler med BidHamr) (`/beskeder`).
- Handelschat (i handlen).
- Samtale med BidHamr (`/beskeder/bidhamr/[id]`) – kun når staff har åbnet den.

**Min konto**
- Oversigt (`/konto`) med navn, MitID-status, udbetalingskonto, gemt kort.
- Mine handler (`/mine-handler`) → Handelsside (`/mine-handler/[trade_id]`):
  - Checkout med pakkeshop (`/mine-handler/[id]/betal`)
  - Kvittering (`/mine-handler/[id]/kvittering`)
  - Send pakke med labelfri kode (sælger)
  - Bekræft modtagelse + bedømmelse (køber)
  - Afhentning med kode
  - Sag, billeder og anke
  - Returfragt
- Statistik (`/konto/statistik`).
- Følger og fulgte sælgere (`/konto/foelger`).
- Notifikationsindstillinger (`/konto/notifikationer`).
- Fakturaer (`/konto/fakturaer`).
- Skatteoplysninger (DAC7) (`/konto/skat`).
- Afgørelser og klager (DSA) (`/konto/afgoerelser`).
- Profil og indstillinger: navn, profilbillede, adgangskode, enheder, blokeringer, download dine data (`/profil/mig`).
- Slet konto (`/konto/slet`).
- Erhverv: side om erhverv + formular (`/erhverv`, `/erhverv/formular`). For firmakonti vises kun "Firma oversigt"
  og "Log ud" (se afsnit 4.17).

### Design (fra DESIGN.md – gælder også appen)

| Ting | Værdi |
|---|---|
| Skovgrøn (flader, faner, header på grøn) | `#1E5E4A`, mørk `#154537`, lys `#E8F2EE` |
| Primær knap (orange) | `#B85518` med hvid tekst, tryk `#9C4413`. **Aldrig** hvid tekst på `#E8772E` (kun pynt) |
| Tekst | `#1A1A1A`, dæmpet `#555555`, svag `#666666` (aldrig lysere) |
| Kanter | `#EEEEEE`, felter `#D6D6D6` |
| Status | Succes `#E8F2EE`/`#154537` · Advarsel `#FEF3E2`/`#8A4210` · Fejl `#FDECEC`/`#A32020` · Info `#EDF3F8`/`#1F4E79` |
| Gammel rød `#E63946` | Må ikke bruges. Rød kun til fejl og det røde tal på klokken |
| Skrift | Kun **Inter** (`@expo-google-fonts/inter`). Overskrifter 600, priser 700, brødtekst 400 |
| Størrelser (mobil) | h1 26 px, h2 20, h3 17, brødtekst 15, metatekst mindst 12, pris 18 (stor pris 26) |
| Radier | Knapper 10, felter 12, kort 14, store flader 18 |
| Knapper | Højde 44 (primær på mobil 52, fuld bredde). Én orange knap pr. skærmområde. Spinner ved siden af teksten, knappen er låst under indsendelse |
| Touch | Alt, man kan trykke på, er mindst 44×44 |
| Ikoner | Tabler Icons, streg 1.75 |
| App-ikon | 7B (`public/brand/bidhamr-app-ikon.svg`) |
| Tone | Rolig, tryg og kort. "BidHamr Beskyttelse" – aldrig "forsikring" |

### Tekst-wireframes for de vigtigste skærme

**Opret konto → kode**
```
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ Opret konto                  │   │ Tjek din indbakke            │
│ Fornavn   [            ]     │   │ Vi har sendt en kode til     │
│ Efternavn [            ]     │   │ ida@example.dk               │
│ E-mail    [            ]     │   │ Kode [ _ _ _ _ _ _ ]         │
│ Adgangskode [          ] vis  │   │                              │
│ (mindst 10 tegn)             │   │ [   Bekræft (orange)      ]  │
│ [x] Jeg accepterer bruger-   │   │ Send ny kode (efter 2 min.)  │
│     betingelserne (link)     │   │                              │
│ [  Opret konto (orange)   ]  │   └──────────────────────────────┘
│ Har du en konto? Log ind     │
└──────────────────────────────┘
```

**Auktionsside med budpanel** (panelet står fast i bunden)
```
┌──────────────────────────────┐
│ [   billeder, swipe 1/10   ] │
│ Slutter om 2 t 14 min        │
│ Omega Seamaster 1968         │
│ Stand: God · Køge · 14 bud   │
│ Sælger: Sofie ★4,8  MitID ✓  │
│ Beskrivelse …                │
│ Budhistorik (anonym) …       │
│ Spørg sælger / "Sælgeren mod-│
│ tager ikke spørgsmål"        │
├──────────────────────────────┤
│ Nuværende bud   1.250 kr.    │
│ Dit bud [ 1.300 ] kr.        │
│ ( ) Byd én gang  ( ) Maksimum│
│ [ ] BidHamr Beskyttelse      │
│     + 65 kr.  Læs mere       │
│ ┌ lys grøn boks ───────────┐ │
│ │ Bud            1.300 kr. │ │
│ │ Købergebyr    +   65 kr. │ │
│ │ Fragt (pakkeshop) + 50 kr│ │
│ │ ──────────────────────── │ │
│ │ I alt          1.415 kr. │ │
│ └──────────────────────────┘ │
│ Bud er bindende.             │
│ [      Byd (orange)       ]  │
└──────────────────────────────┘
```
Ingen procenter ved budfeltet – kun kroner og totalen. Knappen er låst, til totalen er beregnet.

**Opret auktion – fragttrinnet**
```
┌──────────────────────────────┐
│ Hvordan får køberen varen?   │
│ [x] Send med DAO             │
│     Størrelse: (•)Lille ≤1 kg│
│       ( )Mellem ≤5 kg ( )Stor│
│     Vægt [ 800 ] g           │
│     Køber betaler 40 kr.     │
│ [x] Køberen må også hente    │
│     varen hos mig            │
│ ( ) Kun afhentning           │
│ Postnummer [4684]            │
│ [  Se forhåndsvisning     ]  │
└──────────────────────────────┘
```

**Checkout med pakkeshop**
```
┌──────────────────────────────┐
│ Betal for: Omega Seamaster   │
│ Frist: torsdag kl. 14.00     │
│ Levering                     │
│ (•) Pakkeshop  50 kr.        │
│     Postnummer [4100] Søg    │
│     [kort med pakkeshops]    │
│     ○ Netto Ringsted 1,2 km  │
│     ● Shell Ringsted 2,0 km  │
│ ( ) Levering til døren 85 kr.│
│ ( ) Afhent hos sælger – 0 kr.│
│ Navn [   ] Mobil [   ]       │
│ ┌ prisoversigt ────────────┐ │
│ │ Bud / gebyr / fragt /    │ │
│ │ BidHamr Beskyttelse      │ │
│ │ I alt         1.415 kr.  │ │
│ └──────────────────────────┘ │
│ [ Betal 1.415 kr. (orange) ] │
│ Betalingen håndteres af vores│
│ betalingspartner Stripe.     │
└──────────────────────────────┘
```

**Handelsside (køber og sælger ser hver sin version)**
```
┌──────────────────────────────┐
│ Omega Seamaster · 1.415 kr.  │
│ Status: ● Betalt → ● Sendt → │
│         ○ Modtaget → ○ Afsluttet
│ ─ Sælger: ─────────────────  │
│ [  Send pakke (orange)    ]  │
│   Udbetaling: venter …       │
│ ─ Køber: ──────────────────  │
│ Sporing: Indleveret i dag    │
│ [ Jeg har modtaget pakken ]  │
│ Er der et problem? Opret sag │
│ ─────────────────────────────│
│ Chat med sælgeren            │
│ Kvittering · Fakturaer       │
└──────────────────────────────┘
```

**Send pakke med labelfri kode**
```
┌──────────────────────────────┐
│ 1. Din adresse (afsender)    │
│    [forudfyldt fra sidst]    │
│    [  Lav fragtlabel      ]  │
│ 2. Skriv koden på pakken:    │
│    ┌────────────────────┐    │
│    │   123-456-789      │    │
│    └────────────────────┘    │
│    eller vis den i pakke-    │
│    shoppen. PDF-label (valgfri)
│ 3. Tag to billeder (kamera): │
│    [Kamera: varen i åben kasse]  │
│    [Kamera: lukket kasse+label]│
│ [   Send pakke (orange)   ]  │
└──────────────────────────────┘
```

---

## 4. Sådan virker hver funktion teknisk

Overalt: `SITE` = adressen på den hjemmeside, appen taler med (lokalt i test, `https://bidhamr.dk` i produktion).
Alle server-kald har `Authorization: Bearer <session.access_token>` og `Content-Type: application/json`, og svarer
`{ fejl, kode }` ved fejl. **`fejl` er altid en dansk tekst, der kan vises direkte.** Appen sender ingen `Origin`
(så afviser serveren den ikke).

Markeringer: **[LAV OM]** = den nuværende app gør det sandsynligvis forkert. **[MANGLER PÅ SERVEREN]** = se afsnit 6.

### 4.1 Opret konto, kode og login

- **[LAV OM]** Appen må **ikke** kalde `supabase.auth.signUp` (afvises – "Allow new users to sign up" er altid slået
  fra, og databasen kræver en billet fra serveren). Heller ikke `verifyOtp` eller `resend` direkte.
- Opret: `POST SITE/api/konto/opret` med `{ fornavn, efternavn, email, password, vilkaar_version }`.
  Svarer **altid** `200 { ok: true }` ved gyldigt input (afslører ikke, om e-mailen findes). Vis "Tjek din indbakke".
- Kode: `POST SITE/api/konto/bekraeft` med `{ email, kode, password, fornavn, efternavn, vilkaar_version }`.
  Ved 200: `supabase.auth.setSession({ access_token, refresh_token })` fra `svar.session`.
  - `adgangskode_sat: false` → vis "Vælg adgangskode" og kald `supabase.auth.updateUser({ password })`.
  - `navn_sat: false` → bed om navnet igen og gem `navn`, `fornavn`, `efternavn` på `users`.
  - `vilkaar_sat: false` → vis accept-vinduet (`rpc("accepter_vilkaar", { p_version })`).
- "Send ny kode" = samme `opret`-kald igen (højst én mail pr. 2 minutter).
- Hold adgangskoden i hukommelsen, til koden er tastet – aldrig på disk.
- Koden er 6 cifre i produktion og **8 cifre på testdatabasen**.
- `vilkaar_version` = `VILKAAR_VERSION` i `src/lib/vilkaar.ts` (i dag `"0.1"`). Hent den helst fra `rpc("mine_vilkaar")`
  eller lav en konstant, der skal opdateres sammen med hjemmesiden.
- Adgangskode: mindst 10 tegn, ikke almindelig, ikke e-mail eller navn (samme som `src/lib/adgangskode.ts`).
- **Efternavn er påkrævet** (trim, højst 100 tegn, "Skriv dit efternavn."). Ved navneskift: opdatér `navn`, `fornavn`
  og `efternavn` sammen.
- Login: `supabase.auth.signInWithPassword`. Svarer Supabase `email_not_confirmed` (kun ældre konti): send til
  kode-skærmen og kald "Send ny kode".
- Face ID: gem sessionen i `expo-secure-store`, og lås den op med `expo-local-authentication`. Ingen to-trins-login.
- Log ud: kald `rpc("push_token_fjern", { p_token })` **før** `supabase.auth.signOut()`.

| Kode | Vis |
|---|---|
| `fornavn` / `efternavn` / `email` / `adgangskode` | `fejl` under feltet |
| `vilkaar` | Vis betingelserne igen |
| `kode_forkert` | "Koden er forkert eller udløbet" + "Send ny kode" |
| `suspenderet` / `slettet` | `fejl` (kontoen må ikke logge ind) |
| `for_mange` | "For mange forsøg – vent lidt" |
| `ikke_tilgaengelig` | "Prøv igen om lidt" |

Fuld beskrivelse: `docs/APP-SIGNUP.md`.

### 4.2 Brugerbetingelser

- Læs: `supabase.rpc("mine_vilkaar")`. Accepter: `supabase.rpc("accepter_vilkaar", { p_version })`.
- Databasen afviser bud, maksimum, nye auktioner og "tilbud til næste byder" uden accept: errcode **`BHV02`**,
  besked der starter med `vilkaar_mangler:`. Vis accept-vinduet. Gælder også firmakonti.
- Samme vindue som `src/components/vilkaar/VilkaarDialog.tsx`. Siden skal vise "UDKAST – skal godkendes af advokat",
  så længe hjemmesiden gør det.

### 4.3 MitID

Kræves før første bud (også maksimum) og første auktion. Ikke for firmakonti.

```ts
// expo-crypto + expo-web-browser – se den fulde kode i docs/MITID.md
const hemmelighed = <32 tilfældige bytes som hex>;           // kun i hukommelsen
POST SITE/api/mitid/app        { hemmelighed_hash }  → { url, udloeber }
WebBrowser.openAuthSessionAsync(url, "bidhamr://mitid")
  → bidhamr://mitid?k=<engangs-id>   → POST SITE/api/mitid/app/afslut { k, hemmelighed } → { status, besked }
  → bidhamr://mitid?status=<resultat> (afbrudt/fejl – intet at afslutte)
```

- `scheme: "bidhamr"` skal stå i `app.json` (kræver en development build – virker ikke i Expo Go).
- Vis `svar.besked`, og hent profilen igen. Mærket "MitID-verificeret" vises ud fra `users.mitid_verificeret_kl`.
- Fejlkode **`BHV01`** (`mitid_mangler: …`) ved bud, `saet_maksimum` og ny auktion → vis "Bekræft med MitID".
- Har brugeren et maksimumbud uden MitID: "Bekræft med MitID for at fortsætte dit maksimumbud."
- Resultater: `ok`, `allerede`, `dobbeltkonto`, `under18`, `lukket`, `tidligereSpaerret`, `andenMitid`, `erhverv`,
  `udloebet`, `fejl` (tekster i `src/lib/tekster/mitid.ts`).

### 4.4 Auktioner: læse, søge og favoritter

- **[LAV OM]** Aldrig `.from("auctions").select("*")` eller indlejret `auctions(*)` – `vinder_id` kan ikke læses.
  Brug kolonnelisten i `src/lib/auktionKolonner.ts` (`AUKTION_KOLONNER`), og kopiér den til appen.
- "Er jeg vinder?": `rpc("jeg_er_vinder", { p_auktion })` eller `min_status` fra `rpc("mine_bud_auktioner")`.
- Visningstal: `rpc("hent_mine_visninger", { p_ids })` – **[LAV OM]** læs ikke `auction_views` direkte.
- Live-opdatering af buddet: lyt på `auctions` (UPDATE, `id=eq.<id>`) med Supabase realtime, som `BidPanel.tsx`.
- Fragt på auktionen: `pakkestoerrelse, vaegt_gram, fragt_pakkeshop_oere, fragt_doer_oere, afhentning_mulig`.
  **[LAV OM]** Vis `fragt_pakkeshop_oere` – ikke faste 35 kr.
- Erhvervsauktion: `auctions.erhverv = true` → mærket "Erhvervssælger" og firmaets oplysninger fra
  `rpc("firma_offentlig", { p_bruger })`.
- **Budhistorik:** bud kan ikke læses af andre end byderen selv (privatliv). **[MANGLER PÅ SERVEREN]** en anonym
  budhistorik til appen (hjemmesiden læser den på serveren).
- Gemte søgninger findes ikke længere – **[LAV OM]** fjern `gemte_soegninger` og typen `gemt_soegning`, hvis appen
  bruger dem.

### 4.5 Bud og maksimumbud

- Almindeligt bud: `supabase.from("bids").insert({ auktion_id, bruger_id, beløb, beskyttelse, auktion_redigeret_kl })`
  (som `afgivBud` i `src/app/actions/bud.ts`; `auktion_redigeret_kl` er auktionens `redigeret_kl`, så et bud på en
  ændret auktion afvises). Notifikationerne til de andre bydere sendes af serverens cron.
- Mindste bud: `rpc("mindste_naeste_bud", { p_auktion })` (gulvet er 3 kr.). Beregn det ikke selv.
- Maksimum: `rpc("saet_maksimum", { p_auktion, p_maks, p_beskyttelse, p_auktion_redigeret_kl })`
  → `{ foerer, nuvaerende_bud, maks_beloeb, slutter_kl, bud_afgivet }`. Fører køberen allerede, skal `p_beskyttelse`
  være som på hans seneste bud (eller `null`).
- Eget maksimum: `rpc("mit_maksimum", { p_auktion })` → `{ maks_beloeb, foerer, nuvaerende_bud, naaet }`.
  Maksimum vises kun for brugeren selv: "Dit maksimum: 1.500 kr. Det vises kun for dig."
- Teksten ved knappen: "Dit maksimum er bindende. Vi byder kun så meget, som det kræver for at føre."
- BidHamr Beskyttelse vælges ved buddet (ikke forvalgt) og låses. På erhvervsauktioner sættes den stille til false.

| Fejl (præfiks / kode) | Betyder |
|---|---|
| `samme_bud` | "En anden byder har allerede budt det samme – byd mere." |
| `maks_for_lavt` / `maks_under_bud` / `beskyttelse_laast` | Vis teksten efter præfikset |
| `own_auction` | Man kan ikke byde på egen auktion |
| `BHV01` / `BHV02` | MitID / brugerbetingelser mangler |
| `BHB05` | "Det højeste tilladte bud er 500.000 kr." |
| `BHE01` | Firmakonti kan ikke byde |
| `BHU03` / `BHU05` | Sælgerens konto er sat på pause / spærret – kan ikke bydes på |
| `BHS02` | Kontoen er suspenderet |

### 4.6 Opret, redigér og annullér auktion

- Billeder: op til 10. Gør dem mindre og til JPEG (`expo-image-manipulator`, også HEIC). Upload til bucket
  `auktion-billeder` på stien `<bruger-id>/<uuid>.jpg` (se `auktionBilledeSti` i `src/lib/auktionRegler.ts`), og brug
  den offentlige URL.
- Opret: `supabase.from("auctions").insert({...}).select("id").single()` med de samme felter som
  `src/components/OpretAuktionForm.tsx`: `bruger_id, titel, beskrivelse, billeder, startpris, kategori, stand,
  postnummer, lokation, lat, lng, forsendelse_mulig, pakkestoerrelse, vaegt_gram, afhentning_mulig,
  spoergsmaal_aktiv, forbudt_bekraeftet, varighed_dage, slutter_kl, idempotens_noegle`.
  - **[LAV OM]** Send altid `pakkestoerrelse` (`lille`/`mellem`/`stor`) og `vaegt_gram` ved forsendelse, `stand` og en
    ny `idempotens_noegle` (uuid) pr. oprettelse. Ved dublet (fejl 23505 `auctions_idempotens_unik`):
    `rpc("min_auktion_for_noegle", { p_noegle })` og vis den eksisterende auktion.
  - Varighed: 3, 5, 7 eller 10 dage. Startprisen er også mindsteprisen. Vis anbefalingen "Sæt startprisen lidt under
    det, du regner med at få – er den for høj, byder ingen".
  - Kald edge function `notificer-foelgere` lige efter oprettelsen, som appen gør i dag (serverens cron samler op).
- Redigér (kun uden bud): `rpc("rediger_auktion", ...)` (svarer `{ kode }`, fx `har_bud`). Fragt alene:
  `rpc("saet_auktion_fragt", { p_auktion, p_pakkestoerrelse, p_vaegt_gram })`.
- Annullér (kun uden bud): `rpc("annuller_egen_auktion", { p_auktion })` – **[LAV OM]** den kaster nu `BHL01` i
  stedet for at svare `false`.
- Efter første bud er auktionen helt låst. Skjul Redigér, Annullér og "Modtag spørgsmål", og vis: "Auktionen har fået
  bud og er låst. Kontakt BidHamr, hvis der er et problem med varen."

| Fejl | Vis |
|---|---|
| `BHA01` | "Tilføj mellem 1 og 10 billeder, uploadet til BidHamr." |
| `BHA02` / `BHA03` | "Vælg en kategori." / "Vælg varens stand." |
| `BHA04` / `BHA05` | Titel / beskrivelse for lang |
| `BHF01` | Ordet hører under forbudte varer (teksten fra databasen) |
| `BHT01` | Over 15 kg – kun afhentning |
| `BHT02` / `BHT03` / `BHT04` / `BHT05` | Vægten passer ikke / mangler / er ugyldig / ukendt størrelse |
| `BHU01` | "Du skal oprette en udbetalingskonto, før du kan sætte varer til salg." |
| `BHU02` / `BHU04` | Udbetalingskontoen er ikke godkendt / sælgeren er spærret |
| `BHD01` | DAC7-oplysninger mangler (`dac7_mangler: …`) + link til Skatteoplysninger |
| `BHX01` | Ubetalt regning for ekstra fragt efter fristen (`ekstra_fragt_ubetalt: …`) + link til handlen (`mine_ekstra_fragt_regninger`) |
| `BHV01` / `BHV02` | MitID / brugerbetingelser |
| `BHB05` | Startprisen kan højst være 500.000 kr. |
| `BHE02` / `BHE03` / `BHE04` | Firma: intet abonnement / ugekvote brugt / GPSR-felter mangler |
| `BHL01` | Auktionen er låst efter første bud |
| `BHS02` | Kontoen er suspenderet |
| `22023` | "Tjek startpris og varighed (3, 5, 7 eller 10 dage)." |

### 4.7 Udbetalingskonto (Stripe Connect) og gemt kort

- Sælgeren skal oprette sin Stripe-konto, før han kan sætte noget til salg (`BHU01`).
  **[MANGLER PÅ SERVEREN]** et app-endpoint, der laver Stripes onboarding-link og opdaterer status (hjemmesiden har
  kun server actions: `startSaelgerOnboarding`, `opdaterSaelgerStatus`, `aabnStripeOversigt`).
- Udbetalingsstatus pr. handel: `rpc("handel_udbetalingsstatus", { p_trade })` → `venter`, `stoppet`,
  `kraever_handling`, `paa_vej`, `udbetalt`, `venter_paa_bank`. Bankudbetalinger: `rpc("mine_bankudbetalinger")`.
  `betalingsprofiler.connect_udbetaling_fejlet_kl` → "Udbetalingen til din bank fejlede – ret din bankkonto hos Stripe".
  Tekster som `src/components/betaling/UdbetalingStatusBoks.tsx`.
- Gem kort: **[MANGLER PÅ SERVEREN]** (hjemmesiden: `startGemKort` / `bekraeftGemtKort`, SetupIntent).
- Fjern kort: `POST SITE/api/betaling/kort` med `{ "handling": "fjern-kort" }`.
- **[LAV OM]** Fjern kontakten "Betal automatisk, når jeg vinder" og samtykketeksten. `{ "handling": "autobetaling" }`
  svarer `410 findes_ikke`.

### 4.8 Checkout og betaling (vinderen)

1. Handlen oprettes, når auktionen slutter. Vinderen får notifikationen `vundet`.
2. Overblik: `POST SITE/api/fragt/app/checkout { trade_id }` eller `rpc("handel_checkout", { p_trade })`.
3. Pakkeshops: `POST SITE/api/fragt/app/pakkeshops { postnummer, adresse?, by? }` → liste med `lat`, `lng`,
   `afstandM`, åbningstider. Vis dem på kort og som liste. Forslag fra sidst: brug `checkout.forslag` fra
   `api/fragt/app/checkout` - pakkeshoppen dér er tjekket hos fragtfirmaet, og `pakkeshopTransportoer` er
   shoppens eget fragtfirma (brug den kun hos det firma). `leveringsforslag.transportoer` er det SENESTE valgs
   fragtfirma og kan være et andet end shoppens (20261102080000).
4. Leveringsvalg: `POST SITE/api/fragt/app/levering` med
   `{ trade_id, maade: "pakkeshop", pakkeshop_id, modtager: { navn, telefon }, gem_forslag }`,
   `{ maade: "doer", modtager: { navn, telefon, adresse, postnummer, by } }` (kun Lille/Mellem) eller
   `{ trade_id, maade: "afhentning" }`. Svar `{ fragtOere, totalOere, beskyttelseOere, afhentning, prisAendret }`.
   Ved afhentning fjernes fragt og BidHamr Beskyttelse fra totalen.
5. Betal: **[MANGLER PÅ SERVEREN]** et app-endpoint til `startBetaling` (i dag kun en server action). Det skal svare med
   PaymentIntentens `clientSecret` og `customerSessionClientSecret`, så appen kan åbne PaymentSheet:
   ```ts
   import { initPaymentSheet, presentPaymentSheet } from "@stripe/stripe-react-native";
   await initPaymentSheet({
     merchantDisplayName: "BidHamr",
     paymentIntentClientSecret: svar.clientSecret,
     customerId: svar.customerId,                                  // når endpointet er bygget
     customerSessionClientSecret: svar.customerSessionClientSecret, // gemt kort forudfylder kun
     returnURL: "bidhamr://stripe-redirect",                        // MobilePay og 3D Secure
     applePay: { merchantCountryCode: "DK" },
     googlePay: { merchantCountryCode: "DK", testEnv: true },
     defaultBillingDetails: { name },
   });
   const { error } = await presentPaymentSheet();
   ```
   Tjek, at din version af Stripe-SDK'en understøtter `customerSessionClientSecret` i PaymentSheet. Gør den ikke, laver
   serveren en "ephemeral key" i stedet – det afgøres, når endpointet bygges.
6. **3D Secure er tvunget for kort.** Serveren opretter betalingen med `request_three_d_secure: 'any'`, så banken
   altid spørges. PaymentSheet viser selv bankens vindue. Appen skal ikke gøre noget ekstra. MobilePay, Apple Pay og
   Link påvirkes ikke.
7. Betalingen er først gennemført, når Stripes webhook har registreret den. Vis "Vi venter på betalingen …", og hent
   handlen igen (status `betaling_modtaget`).
8. Svarer betalingen `kode: "vaelg_levering"` (eller databasen `BHT10 levering_mangler`), så send køberen tilbage til
   leveringsvalget. `BHP01` = "Betalingen er midlertidigt sat på pause. Prøv igen senere." (nødstop).
9. Leveringsformen kan kun skiftes før betaling. Kvittering: siden `/mine-handler/[id]/kvittering` (kvittering, ikke
   faktura – varen sælges mellem private).

Testkort (Stripes testmiljø): `4242 4242 4242 4242` (godkendt), `4000 0027 6000 3184` (kræver 3D Secure),
`4000 0000 0000 9995` (afvist). Vilkårlig fremtidig dato og CVC.

### 4.9 Mine handler og handelssiden

- **[LAV OM]** Aldrig `select('*')` på `trades` eller `trades(*)` – `sag_note` og `sag_aabnet_af` er lukket. Brug en
  kolonneliste som `HandelDetalje.tsx`: `id, auction_id, seller_id, buyer_id, amount, status, tracking_number,
  received_at, created_at, afhentning`. Appen kan ikke skrive i `trades` – kun via RPC'er.
- Status: `afventer_betaling` → `betaling_modtaget` → `pakke_sendt` → `modtaget` → `afsluttet` (eller `annulleret`).
  Afhentning: `afhentning = true` og ingen sag.
- Betalingsfrist forlænges af sælgeren (højst 7 dage): `rpc("handel_forlaeng_betalingsfrist", { p_trade, p_ny_frist })`.
- Afhentning: `rpc("afhentning_info", { p_trade })`. Køberen giver stjerner og får koden med
  `rpc("afhentning_vis_kode", { p_trade, p_stjerner, p_kommentar })`, sælgeren bekræfter med
  `rpc("afhentning_bekraeft", { p_trade, p_kode })`, fristen forlænges med `afhentning_forlaeng_frist`.
  7 dages frist. 5 forkerte koder låser i 1 time. `afhentning_info.laast` er true både ved den midlertidige lås
  (`laast_til` = hvornår der kan prøves igen) og den permanente (`laast_permanent`, 15 forkerte i alt) -
  20261102080000. Skjul kodefeltet, når `laast` er true.
- Bankindsigelse (sælgeren): `rpc("handel_indsigelse_status", { p_trade })` → `"aaben"` | `"tabt"` | `null`. Er den
  ikke `null`, så vis "Send ikke varen. Køberens bank har åbnet en indsigelse. Vi skriver til dig, når den er afgjort."
  og skjul "Send pakke"/fragtlabel/afhentningskode. `trade_marker_sendt` og en ny label svarer `kode: "indsigelse"`
  (20261102080000).
- Ikke-afhentet pakke: `rpc("mit_ikke_afhentet", { p_trade })`.
- Udbetaling til sælgeren: se 4.7.

### 4.10 Send pakke med labelfri kode (sælger)

1. Afsenderadresse → `POST SITE/api/fragt/app/book { trade_id, afsender: { navn, adresse, postnummer, by, telefon } }`
   (kan tage op til ca. 50 sekunder – vis en rolig ventetekst). Højst 2 labels pr. handel.
2. `POST SITE/api/fragt/app/forsendelser { trade_id }` → labelfri kode og stregkode. Vis koden stort.
   **I testmiljøet er koden altid `123-456-789`.**
3. PDF (valgfri): `POST SITE/api/fragt/app/label { forsendelse_id }` → `{ url }` (gyldig i 5 minutter).
4. To billeder **med kameraet** (ikke kamerarullen): kategori `aaben_kasse` og `lukket_kasse`. Upload til bucket
   `pakke-billeder` på `<sælger-id>/<handel-id>/<uuid>.jpg` med `upsert: false`.
5. `rpc("trade_marker_sendt", { p_trade, p_tracking, p_billeder: [{ sti, kategori }] })` → `{ kode: "ok" }`.
   **[MANGLER PÅ SERVEREN]** Hjemmesiden sender køberen beskeden "Din pakke er på vej" efter dette kald. Kalder appen
   RPC'en direkte, får køberen ingen besked – brug app-endpointet, når det er bygget (afsnit 6).
6. Annullér label (før indlevering): `POST SITE/api/fragt/app/annuller { trade_id, forsendelse_id }`.
7. Afsendelsesfrist: 5 dage, ellers annulleres handlen, og køberen refunderes.

### 4.11 Bekræft modtagelse (køber)

1. "Jeg har modtaget pakken": `rpc("trade_marker_modtaget", { p_trade })`.
2. "Varen er som den skal være" + 1–5 stjerner (krævet) + valgfri kommentar (højst 1.000 tegn):
   `rpc("handel_godkend_med_bedoemmelse", { p_trade, p_stjerner, p_kommentar })`. Uigenkaldeligt – vis en
   bekræftelsesdialog.
3. Uden bekræftelse frigives pengene 48 timer efter levering, hvis der ikke er en sag.
   **[MANGLER PÅ SERVEREN]** Hjemmesiden sender beskeder og starter udbetalingen efter disse to kald. Brug
   app-endpointet, når det er bygget.

### 4.12 Sager og anke

- Sag inden for 48 timer efter levering, med billeder af pakke, label og indhold. Upload til bucket `sag-billeder`
  (sti som `sagBilledeSti` i `src/lib/sager.ts`).
- `rpc("sag_opret", { p_trade, p_type, p_beskrivelse, p_billeder })`, flere billeder:
  `rpc("sag_tilfoej_billeder", ...)`, anke: `rpc("sag_anke_mulighed", { p_sag })` og
  `rpc("sag_anke_indgiv", { p_sag, p_begrundelse, p_billeder })`. (Kopiér parameternavnene fra `src/app/actions/sager.ts`.)
  **[MANGLER PÅ SERVEREN]** beskeden til sælger og staff sendes i dag af server action'en.
- Uden BidHamr Beskyttelse hjælper BidHamr ikke med retur – undtagen åbenlys svindel og pakke, der ikke kommer frem.
  Anke-knappen åbner 24 timer efter afgørelsen og er åben i 3 dage.
- `BHS01` = "Handlen har en åben sag fra køberen."

### 4.13 Returfragt (sag med retur)

- **Status, pris, adresse og kode læses KUN via** `supabase.rpc("min_returfragt", { p_trade })`.
  **[LAV OM]** Aldrig `select('*')` på `returfragt_betalinger`.
  Køber: `{ rolle: 'koeber', sag: { kode }, id, status, beloeb_oere, betalt_kl, label_klar, label_fejl, refunderet_kl,
  refusion_aarsag }` (`sag.kode = 'ok'` = må sendes nu). Sælger: `{ rolle: 'saelger', retur_paa_vej }`.
- Betal: `POST SITE/api/fragt/app/returfragt { trade_id, afsender: { navn, adresse, postnummer, by, telefon } }`
  → `{ clientSecret, beloebOere, customerSessionClientSecret }` → PaymentSheet (som 4.8). `409 kode "betalt"` = allerede
  betalt.
- Koden laves først, når Stripes webhook har bekræftet betalingen. Hent `min_returfragt` igen, og vis kode, PDF og
  nærmeste pakkeshop. Ny adresse efter betaling: `POST SITE/api/fragt/app/retur`.
- Prisen er det samme som fragten ud. Funktionen er slået fra i produktion (`FRAGT_RETURLABEL_AKTIV`), indtil DAO-aftalen
  er klar.

### 4.14 Chat og samtaler med BidHamr

- Handelschat: `from("messages").insert({ trade_id, sender_id, content })` og
  `.select("id, sender_id, content, created_at, fra_bidhamr, blokeret_grund")`. Live: realtime på `messages` for handlen.
  **[LAV OM]** Send ikke `created_at`, og prøv aldrig at ændre eller slette en besked (`BHM04`).
- `blokeret_grund` (fx `'bank'` for reg.nr./kontonr./IBAN, `'socialt_medie'`): vis samme tekst som `spamForklaring` i
  `src/lib/tryghed.ts`, og gerne advarslen om betaling uden om BidHamr (`erMistaenkeligBesked`).
- Beskeder fra BidHamr (`fra_bidhamr`) markeres tydeligt.
- Ingen chat og ingen "Spørg sælger" på erhvervshandler/-auktioner (`BHE05`). Vis firmaets kontakt i stedet.
- Samtale med BidHamr: brugeren kan kun svare, når staff har åbnet den. `rpc("staff_chat_svar", { p_samtale, p_tekst })`,
  `rpc("staff_chat_marker_laest", ...)`, `rpc("antal_ulaeste_staff_beskeder")`.

| Fejl | Vis |
|---|---|
| `BHM01` | "Beskeder må ikke starte med 'Besked fra BidHamr'." |
| `BHM03` | "Du sender beskeder meget hurtigt. Vent et øjeblik." |
| `BHB01` | "Du kan ikke skrive til denne bruger længere." |
| `BHS02` | Kontoen er suspenderet |
| `BHE05` | Ingen beskeder med erhvervssælgere |

### 4.15 Notifikationer og push

- Klokken: tabellen `notifikationer` (egne rækker), antal ulæste `rpc("notifikationer_antal_ulaeste")`,
  læst: `rpc("notifikationer_marker_laest", { p_ids })` / `rpc("notifikationer_marker_alle_laest")`.
- Indstillinger: `notifikation_indstillinger` + `rpc("notifikation_gem_indstillinger", { p_indstillinger })`.
  Kanaler: klokke, mail, push. Påkrævede typer skal have mindst én kanal slået til. Typer og danske navne:
  `src/lib/notifikationer/typer.ts`. **[LAV OM]** typen `gemt_soegning` findes ikke længere.
- Push: hent Expo-tokenet med `expo-notifications`, og registrér med
  `rpc("push_token_registrer", { p_token, p_platform: "ios" | "android" })`. Fjern ved log ud med `push_token_fjern`.
  Serveren sender allerede push via Expo til tokens i formatet `ExponentPushToken[...]`. Højst 10 enheder pr. bruger.
- Når brugeren trykker på en push-besked: notifikationen har et `link` til en hjemmesidesti (fx `/mine-handler/<id>`,
  `/auktion/<id>`). Appen skal oversætte stien til den rigtige skærm.

### 4.16 Profil, indstillinger, statistik, fakturaer og DAC7

- Egen profil: `rpc("min_profil")`, offentlige tal: `rpc("profil_offentlige_tal", { p_bruger })`.
- Følgere: `rpc("antal_foelgere", { p_bruger })` og kun insert/delete på `seller_follows`. **[LAV OM]** læs ikke selve
  `seller_follows`-rækkerne for andre. Mine fulgte: `rpc("mine_fulgte_saelgere")`.
- Bedømmelser: sælgerens svar `rpc("skriv_bedoemmelse_svar", ...)`, notifikationstypen `bedoemmelse`.
- Blokering: `rpc("bloker_bruger", { p_bruger })`, `rpc("mine_blokeringer")`.
- Anmeld auktion: **[LAV OM]** `rpc("rapporter_auktion", { p_auktion, p_kategori, p_beskrivelse })` – ikke insert i
  `reports`. Læs aldrig `handled_by`/`handled_note`. Ulovligt indhold (DSA): `POST SITE/api/dsa/anmeld`.
- Statistik: `rpc("min_statistik")`, `rpc("mine_bud_auktioner")`.
- Enheder og download af data: `rpc("mine_enheder")`, `rpc("fjern_min_enhed")`, `rpc("mine_data")` (`BHR01` = én gang
  i timen).
- Fakturaer: `rpc("mine_fakturaer")`, PDF: `GET SITE/api/faktura/<id>` med Bearer → gem med `expo-file-system`, og vis
  eller del den.
- DAC7: `rpc("dac7_min_status")` (POST, som supabase-js gør som standard), gem: `POST SITE/api/dac7/oplysninger`.
  **Appen må aldrig gemme CPR.** Notifikationstypen `skat`.

### 4.17 Slet konto (Apples krav)

- `POST SITE/api/konto/slet { adgangskode, bekraeftelse: "SLET" }`.
- `409 { kode: "blokeret", blokeringer: [{ type, tekst, link }] }` → vis teksterne (fx åben handel, suspenderet,
  firmakonto). `403 forkert_adgangskode`.
- Status før sletning: `rpc("min_konto_sletning_status")`. Handelsdata bevares (bogføringsloven) – kontoen bliver
  "Slettet bruger".

### 4.18 Erhverv / firmakonti

- `users.konto_type = 'erhverv'` → menuen viser kun "Firma oversigt" og "Log ud". Firmakonti kan ikke byde (`BHE01`)
  og kan ikke oprettes i appen.
- `rpc("firma_oversigt")`, `rpc("firma_ugekvote")`, `rpc("firma_auktioner", { p_gruppe })`, `rpc("firma_statistik")`,
  `rpc("firma_salg")`.
- **[LAV OM]** Pakkeskift: `POST SITE/api/firma/skift-pakke { pakkeId }` – ikke `rpc("firma_skift_pakke")`.
  Ved `betal_forskellen` åbnes `url` i browseren.
- Klager over firmaet (køber): `erhverv_klager_handel`, `erhverv_klage_opret`, `erhverv_klage_traek_tilbage`
  (`BHE11`–`BHE14`). Er `annulleret_afvist` true, skjules "Klag over firmaet".
- Siden "Erhverv" og formularen kan vises som en webside i appen (formularen går via `/api/offentlig`).
- Ingen BidHamr Beskyttelse ved køb fra erhverv.

### 4.19 Tilbud til næste byder (andenchance)

- Byderen ser tilbuddet og svarer. Sælgeren sender tilbuddet eller sætter varen op igen.
  **[MANGLER PÅ SERVEREN]** `andenchance_opret`, `andenchance_svar` og `genopsaet_auktion` kan kun kaldes af serveren.
  Indtil endpointet findes, kan appen åbne `SITE/andenchance/<tilbudId>` i en webvisning.

---

## 5. Byggeplan fra torsdag – små trin, der kan testes hver for sig

Fast testopsætning for alle trin:
- Testbruger: **`macbook@test.bidhamr.dk`** på testdatabasen (adgangskoden står øverst i `supabase/seed.sql`).
  Køber/sælger at handle med: `saelger@test.bidhamr.dk` og `koeber@test.bidhamr.dk` (samme fil).
- Testdatabasen: **Bidhamr Test**, `https://pjiigmzqwlfepxnjdvug.supabase.co` (publishable/anon-nøglen fra
  hjemmesidens `.env.local`). Aldrig `lkifkrexeldimmghnsie` (produktion), før appen er færdig.
- Stripe: kun testnøglen (`pk_test_…`) fra samme Stripe-konto som hjemmesidens `.env.local`. Testkort `4242 4242 4242 4242`.
- Når et trin er færdigt: commit og push til GitHub, så Claude kan sammenligne.

**Trin 0 – Testmiljøet (torsdag formiddag)**
- Kør hjemmesiden lokalt på Mac'en: klon repoet, få `.env.local` overført sikkert fra den stationære (ikke via GitHub),
  `npm install`, `npm run dev`. Så kører den på `http://localhost:3000` mod testdatabasen.
- Appen får to indstillinger i en `.env`-fil: `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` (test) og
  `EXPO_PUBLIC_SITE` (`http://localhost:3000` i iPhone-simulatoren; `http://10.0.2.2:3000` i Android-emulatoren; en
  https-tunnel på en rigtig telefon – se åbne spørgsmål).
- **Test:** åbn `http://localhost:3000` i Safari, og log ind som macbook@. Du ser siden.

**Trin 1 – Flyt koden til GitHub (roadmappens første punkt i fase 5)**
- Opret et privat repo `bidhamr-app` på GitHub. Tjek, at `.gitignore` udelukker `node_modules`, `.env` og nøgler.
- `git init`, `git add .`, `git commit -m "Appen som den er nu"`, `git remote add origin …`, `git push -u origin main`.
- **Test:** repoet kan ses på github.com, og der ligger ingen `.env`-fil eller hemmelige nøgler i det.
- Sig til Claude, så klones det til den stationære.

**Trin 2 – Sammenligning af skærmene**
- Claude gennemgår app-koden mod hjemmesiden og laver en liste: skærme, der mangler, og kald, der skal laves om
  (alle **[LAV OM]**-punkter i afsnit 4).
- Du tager skærmbilleder af hver app-skærm i simulatoren og lægger dem i repoet (`docs/skaermbilleder/`).
- **Test:** du har én liste, sorteret efter rækkefølgen nedenfor.

**Trin 3 – Development build**
- `npx expo install expo-dev-client`, sæt `scheme: "bidhamr"`, `ios.bundleIdentifier` og `android.package` i `app.json`.
  Byg: `npx expo run:ios` (eller `eas build --profile development`).
- **Test:** appen starter i simulatoren uden Expo Go, og `npx uri-scheme open bidhamr://test --ios` åbner appen.

**Trin 4 – Design-grundlag**
- Lav én fil med farver, skriftstørrelser, radier og knapper fra afsnit 3 (Inter, Tabler-ikoner). Lav fanerne.
- **Test:** alle fem faner kan åbnes. Knapperne har de rigtige farver, og ingen gammel rød (`#E63946`).

**Trin 5 – Login og opret konto (4.1 + 4.2)**
- Fjern `signUp`. Byg Opret konto → Kode → Velkommen, Login, Glemt adgangskode, accept-vinduet og Face ID.
- **Test:** opret `filip+app1@…` (din egen mail, så du får koden – 8 cifre på testdatabasen). Prøv en forkert kode, "Send
  ny kode" og et tomt efternavn ("Skriv dit efternavn."). Log ud og ind igen som macbook@.

**Trin 6 – Læse auktioner (4.4)**
- Forside, søgning, filtre, auktionsside, favoritter, sælgerprofil. Kolonnelisten i stedet for `select('*')`.
- **Test:** auktionerne fra `seed.sql` vises. Ingen "permission denied" i loggen.

**Trin 7 – MitID (4.3)**
- **Test:** log ind som `mitid-a@test.bidhamr.dk`, tryk "Bekræft med MitID", og brug en test-MitID fra MitID Test Tool.
  Mærket "MitID-verificeret" vises. Prøv samme test-MitID på `mitid-b@` → "Dit MitID er allerede brugt".

**Trin 8 – Bud og maksimumbud (4.5)**
- Budpanel med prisoversigt, BidHamr Beskyttelse, maksimum.
- **Test:** som macbook@ byder du på en af saelger@s auktioner. Byd under minimum (fejl), byd præcist, sæt et maksimum,
  og byd så som koeber@ på hjemmesiden – appen skal skifte bud af sig selv (live).

**Trin 9 – Opret auktion (4.6)**
- Billeder (også HEIC), alle felter, fragt med størrelse og vægt, forhåndsvisning.
- **Test:** opret en auktion med 3 billeder, Mellem, 2.000 g. Prøv 20.000 g (kun afhentning, `BHT01`) og ordet fra
  forbudte varer (`BHF01`). Prøv at redigere den efter et bud fra koeber@ (låst).

**Trin 10 – Udbetalingskonto (4.7)** – kræver Claudes endpoint (afsnit 6)
- **Test:** som en ny testbruger: opret konto → prøv at oprette auktion (`BHU01`) → opret Stripe-testkonto (brug Stripes
  testdata) → opret auktionen.

**Trin 11 – Checkout og betaling (4.8)** – kræver Claudes endpoint
- **Test:** lad en kort testauktion (3 dage, eller bed Claude afslutte den på testdatabasen) blive vundet af macbook@.
  Vælg pakkeshop, betal med `4242 4242 4242 4242`. Gentag med 3D Secure-kortet `4000 0027 6000 3184` og med det afviste
  `4000 0000 0000 9995`. Prøv "Afhent hos sælger" og se totalen falde.

**Trin 12 – Handelssiden, send pakke og bekræft modtagelse (4.9–4.11)**
- **Test:** som sælger: book label (koden er `123-456-789`), tag to kamerabilleder, "Send pakke". Som køber:
  "Jeg har modtaget pakken", 5 stjerner, godkend. Tjek, at køberen får beskeden "Din pakke er på vej".

**Trin 13 – Chat og samtaler med BidHamr (4.14)**
- **Test:** skriv i handlen, prøv et kontonummer (bliver blokeret med forklaring), og bed Claude åbne en staff-chat med
  macbook@ fra admin.

**Trin 14 – Push og notifikationer (4.15)**
- **Test:** på en rigtig iPhone (development build): bliv overbudt af koeber@ → push kommer, tryk på den → auktionen
  åbnes. Slå "Du er overbudt" fra i indstillingerne → ingen push.

**Trin 15 – Sager, anke og returfragt (4.12–4.13)**
- **Test:** opret en sag med billeder på en leveret handel. Bed Claude afgøre den med retur på testdatabasen. Betal
  returfragten med testkortet, og se koden.

**Trin 16 – Min konto: profil, statistik, fakturaer, DAC7, slet konto (4.16–4.17)**
- **Test:** hent en faktura-PDF, gem DAC7-oplysninger (CPR kun til serveren), og slet en ny testbruger med "SLET".

**Trin 17 – Erhverv (4.18)**
- **Test:** log ind som `firma@test.bidhamr.dk` → kun "Firma oversigt". Kan ikke byde.

**Trin 18 – Klar til butikkerne**
- App-ikon 7B, splash-skærm, TestFlight og intern test på Google Play, privatlivsoplysninger i App Store Connect,
  live-nøgler (først i fase 6).
- **Test:** installér fra TestFlight på din egen iPhone.

Når trin 5–12 virker mod testdatabasen, er appen klar til at blive testet mod produktion (Filip siger til).

---

## 6. Det, hjemmesiden mangler at levere til appen

Kort og realistisk. Rækkefølgen er vigtigheden. Når kun én ting før torsdag: nr. 1.

1. **Betaling fra appen** – **BYGGET (13. okt. 2026)**: `POST /api/betaling/app/<handling>` – `betal`,
   `indstillinger`, `gem-kort`, `bekraeft-kort`, `fjern-kort`, `udbetalingskonto`, `udbetalingskonto-status`,
   `stripe-oversigt`. Se `docs/APP-BETALING.md` (gælder også de **[MANGLER PÅ SERVEREN]**-punkter i 4.7 og 4.8).
   Ingen ephemeral key – kun kundesession (`customerSessionClientSecret`).
2. **Handelstrin fra appen** – **BYGGET (15. okt. 2026)**, se `docs/APP-ENDPOINTS.md` (også bud, budhistorik,
   konto og læst-status for handelschat). Oprindelig beskrivelse: `POST /api/handel/app/<handling>`: `send-pakke`, `modtaget`, `godkend`,
   `afhentning-bekraeft`, `sag-opret`, `sag-billeder`, `anke`, `andenchance-tilbud`, `andenchance-svar`, `genopsaet`.
   Hjemmesidens server actions sender mails/push og starter udbetalingen efter RPC'en. Kalder appen RPC'en direkte, sker
   det ikke (cron'en samler kun bud, beskeder, likes, spørgsmål, bedømmelsessvar og fristforlængelser op).
   Ikke bygget endnu – listen står i `docs/APP-BETALING.md` (sag og anke klares allerede af cron).
   *Backend-agent + reviewer.*
3. **Anonym budhistorik** – **BYGGET (15. okt. 2026)**: `rpc("auktion_budhistorik", { p_auktion })`. En RPC (fx `auktion_budhistorik(p_auktion)`), der giver det samme som auktionssiden på
   hjemmesiden ("Byder 1", beløb, tidspunkt, "automatisk") uden byder-id'er. *Backend-agent.*
4. **Oversigt over push-links** – en lille tabel over alle `link`-stier i notifikationerne og hvilken app-skærm de skal
   åbne, og en test af, at serveren sender Expo-push fra testmiljøet (`EXPO_ACCESS_TOKEN`). *Backend-agent.*
5. **Testopsætning til en rigtig telefon** – en kort vejledning til en https-tunnel til den lokale hjemmeside og den
   rigtige `MITID_CALLBACK_URL` i testmiljøet. *Ingen kode.*

Ikke nødvendigt: nye tabeller. Alt andet (konto, MitID, fragt, returfragt, kort, slet konto, faktura, DAC7, DSA,
firmapakke) findes allerede som app-endpoints.

---

## 7. Åbne spørgsmål til Filip

1. **Hvilke dele af den nuværende app vil du beholde?** Vil du rette den eksisterende kode, eller starte forfra i en ny
   Expo-skabelon og flytte de skærme over, der er gode? (Svaret afgør trin 2.)
2. **Expo-versionen:** hvilken Expo SDK bruger appen i dag? Er den gammel, er det lettest at opgradere først.
3. **Navigation:** er de fem faner (Hjem, Søg, Sælg, Beskeder, Min konto) i orden, eller har appen i dag en anden
   opdeling, du vil beholde?
4. **Test på en rigtig telefon:** må Claude sætte en https-tunnel op til din lokale hjemmeside (fx Cloudflare Tunnel)?
   Det er nødvendigt for push og MitID på en rigtig iPhone mod testdatabasen. Vercel må ikke bruges, fordi den altid
   skal køre på produktionsdatabasen.
5. **MitID i testmiljøet:** skal Idura-testopsætningen have en ekstra callback-adresse til tunnelen?
6. **Apple Developer og Google Play:** tilmelder du dem i BidHamrs navn (CVR) nu? Har du et D-U-N-S-nummer?
7. **Bundle-id og pakkenavn:** fx `dk.bidhamr.app` på begge platforme – er det i orden? Det kan ikke ændres senere.
8. **Hvilke betalingsmetoder skal være synlige i appen fra start?** Kort, MobilePay, Apple Pay og Google Pay er
   besluttet. Klarna, Revolut Pay og Link "må gerne" – skal de også med i appen?
9. **Erhverv i appen:** skal firmaer kunne bruge "Firma oversigt" i appen, eller er det nok på hjemmesiden i første
   version? (Roadmappen siger "Appen: samme erhvervsfunktioner", men firmaerne er primært ældre brugere på computer.)
10. **Rækkefølgen af endpoints i afsnit 6:** skal Claude starte med betaling (nr. 1) med det samme?
