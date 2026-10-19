# Admin på egen adresse (admin.bidhamr.dk) og to-trins-login for staff

Filips beslutninger 19. okt. 2026 (ROADMAP-BESLUTNINGER.md, "Admin på admin.bidhamr.dk"). Indsnævrer beslutningen fra 7. okt.: **brugere har stadig intet to-trins-login**, men **staff skal bruge to-trins-login (Supabase MFA TOTP) på admin.bidhamr.dk**. Intet uden for admin-hosten kræver aal2 – der er ingen `db_pre_request` (det var den, der lukkede appen 7. okt., commit `b674cf7`).

## Kort fortalt
- Samme Vercel-projekt. `ADMIN_VAERT=admin.bidhamr.dk` slår det til; uden den virker alt som før (admin på `/admin`, intet to-trins-login).
- På admin-hosten: kun `/admin*`, `/adgang*`, Next' egne filer, ikoner og `robots.txt` (Disallow). Alt andet giver 404. `/` sender til `/admin`.
- Admin har sin egen session-cookie (host-only `__Host-bh-admin-auth`), så hovedsitets session aldrig sendes til admin, og omvendt.
- Login: e-mail + adgangskode → koden fra app'en (TOTP) → admin. En ny kode kræves efter 12 timer (`STAFF_TO_TRIN_MAKS_TIMER`).
- Hver admin-side og -handling tjekker fire ting (`hentStaffAdgang` i `src/lib/adminAuth.ts`): admin-hosten, aal2 med en frisk kode, databasen (aktiv og ingen ukendte faktorer) og rollen.

## Arkitektur

| Del | Fil |
|---|---|
| Host, links og cookie | `src/lib/adminVaert.ts` – `erAdminVaert(host)` (præcis sammenligning af `Host` uden port, små bogstaver, ignorerer `x-forwarded-host`, aldrig `*.vercel.app` i produktion), `adminUrl`, `adminAbsolutUrl` (mails), `hovedsiteUrl` (links fra admin til bidhamr.dk), `adminCookieOptions` |
| Proxy | `src/proxy.ts` deler tidligt: `erAdminVaert(host)` → `adminGate` (`src/lib/supabase/middleware.ts`), ellers `updateSession` som før. Reglerne er rene funktioner i `src/lib/adminGateRegler.ts` |
| Supabase-klienter | `server.ts`, `client.ts` og proxyen bruger `cookieOptions.name` = admin-cookien på admin-hosten, ellers Supabases standard |
| Adgangstjek | `src/lib/adminAuth.ts` – `hentStaffAdgang()`; `assertRole`, `kraevSideRolle`, `getStaffRole`, `assertErhverv`, `kraevErhvervSide`, `getErhvervRolle` er lag ovenpå. Reglerne: `vurderStaffAdgang` i `src/lib/staffToTrinRegler.ts` |
| Login-sider | `src/app/adgang/{login,kode,opsaet,gendan}` (uden admin-layoutet), handlinger i `src/app/actions/adgang.ts` |
| Chefens knapper | Admin → Medarbejdere: "Nulstil to-trins-login" og "Åbn tilmelding (24 t)" (`src/app/actions/adminToTrin.ts`, `src/components/admin/ToTrinHandling.tsx`) |
| Server-hjælpere | `src/lib/staffToTrin.ts` (faktorer via admin-API'et, gendannelseskoder, sikkerhedsmails), mails i `src/lib/mails/staffToTrin.ts` |
| Database | `supabase/migrations/20261027010000_staff_to_trin.sql` (migration A) |
| CSP | `lavCsp(nonce, "admin")` i `src/lib/csp.ts`: ingen Stripe, Google, Apple Pay eller kortfliser; `frame-src 'none'` |

### Proxyen på admin-hosten
- `/admin*` uden session → `/adgang/login?naeste=…` (GET) / 401. Ikke staff → 404. aal1 eller en kode ældre end grænsen → `/adgang/kode?naeste=…` / 401. Rollen `saelger` kun `/admin/erhverv*`.
- `/adgang*`: GET for alle. Andre metoder (server actions) kun uden session eller for staff – ellers kunne en almindelig bruger poste et vilkårligt action-id hertil uden om hovedsitets gate før lancering.
- Headere på alle svar: `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`. `next.config.ts` sætter de to første også på statiske filer (host-regel ud fra `ADMIN_VAERT` ved build).
- Gaten før lancering, firmakonti og beta køres ikke her.
- Statiske filer, som proxyens matcher springer over (`/brand/`, `/forside/` …), serveres også på admin-hosten. Det er offentlige filer.

### Hovedsitet (bidhamr.dk) med `ADMIN_VAERT` sat
- `/adgang*` → 404.
- `/admin*` efter `ADMIN_LUK_HOVEDDOMAENE`: ikke sat = proxyen gør som i dag, men siderne sender selv videre til `admin.bidhamr.dk/admin` (stien følger ikke med). `omdiriger` = GET/HEAD 307 til samme sti på admin-hosten, alt andet 404. `1` = alt 404.
- Admin-handlinger afvises altid uden for admin-hosten (host-tjekket i `hentStaffAdgang`) – også et action-id postet til en vilkårlig sti uden Origin.
- `getStaffRole()` er `null`. Staff-knapper på hovedsitet er erstattet af almindelige links: "Åbn auktionen i admin" og "Åbn i admin" ved spørgsmål (ny side `/admin/auktioner/<id>/spoergsmaal`). "Admin" i profilmenuen og mobilmenuen peger på `adminUrl("/admin")`. Rollen bruges kun til tekster og links (`staffRolleTilVisning`).
- Mails med links til admin (drift-alarm, kontaktformularen, beta-fejl) bruger `adminAbsolutUrl`; `sideUrl("/admin…")` sender desuden altid til admin-hosten.
- Links fra admin til auktionssider bruger `hovedsiteUrl`.

## Forløbene
- **Første gang (opsæt):** login → `/adgang/opsaet` (kun i et åbent tilmeldingsvindue) → "Start": serveren sletter alle gamle faktorer og laver en ny TOTP (`mfa.enroll`) → QR-kode og hemmelighed → første kode (`mfa.challengeAndVerify`, aal2) → serveren tjekker faktorerne med `auth.admin.mfa.listFactors` (ukendte slettes, drift-alarm) → `staff_to_trin_aktiver` (aktiv, faktoren gemmes, vinduet lukkes, 10 gendannelseskoder) → koderne vises én gang (kopiér/hent som fil) → sikkerhedsmail.
- **Login:** e-mail + adgangskode (rate limit, ikke-staff logges ud igen med "Forkert e-mail eller adgangskode") → `/adgang/kode` → admin. Efter 12 timer sender proxyen til `/adgang/kode` igen.
- **Mistet telefon:** `/adgang/gendan` – e-mail, adgangskode og én gendannelseskode. Koden bruges (atomisk), faktorerne og admin-sessionerne (aal2) slettes, og et vindue på 2 timer åbnes → `/adgang/opsaet`. Mail til medarbejderen.
- **Chefen nulstiller en anden** (ikke sig selv): kræver en kode fra chefens app, højst 15 minutter gammel (ellers vises et kodefelt). Faktorerne, medarbejderens aal2-sessioner og ubrugte koder slettes, og en ny tilmelding på 24 timer åbnes. Logges (`to_trin_nulstillet`), mail til medarbejderen.
- **Chefen åbner tilmelding** (ny medarbejder eller udløbet vindue): 24 timer, samme krav til frisk kode, logges (`to_trin_tilmelding_aabnet`), mail.
- **Forlader en medarbejder staff** (rollen fjernes): triggeren sætter `aktiv = false` og lukker vinduet.

## Databasen (migration A)
`20261027010000_staff_to_trin.sql` – idempotent, harmløs (intet uden for den nye kode læser tabellerne):
- `staff_to_trin` (bruger_id, aktiv, faktor_ider uuid[], opsat_kl, tilmelding_aaben_til, tilmelding_aabnet_af, nulstillet_kl, nulstillet_af) og `staff_gendannelseskoder` (kun sha256-hash med bruger-id). RLS slået til, kun service_role.
- `min_staff_adgang()` og `staff_aal2_ok(p_maks_timer)` for authenticated (ud fra `auth.uid()`, `auth.jwt()` og `auth.mfa_factors`).
- Service-role: `staff_to_trin_aabn_tilmelding`, `staff_to_trin_aktiver`, `staff_to_trin_nulstil`, `staff_gendan_brug` (+ hjælperne `staff_to_trin_aktiv`, `staff_to_trin_ukendte_faktorer`, `staff_to_trin_ryd_auth`). `postgres` har delete-rettighed på `auth.sessions` og `auth.mfa_factors` (tjekket på testdatabasen 19. okt. 2026), så nulstillingen sletter selv faktorerne og kun sessioner med `aal = 'aal2'`.
- Trigger `users_staff_to_trin_rolle` og 4 nye værdier i `moderation_log_handling_check` (flettet ind; md5 før var `20470dc11b09bc4558a37a28a33a5ec8` i både prod og test).
- 14 dages vindue for nuværende staff (`on conflict do nothing`). **De 14 dage regnes fra kørslen** – kør den lige før `ADMIN_VAERT` sættes.

## Udrulning (Filip)
1. Kør migration A i produktion (dit "ja"). Den er kørt to gange på testdatabasen.
2. Slå TOTP til i Supabase → Authentication → Multi-Factor → "TOTP (App Authenticator)" (enroll + verify). Testdatabasen ("Bidhamr Test") har det allerede slået til (tjekket 19. okt. med et `mfa.enroll`). Produktion ("Hamr") skal slås til.
3. Vercel (Production): `ADMIN_VAERT=admin.bidhamr.dk` og `NEXT_PUBLIC_ADMIN_URL=https://admin.bidhamr.dk`. Tilføj domænet `admin.bidhamr.dk` til samme projekt (Settings → Domains) og DNS hos domæneudbyderen. Redeploy (begge variabler skal med i buildet).
4. Du sætter selv to-trins-login op først og gemmer gendannelseskoderne (fx i 1Password).
5. Al staff sætter to-trins-login op inden for 14 dage. Har nogen ikke nået det, åbner du et vindue på 24 timer under Medarbejdere.
6. `ADMIN_LUK_HOVEDDOMAENE=omdiriger` i 2 uger, derefter `=1`. Redeploy efter hvert skift (Vercel bruger først nye værdier efter en ny deploy).
7. Vercel Firewall: kun DK/EU for `admin.bidhamr.dk` og en rate limit på `/adgang` (se HUSKELISTE.md).

Rul tilbage: slet `ADMIN_VAERT` (og `ADMIN_LUK_HOVEDDOMAENE`) og redeploy – så er admin på bidhamr.dk/admin igen uden to-trins-login. Tabellerne kan blive liggende.

## Nødudgang: "Låst ude af admin"
Kan ingen chef komme ind (fx Filip har mistet både telefon og gendannelseskoder), så kør i Supabase → SQL Editor på det rigtige projekt (byt id'et):
```sql
-- 1. Slet faktorerne (appen og bidhamr.dk påvirkes ikke).
delete from auth.mfa_factors where user_id = '<bruger-id>';
-- 2. Nulstil to-trins-login og åbn en tilmelding på 24 timer.
update public.staff_to_trin
   set aktiv = false, faktor_ider = '{}', nulstillet_kl = now(),
       tilmelding_aaben_til = now() + interval '24 hours', opdateret_kl = now()
 where bruger_id = '<bruger-id>';
delete from public.staff_gendannelseskoder where bruger_id = '<bruger-id>';
```
Log derefter ind på admin.bidhamr.dk og sæt en ny app op. Brug kun nødudgangen på en verificeret person – det er en ændring i produktion.

## Kendte konsekvenser (testet på testdatabasen 19. okt. 2026)
- **Appen fungerer for en medarbejder med en faktor.** Password-login via supabase-js giver aal1 (`nextLevel: aal2`), og RLS, RPC'er og læsning virker som før.
- **VIGTIGT: Supabase logger brugerens aal1-sessioner ud, hver gang en kode bekræftes** (`mfa.challengeAndVerify` – både ved opsætning og ved hvert login i admin, også efter 12 timer). Appens og bidhamr.dk's refresh-token afvises bagefter (`refresh_token_not_found`); access-tokenet virker højst en time endnu. En medarbejder bliver altså logget ud af appen og hovedsitet, når han logger ind i admin. Det er Supabase Auths egen regel og kan ikke slås fra i koden. Hvis det er uacceptabelt, kræver det en beslutning (fx egen TOTP-kontrol på serveren i stedet for Supabase MFA – så findes aal2 ikke i JWT'en, og migration B skal laves anderledes).
- **Skift af adgangskode:** Supabase afviser `updateUser({ password })` fra en aal1-session for en bruger med en faktor (`401 insufficient_aal`). Det rammer staff i appen (`POST /api/konto/adgangskode`), på Min konto og efter "Glemt adgangskode". Nu:
  - "Glemt adgangskode" virker: er sessionen beviseligt fra mail-linket (amr `otp`/`recovery` højst 1 time gammel), sættes adgangskoden med admin-API'et (`saetAdgangskodeEfterMaillink` i `src/lib/adgangskodeSkift.ts`). Alle sessioner logges ud, som før.
  - Min konto og appen svarer "Du har to-trins-login som medarbejder. Brug "Glemt adgangskode" …" (appen: `403 genlog_ind`). Fra en aal2-session (admin) virker `updateUser` direkte.
  - Brugere uden faktor er uberørte.
- Chefens nulstilling sletter præcis medarbejderens aal2-sessioner; appens aal1-session lever videre (testet).
- `auth.admin.mfa.deleteFactor` logger ikke sessioner ud – derfor sletter databasen selv aal2-sessionerne ved nulstilling og gendannelse.
- En ny kode opdaterer `amr`-tidsstemplet for `totp` i sessionen, så 12-timers-reglen virker uden nyt login.

## Migration B (RLS med aal2 i `er_staff()`) – IKKE skrevet endnu
Hentet fra testdatabasen 19. okt. 2026 (`pg_policies` og `pg_proc` med execute for authenticated).

**Policies, der bruger staff-rollen:**

| Tabel | Policy | Udtryk |
|---|---|---|
| andenchance_tilbud | andenchance_select_part (SELECT) | `byder_id = auth.uid() or er_staff()` |
| auctions | auctions_select_authenticated (SELECT) | synlig, egen, `er_staff()` eller `auktion_arkiv_adgang` |
| betaling_afvigelser | betaling_afvigelser_select_chef (SELECT) | `min_rolle() = 'chef'` |
| betalinger | betalinger_select_part (SELECT) | køber, sælger eller `min_rolle() = 'chef'` |
| employee_complaints | _select_chef / _update_chef | `min_rolle() = 'chef'` |
| forsendelse_haendelser | forsendelse_haendelser_select_parter | `er_staff()` eller part |
| forsendelser | forsendelser_select_parter | `er_staff()` eller part |
| handel_levering | handel_levering_select_parter | `er_staff()` eller part |
| messages | messages_select_part | `er_staff()` eller part |
| trades | trades_select_own | part eller `er_staff()` |

Storage-policies via funktioner: `pakke_billeder_laes_parter`, `sag_billeder_laes_parter`, `fragt_labels_laes`, `beta_fejl_billeder_upload_egen` (+ upload-policies for sag/pakke/erhverv-klage).

**Funktioner for authenticated, der læser rollen:** `antal_aabne_sager()`, `antal_ubesvarede_staff_samtaler()`, `auktion_arkiv_adgang(uuid)`, `auktion_spoergsmaal_liste(uuid)`, `beta_fejl_billede_maa_uploade(text)`, `er_staff()`, `fragt_label_maa_laese(text)`, `hent_medarbejdere()`, `min_profil()`, `min_rolle()`, `mine_forsendelse_label(uuid)`, `mit_leveringsvalg(uuid)`, `pakke_billede_maa_laese(text)`, `sag_billede_maa_laese(text)`.

**Hvad går i stykker på hovedsitet og i appen, hvis `er_staff()` kræver aal2:**
- Staff ser ikke længere skjulte/arkiverede auktioner eller auktioner under kunst-kontrol på auktionssiden (404, medmindre de selv er part) – det er ønsket; de skal bruge "Åbn i admin".
- Staff ser kun egne handler, beskeder, forsendelser og leveringsvalg i appen og på hovedsitet.
- Skjulte spørgsmål vises ikke for staff på auktionssiden (`auktion_spoergsmaal_liste`).
- **"Meld fejl" for staff før lancering** (upload af skærmbillede via `beta_fejl_billede_maa_uploade`) holder op med at virke på hovedsitet – skal undtages eller kun tjekke rollen.
- `min_rolle()` og `min_profil()` MÅ IKKE kræve aal2: proxyens gate før lancering, rolle-cookien, topbarens "Admin"-link og `hentStaffAdgang` bruger dem. Ændres de, kan staff ikke komme forbi gaten på hovedsitet eller i appen (præcis fejlen fra 7. okt.).
- Policies med `min_rolle() = 'chef'` (betalinger, afvigelser, klager) bør skifte til et aal2-tjek, hvis de skal med – chefen ser så kun egne betalinger på hovedsitet.
- Admin selv påvirkes ikke: admin-sider og -handlinger bruger service-role-klienten (`createAdminClient`).
- Forslag: `er_staff()` → `er_staff() and staff_aal2_ok()` kun i policies (ikke i `min_rolle`), og en egen hjælper til de få steder, staff skal kunne noget på hovedsitet (Meld fejl).

## Test
- Lokalt: kopiér `.env.local`, sæt `ADMIN_VAERT=admin.localhost` og `NEXT_PUBLIC_ADMIN_URL=http://admin.localhost:3000`, og kør `npm run dev`. Admin: http://admin.localhost:3000, hovedsitet: http://localhost:3000 (testdatabasen). `allowedDevOrigins` er ikke nødvendig – dev-serveren tillader selv `*.localhost`.
- Enhedstests: `tests/enhed/adminVaert.test.ts`, `adminGate.test.ts` (routing-matrix host × sti × metode × session × rolle gennem den rigtige proxy), `hentStaffAdgang.test.ts`, `staffToTrin.test.ts` (regler og gendannelseskoder).
- PGlite: `tests/penge-db/staffToTrin.test.ts` (kørt to gange, rettigheder, trigger, nulstilling, gendannelse, aktivering).
- Browser-test (Chrome, 19. okt. 2026, testdatabasen): opsætning, login med kode, forkert kode, chefens nulstilling, gendannelseskode, log ud, ikke-staff afvist, admin-cookie sendes ikke til localhost, "Åbn i admin"-links på hovedsitet.
- Snyd: "Nulstil to-trins-login"-action-id'et postet uden Origin til hovedhosten (`/auktioner` og `/admin/medarbejdere`) med hovedsitets cookie → `{"fejl":"Du har ikke adgang til at gøre dette."}`; til admin-hosten med hovedsitets cookie → 401/afvist; med hovedsitets aal1-token kopieret ind som admin-cookie → 401 "Kræver to-trins-login"; `X-Forwarded-Host: admin…` mod hovedhosten → 404. Intet blev nulstillet.
