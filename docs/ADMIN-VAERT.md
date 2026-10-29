# Admin på egen adresse (admin.bidhamr.dk) og to-trins-login for staff

Filips beslutninger 19. okt. 2026 (ROADMAP-BESLUTNINGER.md, "Admin på admin.bidhamr.dk"). Indsnævrer beslutningen fra 7. okt.: **brugere har stadig intet to-trins-login**, men **staff skal bruge to-trins-login (Supabase MFA TOTP) på admin.bidhamr.dk**. Intet uden for admin-hosten kræver aal2 – der er ingen `db_pre_request` (det var den, der lukkede appen 7. okt., commit `b674cf7`).

## Kort fortalt
- Samme Vercel-projekt. `ADMIN_VAERT=admin.bidhamr.dk` slår det til; uden den virker alt som før (admin på `/admin`, intet to-trins-login).
- På admin-hosten: kun `/admin*`, `/adgang*`, Next' egne filer, ikoner og `robots.txt` (Disallow). Alt andet giver 404. `/` sender til `/admin`.
- Admin har sin egen session-cookie (host-only `__Host-bh-admin-auth`), så hovedsitets session aldrig sendes til admin, og omvendt.
- Login: e-mail + adgangskode → koden fra app'en (TOTP) → admin. En ny kode kræves efter 12 timer (`STAFF_TO_TRIN_MAKS_TIMER`, 1-12; højere værdier bruges som 12 og giver en drift-fejl ved start).
- Hver admin-side og -handling tjekker fire ting (`hentStaffAdgang` i `src/lib/adminAuth.ts`): admin-hosten, aal2 med en frisk kode, databasen (aktiv og ingen ukendte faktorer) og rollen.

## Arkitektur

| Del | Fil |
|---|---|
| Host, links og cookie | `src/lib/adminVaert.ts` – `erAdminVaert(host)` (præcis sammenligning af `Host` uden port, små bogstaver, ignorerer `x-forwarded-host`, aldrig `*.vercel.app` i produktion), `adminUrl`, `adminAbsolutUrl` (mails), `hovedsiteUrl` (links fra admin til bidhamr.dk), `adminCookieOptions` |
| Proxy | `src/proxy.ts` deler tidligt: `erAdminVaert(host)` → `adminGate` (`src/lib/supabase/middleware.ts`), ellers `updateSession` som før. Reglerne er rene funktioner i `src/lib/adminGateRegler.ts` |
| Supabase-klienter | `server.ts`, `client.ts` og proxyen bruger `cookieOptions.name` = admin-cookien på admin-hosten, ellers Supabases standard |
| Adgangstjek | `src/lib/adminAuth.ts` – `hentStaffAdgang()`; `assertRole`, `kraevSideRolle`, `getStaffRole`, `assertErhverv`, `kraevErhvervSide`, `getErhvervRolle` er lag ovenpå. Reglerne: `vurderStaffAdgang` i `src/lib/staffToTrinRegler.ts` |
| Login-sider | `src/app/adgang/{login,kode,opsaet,gendan}` (uden admin-layoutet). Handlingerne er **route handlers** `POST /adgang/api/<handling>` (`src/app/adgang/api/[handling]/route.ts`, logikken i `src/lib/adgang.ts`) – ikke server actions. Kun samme Origin, JSON, højst 4 KB |
| Browser-klientens cookie | Root-layoutet skriver `<meta name="bh-admin-cookie">` på admin-hosten; `src/lib/supabase/client.ts` vælger cookie ud fra den, så browser og server altid er enige |
| Opstartstjek | `src/instrumentation.ts` logger i drift (`logDriftFejl`), hvis kun én af `ADMIN_VAERT`/`NEXT_PUBLIC_ADMIN_URL` er sat, eller de ikke passer sammen (`adminKonfigFejl`) |
| Chefens knapper | Admin → Medarbejdere: "Nulstil to-trins-login" og "Åbn tilmelding (24 t)" (`src/app/actions/adminToTrin.ts`, `src/components/admin/ToTrinHandling.tsx`) |
| Server-hjælpere | `src/lib/staffToTrin.ts` (faktorer via admin-API'et, gendannelseskoder, sikkerhedsmails), mails i `src/lib/mails/staffToTrin.ts` |
| Database | `supabase/migrations/20261027010000_staff_to_trin.sql` (migration A), `20261027020000_staff_rls_aal2.sql` (migration B, RLS med aal2) – rollback: `supabase/rollback/20261027020000_staff_rls_aal2.sql` |
| Staff-visning af en auktion | `src/app/admin/auktioner/[id]/page.tsx` – også skjulte, arkiverede og kunst-afventende (service role). Admin linker hertil i stedet for til auktionssiden |
| CSP | `lavCsp(nonce, "admin")` i `src/lib/csp.ts`: ingen Stripe, Google, Apple Pay eller kortfliser; `frame-src 'none'` |

### Proxyen på admin-hosten
- `/admin*` uden session → `/adgang/login?naeste=…` (GET) / 401. Ikke staff → 404. aal1 eller en kode ældre end grænsen → `/adgang/kode?naeste=…` / 401. Rollen `saelger` kun `/admin/erhverv*`.
- `/adgang*`: GET for alle. Andre metoder kun til route handlerne `/adgang/api/*` (en route handler kan ikke køre server actions, så et vilkårligt action-id kan ikke postes til login-siderne uden om gaten før lancering – heller ikke af en `saelger`). Og kun uden session eller for staff med aal1/en for gammel kode; fuldt inde (frisk aal2) → 403. `/adgang/api/logud` altid.
- **En admin-cookie uden gyldige claims** (forfalsket, udløbet og ikke fornyelig, logget ud andetsteds) ryddes altid, og alt andet end GET/HEAD får 401 – aldrig fail open til "uden session".
- **Tilbage (kendt):** en `saelger` med frisk aal2 kan poste et vilkårligt action-id til `/admin/erhverv*` før lancering – præcis som på bidhamr.dk i dag (proxyen kan ikke skelne action-id'er). Det kræver et tjek i selve brugerhandlingerne (fx i `hentLoggetIndBruger`) og er ikke lavet her.
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
- **Første gang (opsæt):** login → `/adgang/opsaet` (kun i et åbent tilmeldingsvindue) → **"Send kode til min e-mail"**: en 6-cifret engangskode (gælder 15 min., kun hashen gemmes, højst 5 forsøg pr. kode og 3 mails pr. 15 min.) – adgangskoden alene er ikke nok til at sætte en app op → "Start": serveren sletter alle gamle faktorer og laver en ny TOTP (`mfa.enroll`) → QR-kode og hemmelighed → første kode (`mfa.challengeAndVerify`, aal2) → serveren tjekker faktorerne med `auth.admin.mfa.listFactors` (ukendte slettes, drift-alarm) → `staff_to_trin_aktiver` (aktiv, faktoren gemmes, vinduet lukkes, 10 gendannelseskoder) → koderne vises én gang (kopiér/hent som fil) → sikkerhedsmail.
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
- Engangskoden på mail før opsætning: kolonnerne `mail_kode_hash`, `mail_kode_udloeber_kl`, `mail_kode_forsoeg`, `mail_bekraeftet_kl` og RPC'erne `staff_to_trin_mail_kode_gem`/`_tjek` (service_role). `staff_to_trin_aktiver` afviser (`mail_mangler`) uden en mail-bekræftelse, der højst er 30 minutter gammel.
- `staff_to_trin_nulstil` kræver et staff-mål (gerne en anden chef).
- 7 dages vindue for nuværende staff (`on conflict do nothing`). **De 7 dage regnes fra kørslen** – kør den lige før `ADMIN_VAERT` sættes.
- `moderation_log_handling_check` efter migrationen: md5 `ee2d44c457c60644a8762febd38d0bdb` (testdatabasen 19. okt. 2026; produktion får den samme, hvis den stadig er `20470dc1…` før).
- Rækkefølge i produktion: `20261026010000_boost_pakker.sql` før `20261027010000_staff_to_trin.sql`.

## Udrulning (Filip)
1. Kør migration A i produktion (dit "ja"). Den er kørt to gange på testdatabasen.
2. Slå TOTP til i Supabase → Authentication → Multi-Factor → "TOTP (App Authenticator)" (enroll + verify). Testdatabasen ("Bidhamr Test") har det allerede slået til (tjekket 19. okt. med et `mfa.enroll`). Produktion ("Hamr") skal slås til.
3. Vercel (Production): `ADMIN_VAERT=admin.bidhamr.dk` og `NEXT_PUBLIC_ADMIN_URL=https://admin.bidhamr.dk`. Tilføj domænet `admin.bidhamr.dk` til samme projekt (Settings → Domains) og DNS hos domæneudbyderen. Redeploy (begge variabler skal med i buildet).
4. Du sætter selv to-trins-login op først og gemmer gendannelseskoderne (fx i 1Password).
5. Al staff sætter to-trins-login op inden for 7 dage. Har nogen ikke nået det, åbner du et vindue på 24 timer under Medarbejdere.
6. `ADMIN_LUK_HOVEDDOMAENE=omdiriger` i 2 uger, derefter `=1`. Redeploy efter hvert skift (Vercel bruger først nye værdier efter en ny deploy).
7. Vercel Firewall: kun DK/EU for `admin.bidhamr.dk` og en rate limit på `/adgang` (se HUSKELISTE.md).
8. Migration B (`20261027020000_staff_rls_aal2.sql`, dit "ja") – **først når al staff har to-trins-login aktivt** (Admin → Medarbejdere) og efter `20261027010000` og trin 3. Se "Migration B" nedenfor.

Rul tilbage: slet `ADMIN_VAERT` (og `ADMIN_LUK_HOVEDDOMAENE`) og redeploy – så er admin på bidhamr.dk/admin igen uden to-trins-login. Tabellerne kan blive liggende.

## Spærret ude af login-loftet ("For mange forsøg")
Loftet pr. e-mail (10 forsøg pr. 15 min. fra alle IP'er) gælder ikke fra en enhed, hvor medarbejderen har gennemført to-trins-loginet (koden fra app'en) inden for 90 dage. På en **ny enhed** kan en medarbejder blive spærret ude, hvis nogen gætter løs på e-mailen. Udvejen: chefen trykker **"Nulstil login-loft"** ud for medarbejderen under Admin → Medarbejdere (kræver en frisk kode fra chefens app). Tællerne slettes, og loftet pr. e-mail gælder ikke for kontoen i 30 minutter, eller til medarbejderen har gennemført to-trins-loginet. Adgangskoden, koden fra app'en og lofterne pr. IP gælder stadig. Handlingen står i medarbejderloggen. Er det chefen selv: vent op til 15 minutter, eller slet tælleren i SQL Editor: `delete from public.rate_limits where noegle in ('admin_login_email:<e-mail med små bogstaver>', 'admin_gendan_email:<e-mail med små bogstaver>');`

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

## Vigtigt: hvad to-trins-login IKKE beskytter
**Indtil migration B er kørt, beskytter to-trins-login kun admin-siderne – ikke staff-adgang via API'et.** RLS og databasefunktionerne kender kun rollen, så en medarbejder med kun adgangskoden (aal1) kan læse det, staff-rollen giver adgang til, direkte via Supabase (appen, supabase-js). Migration B lukker det (se nedenfor).

## Anbefaling til Filips beslutning: separate admin-konti
Supabase logger en medarbejders app- og bidhamr.dk-sessioner ud, hver gang han skriver en kode i admin (se næste afsnit). Anbefalingen er **separate admin-konti**: hver medarbejder har én konto med staff-rollen, der kun bruges til admin.bidhamr.dk (med to-trins-login), og sin almindelige private konto til appen. Så rammer udlogningen ikke den daglige app-brug, og en lækket app-adgangskode er ikke en admin-adgangskode. Det kræver ingen kode – kun at chefen giver rollen til en ny konto (fx `fornavn.admin@bidhamr.dk`) og fjerner den fra den private. Filip beslutter.

## Kendte konsekvenser (testet på testdatabasen 19. okt. 2026)
- **Appen fungerer for en medarbejder med en faktor.** Password-login via supabase-js giver aal1 (`nextLevel: aal2`), og RLS, RPC'er og læsning virker som før.
- **VIGTIGT: Supabase logger brugerens aal1-sessioner ud, hver gang en kode bekræftes** (`mfa.challengeAndVerify` – både ved opsætning og ved hvert login i admin, også efter 12 timer). Appens og bidhamr.dk's refresh-token afvises bagefter (`refresh_token_not_found`); access-tokenet virker højst en time endnu. En medarbejder bliver altså logget ud af appen og hovedsitet, når han logger ind i admin. Det er Supabase Auths egen regel og kan ikke slås fra i koden. Hvis det er uacceptabelt, kræver det en beslutning (fx egen TOTP-kontrol på serveren i stedet for Supabase MFA – så findes aal2 ikke i JWT'en, og migration B skal laves anderledes).
- **Skift af adgangskode:** Supabase afviser `updateUser({ password })` fra en aal1-session for en bruger med en faktor (`401 insufficient_aal`). Det rammer staff i appen (`POST /api/konto/adgangskode`), på Min konto og efter "Glemt adgangskode". Nu:
  - "Glemt adgangskode" virker: er sessionen beviseligt fra mail-linket (amr `otp`/`recovery` højst 1 time gammel), sættes adgangskoden med admin-API'et (`saetAdgangskodeEfterMaillink` i `src/lib/adgangskodeSkift.ts`). Alle sessioner logges ud, som før. **Åbent punkt fra review:** reviewer ønsker kun `recovery`. Test 19. okt.: hjemmesidens link (token_hash → `verifyOtp`, `/auth/callback`) giver amr `otp`, ikke `recovery`; PKCE-vejen kunne ikke testes (Supabases mailgrænse `over_email_send_rate_limit`). Kun `recovery` ville derfor lukke "Glemt adgangskode" for staff – afventer beslutning.
  - Min konto og appen svarer "Du har to-trins-login som medarbejder. Brug "Glemt adgangskode" …" (appen: `403 genlog_ind`). Fra en aal2-session (admin) virker `updateUser` direkte.
  - Brugere uden faktor er uberørte.
- Chefens nulstilling sletter præcis medarbejderens aal2-sessioner; appens aal1-session lever videre (testet).
- `auth.admin.mfa.deleteFactor` logger ikke sessioner ud – derfor sletter databasen selv aal2-sessionerne ved nulstilling og gendannelse.
- En ny kode opdaterer `amr`-tidsstemplet for `totp` i sessionen, så 12-timers-reglen virker uden nyt login.

## Migration B (RLS med aal2) – `20261027020000_staff_rls_aal2.sql`
Staff-PRIVILEGIER i databasen (se andres data, skjulte auktioner, læse staff-filer, skrive i staff-tabeller) kræver `staff_aal2_ok()` fra migration A: aal2, to-trins-login aktivt i `staff_to_trin`, ingen ukendte faktorer og en kode højst 12 timer gammel. Uden det opfører en medarbejder sig præcis som en almindelig bruger – egne data virker. **Ingen `db_pre_request`** (fejlen fra 7. okt.). `min_rolle()` og `min_profil()` er uændrede (gaten, rolle-cookien, topbaren, `hentStaffAdgang` og appen bruger dem); migrationen afbryder, hvis de er ændret. Service-role-funktioner med `p_staff`/`p_chef` er uændrede.

**Kør den først, når al staff har to-trins-login aktivt**, efter `20261026010000` og `20261027010000`, og når `ADMIN_VAERT` er sat og deployet. En medarbejder uden aktivt to-trins-login mister med det samme staff-adgangen i databasen.

Listen er lavet forfra 20. okt. 2026 med SELECT i både produktion og test (ens): alle `pg_policies` inkl. storage, og alle funktioner, som `authenticated` kan kalde, og som bruger `er_staff`, rollen eller `min_rolle` (også indirekte via `staff_chat_har_rolle`/`erhverv_har_adgang`).

**Ændret** (md5 = normaliseret `prosrc`, hhv. permissive|cmd|roller|using|check uden mellemrum og `public.`):

| Objekt | Før | Efter | md5 før | md5 efter |
|---|---|---|---|---|
| `er_staff()` | rollen | rollen **og** `staff_aal2_ok()` | `c60104d50290ed101923d4bb3d059840` | `f87987aa4d8ca499b7cd5cf90fbf31ad` |
| `auktion_spoergsmaal_liste(uuid)` | `staff_chat_har_rolle(auth.uid(), 'medarbejder')` | `er_staff()` | `38fc55bfba916542f7448e67aaf8bd6e` | `ac39193832d11e663ecbc536355f85bb` |
| `beta_fejl_billede_maa_uploade(text)` | `er_staff()` | rollen (eget skærmbillede i egen mappe, som `maaMeldeBetaFejl`) | `5a107368fca910d964b4cbfda56c7c78` | `1eef75deb6b4193a474f807a3851edc9` |
| `firma_faktura_salg(...)` | chef ser andre firmaer | chef kun med `staff_aal2_ok()` (eget firma uændret) | `3e19eebfe328958da847fde4c09febc8` | `7ffab70526bf6f5e5af9d4c8310d7550` |
| policy `betaling_afvigelser_select_chef` | `min_rolle() = 'chef'` | `(select min_rolle()) = 'chef' and (select staff_aal2_ok())` | `c881bce9511c07a33de7f08341ab9f3d` | `ed7ceff41575845b759f455dd7c20ddb` |
| policy `betalinger_select_part` | køber, sælger eller `min_rolle() = 'chef'` | køber, sælger eller chef med aal2 | `b6ee707d622710484e14086b0e01ade6` | `278297185e39392396a5bd88934000ad` |
| policy `employee_complaints_select_chef` | `min_rolle() = 'chef'` | chef med aal2 | `e17d2d7d9152046c5a00c81f4a6b4fe0` | `55342f176933d9e188d6ee2056a542e5` |
| policy `employee_complaints_update_chef` | `min_rolle() = 'chef'` | chef med aal2 | `9daecf0383eeb2863ceb1c9723d0f9a1` | `c9efc546fd91142b99848f90d1cf6cf3` |
| policy `trades_select_own` | `... OR er_staff()` (pr. række) | `(select public.er_staff())` (én gang pr. forespørgsel) | `5acc25bf245a92e1288475f1d2d607dc` | `2e89c2643eaa450ea0393cf576d1df5c` |
| policy `messages_select_part` | `er_staff() OR (part)` | `(select public.er_staff()) or (part)` | `debbc4a7f61cf249e5a71bdef365f86e` | `023c3a5ab71305dac0fa6349b5f28d23` |
| policy `forsendelser_select_parter` | `er_staff() OR (part)` | `(select public.er_staff()) or (part)` | `9efa06f6919426346483181c255aaca8` | `ab6c6b1d352f25cdeed87e813e2b204e` |
| policy `forsendelse_haendelser_select_parter` | `er_staff() OR (part)` | `(select public.er_staff()) or (part)` | `152a46d690321bbea1f65955743a1a41` | `62cb6822f345370151e2cd43b7d3b7e2` |
| policy `handel_levering_select_parter` | `er_staff() OR (part)` | `(select public.er_staff()) or (part)` | `9120622c45684afd1c0751f02dd887f5` | `3b4b7fc55aa1bd3db404a472e2dc8095` |
| policy `andenchance_select_part` | `... OR er_staff()` | `byder_id = auth.uid() or (select public.er_staff())` | `b91b0b0a4f1c3f76c5405b7ae278aa5b` | `8b0272a18879686a9bbb036c80761865` |

`er_staff()` havde forskellig formatering i produktion (flere linjer) og test (én linje) med samme normaliserede md5; den skrives derfor helt (`pg_temp.fn_ret`). De tre andre rettes på stedet (`pg_temp.ps_ret`, CR fjernes først – produktion har CRLF). Policies: `pg_temp.pol_ret`. Alt i én transaktion; et uventet md5 afbryder, og intet ændres.

De seks policies med `er_staff()` får aal2 via `er_staff()`; omskrivningen til `(select ...)` er kun for ydelsen (review 20. okt.).

**Arver aal2 via `er_staff()`** (selve funktionen/policyen er uændret): policy `auctions_select_authenticated` (har allerede `(select er_staff())`; også via `auktion_arkiv_adgang`); storage `fragt_labels_laes`, `pakke_billeder_laes_parter`, `sag_billeder_laes_parter` (via `*_maa_laese`); funktionerne `antal_aabne_sager`, `antal_ubesvarede_staff_samtaler`, `auktion_arkiv_adgang`, `fragt_label_maa_laese`, `hent_medarbejdere`, `mine_forsendelse_label`, `mit_leveringsvalg`, `pakke_billede_maa_laese`, `sag_billede_maa_laese` og indirekte `app_auktion_synlig` → `auktion_budhistorik`, `auktion_saelger_kan_saelge`, `rapporter_auktion`.

**Uændret med vilje:** `min_rolle()` (`2e2b6b44f51252f5f292c9748367800c`), `min_profil()` (`5a4b00fa8869ba98b0c54fc56efca1c3`), `min_staff_adgang`, `staff_aal2_ok`; upload-policies for sag/pakke/erhverv-klage (intet staff-tjek); `min_returfragt`, `mit_ikke_afhentet`, `forbudte_varer`, `mine_data_grund`, `konto_sletning_blokeringer_grund` (ordet "rolle", intet privilegium).

**Hovedsitet og appen efter migration B:**
- Admin-siderne bruger service role (`kraevSideRolle`/`assertRole`) og er upåvirkede. Det eneste admin-kald med brugerens egen klient er badge-tallet `antal_ubesvarede_staff_samtaler` (`src/app/actions/staffChat.ts`) – på admin-hosten er det admin-cookiens aal2-session, så det virker. `STAFF_TO_TRIN_MAKS_TIMER` har et loft på 12 (`toTrinMaksTimer`, databasen kræver en kode højst 12 timer gammel); start-tjekket (`src/instrumentation.ts`) logger en drift-fejl, hvis den er sat over 12 eller ugyldig. Fragt-labels signeres altid med service role.
- Staff ser skjulte, arkiverede og kunst-afventende auktioner og skjulte spørgsmål kun i admin: ny side `/admin/auktioner/[id]` (alle staff-roller fra medarbejder) med billeder, sælger, priser, status og link til spørgsmålene. Alle admin-links til auktioner (rapporter, sager, handler, betalinger, penge, ubetalte, bedømmelser, boost, DSA-placering) peger dertil.
- Auktionssiden: kan en medarbejder/admin/chef ikke se auktionen (aal1), sender layoutet til `adminUrl("/admin/auktioner/<id>")` i stedet for 404. "Åbn auktionen i admin" peger på samme side (før `/admin/auktioner?q=`, som kun admin+ kunne åbne).
- "Meld fejl" før lancering virker for staff uden aal2 (rollen alene, egen mappe).
- Mine handler, beskeder, kvitteringer, chat osv. på hovedsitet filtrerer allerede eksplicit på køber/sælger – uændret.
- Appen (`bidhamr-app`, gennemgået 20. okt. 2026) bruger ingen staff-privilegier: kun `min_profil` og `auktion_spoergsmaal_liste` (egne data) og egne handler/billeder.

**Tilbagerulning:** `prod-koersel/rollback-20261027020000.sql` (gitignored kopi til Filip) = `supabase/rollback/20261027020000_staff_rls_aal2.sql`. Kør den som én forespørgsel i SQL Editor. Samme md5-tjek baglæns ("gammel" = efter B, "ny" = før B); den gendanner præcis de gamle kroppe og policies (testet i PGlite og på testdatabasen 20. okt.: alle md5 tilbage til "før"). De gamle kroppe står også i kommentaren øverst i migrationen. Migration B kan køres igen bagefter.

## Test
- Lokalt: kopiér `.env.local`, sæt `ADMIN_VAERT=admin.localhost` og `NEXT_PUBLIC_ADMIN_URL=http://admin.localhost:3000`, og kør `npm run dev`. Admin: http://admin.localhost:3000, hovedsitet: http://localhost:3000 (testdatabasen). `allowedDevOrigins` er ikke nødvendig – dev-serveren tillader selv `*.localhost`.
- Enhedstests: `tests/enhed/adminVaert.test.ts`, `adminGate.test.ts` (routing-matrix host × sti × metode × session × rolle gennem den rigtige proxy), `hentStaffAdgang.test.ts`, `staffToTrin.test.ts` (regler og gendannelseskoder).
- PGlite: `tests/penge-db/staffToTrin.test.ts` (kørt to gange, rettigheder, trigger, nulstilling, gendannelse, aktivering).
- PGlite migration B: `tests/penge-db/staffRlsAal2.test.ts` med de rigtige funktioner/policies fra før (`tests/penge-db/fixtures/staff_rls_foer_20261027020000.sql`): `er_staff()` kun ved aal2 + aktivt + frisk kode, RLS på alle 10 tabeller (aal1 kun egne, aal2 alle), storage-funktioner og -policies, `min_rolle`/`min_profil` uændrede, md5-tjekket afviser en uventet krop/policy (og ruller tilbage), kørt to gange, rollback.
- Migration B på testdatabasen 20. okt. 2026: kørt to gange, rollback kørt og B kørt igen. Snyd med chefens aal1-token mod PostgREST: `trades` 1 (egne) af 502, `messages` 0 af 14, `betalinger` 1 af 489, `handel_levering`/`forsendelser`/`forsendelse_haendelser` 0, `betaling_afvigelser` 0 af 15, skjulte/arkiverede auktioner 0 af 453; med aal2 alle. `er_staff` false/true, `min_rolle` "chef" begge. Storage `sign` på andres label/pakke-/sagsbillede: aal1 400, aal2 200.
- Browser-test (Chrome, 19. okt. 2026, testdatabasen): opsætning, login med kode, forkert kode, chefens nulstilling, gendannelseskode, log ud, ikke-staff afvist, admin-cookie sendes ikke til localhost, "Åbn i admin"-links på hovedsitet.
- Snyd: "Nulstil to-trins-login"-action-id'et postet uden Origin til hovedhosten (`/auktioner` og `/admin/medarbejdere`) med hovedsitets cookie → `{"fejl":"Du har ikke adgang til at gøre dette."}`; til admin-hosten med hovedsitets cookie → 401/afvist; med hovedsitets aal1-token kopieret ind som admin-cookie → 401 "Kræver to-trins-login"; `X-Forwarded-Host: admin…` mod hovedhosten → 404. Intet blev nulstillet.
