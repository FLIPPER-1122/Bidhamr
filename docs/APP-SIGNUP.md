# Oprettelse af konto i appen

Appen må **ikke** kalde `supabase.auth.signUp` længere. Kontoen oprettes på serveren via to endpoints. Hjemmesiden bruger samme kodevej (`src/lib/kontoOprettelse.ts`).

## Hvorfor

Med direkte `signUp` kunne en angriber oprette kontoen først med offerets e-mail og sin egen adgangskode. Når offeret bekræftede med koden, havde kontoen stadig angriberens adgangskode. Det er en kontoovertagelse.

Nu gælder:
- "Allow new users to sign up" er **altid slået fra** i Supabase. `signUp` med anon-nøglen svarer `signup_disabled`.
- Databasen afviser desuden enhver ny konto, som serveren ikke har lagt en billet til (`20261018010000_signup_billet_altid.sql`). Billetten er bundet til serverens eget kald med et tilfældigt engangs-nonce, så en direkte `signUp` afvises, også i det sekund billetten ligger. Det gælder, selv hvis indstillingen i dashboardet ved en fejl bliver slået til.
- Kontoen oprettes med en tilfældig adgangskode og uden navn og vilkår. Adgangskoden, navnet og vilkårsaccepten sættes først, når koden fra mailen er indtastet. Det er altså kun den, der har adgang til e-mailen, der bestemmer dem.

## Flowet i appen

1. **Opret konto-skærmen:** `POST /api/konto/opret`. Svaret er altid det samme ved gyldigt input, så vis "Tjek din indbakke" og gå videre til kode-skærmen. Hold oplysningerne i hukommelsen (adgangskoden ikke på disk), til koden er indtastet. Serveren gemmer dem ikke ved oprettelsen.
2. **Kode-skærmen:** `POST /api/konto/bekraeft` med e-mail, kode, den samme adgangskode, fornavn, efternavn og vilkårsversion igen. Ved 200 gemmes sessionen med `supabase.auth.setSession({ access_token, refresh_token })`. Brugeren er så logget ind.
3. **"Send ny kode":** kald `POST /api/konto/opret` igen med de samme oplysninger. Højst én kodemail pr. e-mail hvert 2. minut. Inden for de 2 minutter sendes intet, og den forrige kode gælder stadig.
4. **Login med en ubekræftet konto:** Supabase svarer kun `email_not_confirmed`, hvis adgangskoden passer. En konto, der er oprettet på den nye måde, har ingen kendt adgangskode før bekræftelsen, så det sker kun for ældre konti. Send brugeren til kode-skærmen og kald "Send ny kode" (punkt 3), og lad brugeren skrive navn og en ny adgangskode og acceptere betingelserne på kode-skærmen.

Begge endpoints kræver `Content-Type: application/json`. Appen (native) sender ingen `Origin`. Kommer kaldet fra en browser på et andet domæne, afvises det.

## POST /api/konto/opret

```json
{ "fornavn": "Ida", "efternavn": "Hansen", "email": "ida@example.dk", "password": "...", "vilkaar_version": "<VILKAAR_VERSION>" }
```

`vilkaar_version` er den version af brugerbetingelserne, brugeren har accepteret (`VILKAAR_VERSION` i `src/lib/vilkaar.ts`).

| Status | Krop | Betyder |
|---|---|---|
| 200 | `{ ok: true }` | **Altid** ved gyldigt input: ny konto, konto findes allerede (bekræftet eller ej), e-mailen er ikke inviteret (lukket tilmelding), inden for 2-minutters vinduet eller en fejl på serveren (logges i /admin/drift). Vis "Tjek din indbakke". |
| 400 | `{ fejl, kode: "ugyldig" }` | Ikke JSON, eller kroppen er over 4 KB |
| 400 | `{ fejl, kode: "fornavn" \| "efternavn" \| "email" \| "adgangskode" }` | Feltet er tomt eller ugyldigt. `fejl` er en dansk tekst, der kan vises direkte |
| 400 | `{ fejl, kode: "vilkaar", vilkaar_version }` | Brugeren har ikke accepteret den aktuelle version. Vis betingelserne igen |
| 403 | `{ fejl, kode: "ikke_tilladt" }` | Fremmed `Origin` |
| 429 | `{ fejl, kode: "for_mange" }` | For mange forsøg |
| 503 | `{ fejl, kode: "ikke_tilgaengelig" }` | Grænserne kunne ikke tjekkes (fail closed). Prøv igen om lidt |

Navnene renses som på hjemmesiden: trim, ét mellemrum og højst 100 tegn. Adgangskoden skal opfylde samme krav som på hjemmesiden (`vurderAdgangskode` i `src/lib/adgangskode.ts`: mindst 10 tegn, ikke almindelig, ikke e-mail eller navn).

## POST /api/konto/bekraeft

Valgfrit felt `henvisningskode` (Henvis en ven, `20261102230000_henvis_en_ven.sql`): koden fra et link
`bidhamr.dk/?ven=KODE`. Knyttes kun til en ny konto; en ugyldig eller ukendt kode ignoreres (samme svar). Se
docs/APP-ENDPOINTS.md. Uændret for appen. Hjemmesiden bruger ikke længere en cookie (Filip, 27. okt. 2026): koden
står i et synligt, valgfrit felt "Henvisningskode" på opret konto (udfyldt fra `?ven=`, kan rettes) og sendes med
igen fra "Indtast koden". Appen bør vise samme felt, så brugeren kan se og rette koden.


```json
{ "email": "ida@example.dk", "kode": "123456", "password": "...", "fornavn": "Ida", "efternavn": "Hansen", "vilkaar_version": "<VILKAAR_VERSION>" }
```

Koden må have mellemrum (de fjernes). Produktion bruger 6 cifre, testdatabasen 8.

| Status | Krop | Betyder |
|---|---|---|
| 200 | `{ ok: true, adgangskode_sat, navn_sat, vilkaar_sat, session: { access_token, refresh_token, expires_in, expires_at, token_type }, bruger: { id, email } }` | E-mailen er bekræftet, og brugeren er logget ind |
| 400 | `{ fejl, kode: "ugyldig" \| "email" }` | Ugyldig krop eller e-mail |
| 400 | `{ fejl, kode: "kode_forkert" }` | Forkert eller udløbet kode (Supabase skelner ikke). Tilbyd "Send ny kode" |
| 400 | `{ fejl, kode: "adgangskode" \| "fornavn" \| "efternavn" }` | Adgangskoden eller navnet opfylder ikke kravene. Det tjekkes, **før** koden bruges, så koden gælder stadig |
| 400 | `{ fejl, kode: "vilkaar", vilkaar_version }` | Ikke den aktuelle version af betingelserne. Tjekket før koden bruges |
| 403 | `{ fejl, kode: "ikke_tilladt" }` | Fremmed `Origin` |
| 403 | `{ fejl, kode: "suspenderet" \| "slettet" }` | Kontoen må ikke logge ind. `fejl` forklarer hvorfor |
| 429 | `{ fejl, kode: "for_mange" }` | For mange forsøg |
| 503 | `{ fejl, kode: "ikke_tilgaengelig" }` | Grænserne kunne ikke tjekkes |
| 500 | `{ fejl, kode: "fejl" }` | Noget gik galt |

Kontoens status (suspenderet eller slettet) tjekkes, **før** noget ændres. En suspenderet konto får hverken ny adgangskode, navn eller session.

**`adgangskode_sat: false`:** e-mailen er bekræftet, men adgangskoden kunne ikke sættes. Kontoen har så en tilfældig adgangskode. Vis "Vælg adgangskode", og kald `supabase.auth.updateUser({ password })` med den nye session.

**`navn_sat: false`:** databasen afviste navnet (fx `BHN01`: indeholder "BidHamr", `BHN02`: e-mail, telefon eller link). Kontoen hedder "Bruger". Bed om navnet igen, og gem det på `users` (`navn`, `fornavn`, `efternavn`) med den nye session.

**`vilkaar_sat: false`:** accepten kunne ikke gemmes. Vis accept-vinduet (`rpc("accepter_vilkaar", { p_version })`). Databasen afviser bud og salg uden accept (`BHV02`).

## Grænser

Samme grænser som hjemmesiden (`src/lib/rateLimit.ts`):

| Grænse | Loft |
|---|---|
| `konto_app_ip` (begge endpoints, før indholdet tjekkes) | 60 pr. IP pr. time |
| `opret_ip` | 5 oprettelser pr. IP pr. time |
| `gensend_email` | 4 pr. e-mail pr. time |
| `kodemail_email` | 1 kodemail pr. e-mail pr. 2 minutter (ingen fejl, bare ingen ny mail) |
| `signup_kode_email_ip` | 5 kodeforsøg pr. e-mail+IP pr. 15 min. (nulstilles ved succes) |
| `signup_kode_ip` | 30 kodeforsøg pr. IP pr. 15 min. |
| `signup_kode_email` | 15 kodeforsøg pr. e-mail pr. time |

## Sikkerhed

- Ingen cookies og ingen CORS-headere. En browser på et andet domæne kan ikke sende JSON hertil uden en preflight, som ikke godkendes, og en fremmed `Origin` afvises.
- Svaret fra `/api/konto/opret` afslører ikke, om e-mailen findes, eller om den er inviteret.
- En bekræftet konto, en inviteret konto (fx en firmakonto fra Admin → Erhverv) eller en firmakonto får aldrig en ny signup-kode herfra, så en fremmed ikke kan ugyldiggøre et invitationslink. Svaret er det samme.
- Adgangskoden, navnet og vilkårsaccepten sættes kun efter en vellykket `verifyOtp` (adgangskoden i sessionen fra den, navn og vilkår med service role). Uden koden kan en fremmed hverken bekræfte kontoen eller bestemme adgangskoden. Det gælder, uanset om angriberen opretter kontoen før eller efter offeret.
- Bekræftes en konto uden adgangskode (hjemmesiden i en anden browser), sættes en ny tilfældig adgangskode, og brugeren vælger sin egen bagefter. Så overlever ingen adgangskode, som en anden måtte have sat.
- Proxyen lukker begge stier igennem uden login (`src/lib/supabase/middleware.ts`), fordi man jo ikke har en konto endnu.
