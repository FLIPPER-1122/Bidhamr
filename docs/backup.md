# Backup af databasen

Handelsdata må aldrig gå tabt. Bogføringsloven kræver, at regnskabsmateriale (handler, betalinger, gebyrer) gemmes i **5 år fra udgangen af regnskabsåret**, og DAC7-indberetningerne bygger på de samme data. Backup er derfor ikke valgfrit.

## Hvad Supabase selv gør (status 6. okt. 2026)

Produktionsprojektet **Hamr** (`lkifkrexeldimmghnsie`) ligger i organisationen **Hamr** på **Free-planen**.

| | Free (nu) | Pro | Pro + PITR |
|---|---|---|---|
| Daglig backup | Supabase tager dem måske, men **du kan ikke se, hente eller gendanne dem** før du opgraderer. Supabase skriver selv, at det kan stoppe | Ja, de seneste **7 dage** | Erstattes af PITR |
| Gendan til et bestemt tidspunkt | Nej | Nej, kun til en daglig backup (man kan miste op til et døgn) | Ja, ned til sekunder (højst ca. 2 minutters tab) |
| Hente backup ned selv | Kun med `supabase db dump` (vores script) | Samme. Fysiske backups kan ikke downloades | Samme |
| Storage-filer (billeder) | **Aldrig med i database-backup** | Aldrig med | Aldrig med |
| Pris | 0 kr. | 25 $/md. (ca. 175 kr.), inkl. 10 $ compute-kredit | 25 $ + ca. 15 $ (krævet Small compute) − 10 $ kredit + 100 $ (7 dages PITR) ≈ **130 $/md. (ca. 900 kr.)** |

Free-projekter sættes desuden på pause efter en uges inaktivitet, og Free har ingen garanti. Det dur ikke til en platform med rigtige handler.

Supabases egen anbefaling til Free-projekter er netop det, vores script gør: eksportér jævnligt med `supabase db dump` og gem kopien et andet sted.

## Størrelse (målt 6. okt. 2026)

- Database: **102 MB** i alt. Heraf er **82 MB** `cron.job_run_details` (loggen over cron-kørsler, 176.000 rækker siden juli). Selve BidHamr-dataene fylder under 5 MB (20 brugere, 15 auktioner, 7 handler).
- Storage: **ca. 6 MB** (16 auktionsbilleder, 1 avatar).
- Free-grænsen er 500 MB database og 1 GB filer. Cron-loggen bør ryddes jævnligt (fx slette rækker ældre end 14 dage), ellers æder den grænsen op. Det er en lille migration, som ikke er lavet endnu.

Et backup fylder i dag få MB og tager et par minutter.

## Anbefaling

1. **Nu:** kør vores eget backup-script hver uge og test gendannelse én gang om måneden. Det koster ingenting.
2. **Før lancering (fase 6):** opgradér organisationen til **Pro** (ca. 175 kr./md.). Så får du 7 dages daglige backups, som kan gendannes med ét klik, og projektet sættes ikke på pause.
3. **PITR (ca. 900 kr./md. i alt)** er først relevant, når der er så mange handler, at et døgns tab ville gøre ondt. Betalingerne ligger i Stripe, så de kan genskabes derfra, men bud, beskeder og sager kan ikke.
4. Behold vores eget script også efter Pro. Det er den eneste kopi, der ligger uden for Supabase og overlever, hvis projektet slettes ved en fejl. Supabase sletter nemlig også alle backups, når et projekt slettes. Det er også den eneste backup af billederne.

## Engangsopsætning (Filip)

1. Installér **Docker Desktop** (docker.com) og start det. Supabase CLI kører `pg_dump` inde i Docker. Node har du allerede.
2. Installér **7-Zip** (7-zip.org, standardplaceringen `C:\Program Files\7-Zip`). **Kryptering er et krav**: backuppen indeholder persondata, og scriptet stopper, før det henter noget, hvis 7-Zip mangler. (Alternativ: læg `BidHamr-backups` på et BitLocker-krypteret drev og kør med `-BitLocker`. Scriptet tjekker selv, at drevet er krypteret. Windows Home har ikke BitLocker.)
3. Lav adgangskodefilen `C:\Users\jeppe\.bidhamr\backup-kode.txt` i Notesblok med **én linje**: en lang, tilfældig adgangskode (mindst 16 tegn, kun A–Z, a–z, 0–9 og almindelige tegn som `-_!#`, ingen mellemrum eller æøå). Gem den som "UTF-8" (ikke "UTF-8 med BOM"). **Gem samme adgangskode i en password-manager**: uden den kan ingen backup åbnes, heller ikke efter et nedbrud på pc'en. Filen kan flyttes med linjen `BACKUP_KODE_FIL=<sti>` i `backup-prod.env`.
4. Lav filen `backup-prod.env` i samme mappe `C:\Users\jeppe\.bidhamr\` (Notesblok). Den ligger uden for repoet og kommer aldrig i git:
   ```
   DB_URL=postgresql://postgres.lkifkrexeldimmghnsie:DIN-DB-ADGANGSKODE@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
   SUPABASE_URL=https://lkifkrexeldimmghnsie.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=DIN-SECRET-/SERVICE_ROLE-NØGLE
   ```
   - `DB_URL`: Supabase → projektet Hamr → **Connect** → **Session pooler**. Kopiér strengen præcis, som den står (værtsnavnet kan afvige fra eksemplet). Har du glemt database-adgangskoden, kan den nulstilles under Database → Settings. Nulstilling påvirker ikke hjemmesiden, som bruger API-nøgler.
   - `SUPABASE_SERVICE_ROLE_KEY`: Settings → API Keys (secret key eller den gamle service_role). Den bruges kun til at hente billederne.
5. Lav evt. også `backup-test.env` med testprojektets værdier (`pjiigmzqwlfepxnjdvug`), så du kan prøve det hele af på testdatabasen først.

Scriptet stopper selv, hvis forbindelsesstrengen peger på et andet projekt end det valgte miljø.

Ingen hemmeligheder på kommandolinjen: database-adgangskoden tages ud af `DB_URL` og gives til Supabase CLI som miljøvariablen `PGPASSWORD`, og 7-Zip får adgangskoden via standard input fra `backup-kode.txt`. Supabase CLI er låst til en præcis version (`supabase@2.119.0`) i begge scripts. Opdatér den samme sted i begge, hvis den skal skiftes.

## Kør backup

```powershell
cd C:\Users\jeppe\Desktop\hamr
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-database.ps1 -Miljoe prod
```

Resultatet havner i `C:\Users\jeppe\BidHamr-backups\prod\ÅÅÅÅ-MM-DD\` som to filer:

| Fil | Indhold |
|---|---|
| `backup.7z` | Hele backuppen, AES-256-krypteret med adgangskoden fra `backup-kode.txt` (også filnavnene er krypteret). Se indholdet nedenfor |
| `backup.log` | Hvad der skete (ukrypteret, ingen persondata). Adgangskoder er skjult |

Indhold af `backup.7z`:

| Fil | Indhold |
|---|---|
| `roles.sql`, `schema.sql`, `data.sql` | Databasen, som beskrevet i Supabases vejledning. `data.sql` indeholder `auth.users`, `auth.identities` og `auth.mfa_factors` (logins; to-trins-login er fjernet, så tabellen er tom) og `storage.objects` (filernes metadata). **Ikke** med: login-sessioner og engangskoder (`auth.sessions`, `auth.refresh_tokens`, `auth.one_time_tokens`, `auth.flow_state`, `auth.mfa_challenges`, `auth.mfa_amr_claims`). De er kortlivede og ville give adgang til konti, så efter en gendannelse skal alle logge ind igen |
| `cron.sql` | Cron-jobbene (`cron.job`) for sig, uden kørselsloggen. Indlæses aldrig af gendannelsestesten |
| `migrationshistorik_*.sql` | Hvilke migrationer der er kørt |
| `kontroltal.json` | Antal rækker pr. tabel i backuppen, så gendannelsestesten kan sammenligne |
| `storage\<bucket>\...` | Alle filer fra Storage (auktionsbilleder, avatarer, sags- og pakkebilleder, fragtlabels) + `storage-manifest.json` |
| `sha256.txt` | Tjeksummer, så man kan opdage ødelagte filer |

De ukrypterede filer slettes, når arkivet er lavet og testet med adgangskoden. Fejler krypteringen, stopper scriptet med en fejl og skriver, hvor de ukrypterede filer ligger.

Til sidst skriver scriptet `Backup OK` (exit-kode 0) eller antal fejl (exit-kode 1). Flag: `-UdenStorage`, `-UdenDatabase`, `-BackupRod <mappe>`, `-BitLocker`.

Kopiér backup-mappen til en ekstern disk eller en privat sky-mappe, ikke kun til den samme pc. Gem mindst én backup pr. måned i 5 år, så handelsdata kan dokumenteres. Gamle ugentlige backups må gerne slettes, når månedens er gemt. Åbn et arkiv manuelt med 7-Zip (højreklik → 7-Zip → Udpak) og adgangskoden fra password-manageren, og slet den udpakkede mappe igen bagefter.

### Automatisk hver uge (Windows Opgavestyring)

Kør én gang i PowerShell:

```powershell
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\jeppe\Desktop\hamr\scripts\backup-database.ps1" -Miljoe prod'
$t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 20:00
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName 'BidHamr backup' -Action $a -Trigger $t -Settings $s
```

Opgaven kører kun, når du er logget ind og Docker Desktop kører. `-StartWhenAvailable` gør, at en opgave, der blev sprunget over, kører, næste gang pc'en er tændt. Under **Opgavestyring → BidHamr backup → Seneste kørselsresultat** skal der stå `0x0`. Fjern opgaven med `Unregister-ScheduledTask -TaskName 'BidHamr backup'`.

## Test gendannelse (hver måned)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-gendannelse.ps1
```

Scriptet tager den nyeste backup under `BidHamr-backups\prod` (eller `-Backup <mappe>`) og gør følgende:

1. Pakker `backup.7z` ud til en midlertidig mappe under `%TEMP%` med adgangskoden fra `backup-kode.txt` (`-KodeFil <sti>` for en anden fil). Mappen slettes igen til sidst, også hvis testen fejler.
2. Tjekker tjeksummerne.
3. Starter en **tom, lokal** Supabase i Docker på egne porte (55321/55322). Scriptet tager ingen forbindelsesstreng, så det kan ikke ramme produktion.
4. Indlæser roles, schema og data i én transaktion, præcis som Supabases vejledning beskriver. `cron.sql` indlæses aldrig.
5. Sletter i samme psql-kald, både før og efter data, alle cron-jobs og ventende HTTP-kald, så kopien aldrig kan kalde bidhamr.dk eller sende mails. Det gælder også med `-UdenEnTransaktion`.
6. Tæller rækker i **alle** tabeller og sammenligner med `kontroltal.json`. Til sidst står `GENDANNELSE OK` eller en liste over afvigelser.
7. Stopper og sletter den lokale instans. Med `-BeholdInstans` bliver den kørende, så du kan kigge i den på `postgresql://postgres:postgres@127.0.0.1:55322/postgres`.

Resultatet noteres i `gendannelsestest.log` i backup-mappen. Første kørsel henter Docker-images og tager 5–10 minutter.

**Docker-porte:** Supabase CLI kan ikke binde den lokale instans' porte til `127.0.0.1` alene. Docker åbner dem normalt på alle netværkskort, og adgangskoden er `postgres`. Kør derfor testen på et netværk, du stoler på (hjemme, ikke offentligt wifi), og brug kun `-BeholdInstans` kort. Vil du lukke helt af: Docker Desktop → Settings → Docker Engine → tilføj `"ip": "127.0.0.1"` og tryk Apply & restart.

### Fejlfinding

- Kør med `-UdenEnTransaktion` for at se alle fejl på én gang i stedet for kun den første.
- `permission denied to grant role "postgres"`: udkommentér linjen `GRANT "postgres" TO "cli_login_postgres" ...` i en kopi af `roles.sql`.
- `ALTER ... OWNER TO "supabase_admin"`-fejl: udkommentér de linjer i en kopi af `schema.sql`.
- Kolonner eller tabeller i `auth`/`storage`, som ikke findes lokalt: den lokale Supabase er ældre end platformen. Find nyeste version med `npm view supabase version`, ret `$SupabaseCli` i **begge** scripts (`backup-database.ps1` og `test-gendannelse.ps1`) og prøv igen.
- `Kunne ikke pakke backup.7z ud`: forkert adgangskode i `backup-kode.txt`, eller filen er gemt som "UTF-8 med BOM".

## Nødplan: databasen er væk eller ødelagt

1. **Bevar roen, og stop skrivninger.** Sæt hjemmesiden i vedligeholdelse (eller sæt Vercel-deployment på pause), så der ikke kommer nye bud og handler oven i et ødelagt datasæt. Lad Stripe køre: betalinger ligger sikkert dér.
2. **Find ud af hvad der er sket.** Er projektet slettet, sat på pause eller er data blot forkerte? Et projekt på pause gendannes under Supabase → projektet → **Restore project**. Prøv det først.
3. **På Pro:** Database → Backups → vælg den seneste daglige backup før uheldet → **Restore** (eller PITR til minuttet før). Projektet er nede imens. Spring derefter til trin 6.
4. **Ellers fra vores egen backup:**
   1. Kør først `test-gendannelse.ps1` på den nyeste backup, så du ved, at den virker. Pak derefter `backup.7z` ud med 7-Zip til en midlertidig mappe (fx `C:\Users\jeppe\gendan`), og brug den mappe i de næste trin. Slet den, når gendannelsen er færdig.
   2. Opret et nyt Supabase-projekt i region eu-west-1 (eller gendan i det eksisterende, hvis det stadig findes, men er tomt). Slå samme extensions til som før (pg_cron, pg_net m.fl.).
   3. Indlæs med psql mod det nye projekts Session pooler-streng. Det kan gøres via Docker, så du ikke behøver at installere Postgres:
      ```powershell
      cd C:\Users\jeppe\gendan
      docker run --rm -v "${PWD}:/b" postgres:17 psql "NY-DB-URL" --single-transaction -v ON_ERROR_STOP=1 -f /b/roles.sql -f /b/schema.sql -c "SET session_replication_role = replica" -f /b/data.sql
      docker run --rm -v "${PWD}:/b" postgres:17 psql "NY-DB-URL" --single-transaction -v ON_ERROR_STOP=1 -f /b/migrationshistorik_schema.sql -f /b/migrationshistorik_data.sql
      ```
   4. Indlæs cron-jobbene til sidst, når alt andet er på plads og Vault-hemmelighederne (`cron_url`, `cron_secret`) er sat: `... psql "NY-DB-URL" -v ON_ERROR_STOP=1 -f /b/cron.sql`. Mangler `cron.sql`, så kør cron-delene af migrationerne igen.
   5. Upload filerne fra `storage\` til de samme buckets med samme stier, fx med Supabases migrationsscript til Storage (se Supabase-guiden "Backup and Restore using the CLI").
5. **Hvis et nyt projekt blev oprettet:** opdatér Vercels miljøvariabler (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) og `.env.production.local`, auth-indstillinger (site-URL, redirect-URL'er, SMTP/Resend), Vault-hemmeligheder (fx `CRON_SECRET`) og Stripe-webhookens URL hvis nødvendigt. Opdatér appen (Expo) med den nye URL og nøgle. Brugerne skal logge ind igen.
6. **Tjek:** sammenlign antal brugere, auktioner, handler og betalinger med `kontroltal.json`. Tjek at cron-jobbene kører (`select * from cron.job`). Afstem betalinger i perioden mellem backup og uheld mod Stripe-dashboardet, og genskab manglende handler/betalinger ud fra Stripe.
7. **Fortæl brugerne,** hvis data fra en periode er tabt (fx bud eller beskeder). Er persondata kommet i forkerte hænder, skal Datatilsynet underrettes inden for 72 timer.
8. Skriv bagefter ned, hvad der skete, og tag en ny backup med det samme.
