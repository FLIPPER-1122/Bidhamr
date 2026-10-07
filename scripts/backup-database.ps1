<#
.SYNOPSIS
  Logisk backup af BidHamrs Supabase-database (roller, schema, data) + Storage-filer.

.DESCRIPTION
  Følger Supabases egen vejledning (supabase db dump x3). Læser kun fra databasen.
  Resultatet lægges i en datomærket mappe UDEN FOR git, fx
    C:\Users\jeppe\BidHamr-backups\prod\2026-10-06\
  Backuppen (roles.sql, schema.sql, data.sql, cron.sql, migrationshistorik,
  kontroltal.json, storage\<bucket>\... og sha256.txt) pakkes til sidst i et
  AES-256-krypteret 7-Zip-arkiv backup.7z (også filnavnene krypteres), og de
  ukrypterede filer slettes. Kun backup.log (ingen persondata) ligger ukrypteret.

  Kryptering er et KRAV. Adgangskoden læses fra en fil uden for repoet:
    C:\Users\jeppe\.bidhamr\backup-kode.txt   (kan ændres med BACKUP_KODE_FIL=...)
  Den gives til 7-Zip via standard input - aldrig på kommandolinjen.
  Er 7-Zip ikke installeret, stopper scriptet, før der hentes noget. Alternativ:
  -BitLocker, som kun accepteres, hvis backup-drevet er BitLocker-krypteret.

  Udeladt af data.sql: login-sessioner og engangskoder (auth.sessions,
  auth.refresh_tokens, auth.one_time_tokens, auth.flow_state, auth.mfa_challenges,
  auth.mfa_amr_claims) - de er kortlivede og ville give adgang til konti.
  auth.users, auth.identities og auth.mfa_factors er med (nødvendige for at
  gendanne login og to-trinsbekræftelse). Cron-jobs ligger i cron.sql for sig
  (cron.job_run_details tages ikke med), så en testgendannelse aldrig får jobs.

  Hemmeligheder læses fra en lokal fil, som Filip selv udfylder (aldrig i git):
    C:\Users\jeppe\.bidhamr\backup-prod.env   (eller backup-test.env)
  med linjerne
    DB_URL=postgresql://postgres.<ref>:<adgangskode>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
    SUPABASE_URL=https://<ref>.supabase.co
    SUPABASE_SECRET_KEY=<sb_secret_-nøgle>
  (den gamle linje SUPABASE_SERVICE_ROLE_KEY=<service_role-nøgle> virker også,
  så længe Supabases gamle nøgler er slået til; SUPABASE_SECRET_KEY vinder).
  Miljøvariablerne BIDHAMR_DB_URL, BIDHAMR_SUPABASE_URL og BIDHAMR_SECRET_KEY
  (eller den gamle BIDHAMR_SERVICE_ROLE_KEY) vinder over filen.

  Kræver: Node (npx), Docker Desktop, der kører (Supabase CLI kører pg_dump i
  Docker), og 7-Zip (7-zip.org).

  Database-adgangskoden fjernes fra DB_URL og gives til Supabase CLI som
  miljøvariablen PGPASSWORD, så den ikke står i proceslisten (kommandolinjen).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-database.ps1 -Miljoe prod
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-database.ps1 -Miljoe test -UdenStorage
#>
param(
  [ValidateSet('prod', 'test')]
  [string]$Miljoe = 'prod',
  [string]$BackupRod = (Join-Path $env:USERPROFILE 'BidHamr-backups'),
  [string]$Indstillinger = '',
  [switch]$UdenStorage,
  [switch]$UdenDatabase,
  # Ingen 7-Zip-kryptering - kun tilladt, når backup-mappen ligger på et
  # BitLocker-krypteret drev (tjekkes).
  [switch]$BitLocker
)

$ErrorActionPreference = 'Stop'
$ForventetRef = @{ prod = 'lkifkrexeldimmghnsie'; test = 'pjiigmzqwlfepxnjdvug' }[$Miljoe]
if (-not $Indstillinger) { $Indstillinger = Join-Path $env:USERPROFILE ".bidhamr\backup-$Miljoe.env" }
$RepoRod = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
# Supabase CLI-version låses præcist, så en ny CLI ikke pludselig ændrer
# dump-formatet. Skal være den samme som i test-gendannelse.ps1.
$SupabaseCli = 'supabase@2.119.0'

$script:Hemmeligheder = @()
function Skjul([string]$tekst) {
  foreach ($h in $script:Hemmeligheder) { if ($h) { $tekst = $tekst.Replace($h, '***') } }
  return $tekst
}
function Log([string]$tekst) {
  $linje = '{0:HH:mm:ss} {1}' -f (Get-Date), (Skjul $tekst)
  Write-Host $linje
  if ($script:LogFil) { Add-Content -Path $script:LogFil -Value $linje -Encoding UTF8 }
}
function Stop-Med([string]$tekst) { Log "FEJL: $tekst"; exit 1 }

# Kører et eksternt program, skjuler hemmeligheder i output og returnerer exit-koden.
function Koer([string]$program, [string[]]$argumenter) {
  $gammel = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $program @argumenter 2>&1 | ForEach-Object { Log "  $_" }
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $gammel }
}

# --- Indstillinger -----------------------------------------------------------
$vaerdier = @{}
if (Test-Path $Indstillinger) {
  foreach ($l in Get-Content $Indstillinger) {
    if ($l -match '^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$') { $vaerdier[$matches[1]] = $matches[2] }
  }
}
$DbUrl = if ($env:BIDHAMR_DB_URL) { $env:BIDHAMR_DB_URL } else { $vaerdier['DB_URL'] }
$ApiUrl = if ($env:BIDHAMR_SUPABASE_URL) { $env:BIDHAMR_SUPABASE_URL } else { $vaerdier['SUPABASE_URL'] }
$ServiceKey = if ($env:BIDHAMR_SECRET_KEY) { $env:BIDHAMR_SECRET_KEY }
  elseif ($env:BIDHAMR_SERVICE_ROLE_KEY) { $env:BIDHAMR_SERVICE_ROLE_KEY }
  elseif ($vaerdier['SUPABASE_SECRET_KEY']) { $vaerdier['SUPABASE_SECRET_KEY'] }
  else { $vaerdier['SUPABASE_SERVICE_ROLE_KEY'] }
$script:Hemmeligheder = @($DbUrl, $ServiceKey)
# Adgangskoden tages ud af forbindelsesstrengen og gives som PGPASSWORD (læses
# af Supabase CLI), så den ikke står på kommandolinjen, hvor andre processer
# kan se den.
$DbUrlUdenKode = $DbUrl
$DbKode = $null
if ($DbUrl -match '^(postgres(?:ql)?://)([^:@/]+):(.*)@([^@]+)$') {
  $DbUrlUdenKode = $matches[1] + $matches[2] + '@' + $matches[4]
  $DbKode = [Uri]::UnescapeDataString($matches[3])
  $script:Hemmeligheder += @($matches[3], $DbKode)
}

if (-not $UdenDatabase) {
  if (-not $DbUrl) { Stop-Med "DB_URL mangler. Udfyld $Indstillinger (se docs\backup.md)." }
  if ($DbUrl -notmatch [regex]::Escape($ForventetRef)) {
    Stop-Med "DB_URL peger ikke på $Miljoe-projektet ($ForventetRef). Tjek $Indstillinger."
  }
}
if (-not $UdenStorage) {
  if (-not $ApiUrl -or -not $ServiceKey) { Stop-Med "SUPABASE_URL eller SUPABASE_SECRET_KEY (eller SUPABASE_SERVICE_ROLE_KEY) mangler i $Indstillinger (eller brug -UdenStorage)." }
  if ($ApiUrl -notmatch [regex]::Escape($ForventetRef)) { Stop-Med "SUPABASE_URL peger ikke på $Miljoe-projektet ($ForventetRef)." }
}

# --- Kryptering (krav) - tjekkes, før der hentes noget -----------------------
$SyvZip = $null
foreach ($k in @((Get-Command '7z.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
                 (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
                 (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe'))) {
  if ($k -and (Test-Path $k)) { $SyvZip = $k; break }
}
$KodeFil = if ($vaerdier['BACKUP_KODE_FIL']) { $vaerdier['BACKUP_KODE_FIL'] } else { Join-Path $env:USERPROFILE '.bidhamr\backup-kode.txt' }

function BitLocker-Til([string]$sti) {
  # Virker uden administrator. 1 = BitLocker til.
  try {
    $drev = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($sti))
    $v = (New-Object -ComObject Shell.Application).NameSpace($drev).Self.ExtendedProperty('System.Volume.BitLockerProtection')
    return ($v -eq 1)
  } catch { return $false }
}

if ($SyvZip) {
  if (-not (Test-Path $KodeFil)) {
    Stop-Med "Adgangskodefilen til krypteringen mangler: $KodeFil. Lav den (se docs\backup.md) og gem adgangskoden i en password-manager."
  }
  $KodeFilFuld = (Resolve-Path $KodeFil).Path
  if ($KodeFilFuld.StartsWith($RepoRod, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Med "Adgangskodefilen må ikke ligge inde i repoet ($RepoRod)."
  }
  $bytes = [IO.File]::ReadAllBytes($KodeFilFuld)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Stop-Med "$KodeFil er gemt som 'UTF-8 med BOM'. Gem den igen i Notesblok som 'UTF-8' (uden BOM)."
  }
  $kodeLinje = ([Text.Encoding]::ASCII.GetString($bytes) -split "`r?`n")[0]
  if ($kodeLinje -cnotmatch '^[\x21-\x7E]{16,}$') {
    Stop-Med "Adgangskoden i $KodeFil skal være mindst 16 tegn uden mellemrum og uden æøå (kun A-Z, a-z, 0-9 og almindelige tegn)."
  }
  $script:Hemmeligheder += $kodeLinje
} elseif ($BitLocker) {
  if (-not (BitLocker-Til $BackupRod)) {
    Stop-Med "-BitLocker er angivet, men drevet for $BackupRod er ikke BitLocker-krypteret. Installér 7-Zip (7-zip.org) i stedet."
  }
} else {
  Stop-Med ('Backuppen indeholder persondata og SKAL krypteres. Installér 7-Zip fra https://www.7-zip.org (standardplacering C:\Program Files\7-Zip) ' +
    'og lav adgangskodefilen (se docs\backup.md) - eller læg backup-mappen på et BitLocker-krypteret drev og kør med -BitLocker.')
}

# Kører 7-Zip med adgangskoden på standard input (aldrig på kommandolinjen).
# Ved 'a' får 7-Zip -p uden værdi og spørger; ved 't'/'x' spørger 7-Zip selv.
function Koer-7z([string[]]$argumenter, [string]$arbejdsmappe) {
  $ud = [IO.Path]::GetTempFileName(); $fejlUd = [IO.Path]::GetTempFileName()
  $citeret = $argumenter | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_ + '"' } else { $_ } }
  try {
    $p = Start-Process -FilePath $SyvZip -ArgumentList $citeret -WorkingDirectory $arbejdsmappe `
      -RedirectStandardInput $KodeFilFuld -RedirectStandardOutput $ud -RedirectStandardError $fejlUd `
      -NoNewWindow -Wait -PassThru
    foreach ($l in (@(Get-Content $ud) + @(Get-Content $fejlUd))) { if ("$l".Trim()) { Log "  $l" } }
    return $p.ExitCode
  } finally { Remove-Item $ud, $fejlUd -Force -ErrorAction SilentlyContinue }
}

# --- Mappe uden for git ------------------------------------------------------
$BackupRodFuld = [IO.Path]::GetFullPath($BackupRod)
if ($BackupRodFuld.StartsWith($RepoRod, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-Med "Backup-mappen må ikke ligge inde i repoet ($RepoRod)."
}
$dato = Get-Date -Format 'yyyy-MM-dd'
$Mappe = Join-Path $BackupRodFuld (Join-Path $Miljoe $dato)
if (Test-Path $Mappe) { $Mappe = "$Mappe" + '_' + (Get-Date -Format 'HHmmss') }
New-Item -ItemType Directory -Force -Path $Mappe | Out-Null
$script:LogFil = Join-Path $Mappe 'backup.log'
Log "BidHamr-backup ($Miljoe, $ForventetRef) -> $Mappe"

$fejl = 0

# --- Database ----------------------------------------------------------------
if (-not $UdenDatabase) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-Med 'Docker er ikke installeret. Installér Docker Desktop (se docs\backup.md).' }
  if ((Koer 'docker' @('info', '--format', '{{.ServerVersion}}')) -ne 0) {
    Stop-Med 'Docker kører ikke. Start Docker Desktop og prøv igen (Supabase CLI bruger Docker til pg_dump).'
  }

  $trin = @(
    @{ fil = 'roles.sql'; args = @('--role-only') },
    @{ fil = 'schema.sql'; args = @() },
    @{ fil = 'data.sql'; args = @('--use-copy', '--data-only', '-x', 'storage.buckets_vectors', '-x', 'storage.vector_indexes',
        # Sessioner og engangskoder: kortlivede og giver adgang til konti.
        '-x', 'auth.refresh_tokens', '-x', 'auth.sessions', '-x', 'auth.one_time_tokens', '-x', 'auth.flow_state',
        '-x', 'auth.mfa_challenges', '-x', 'auth.mfa_amr_claims',
        # Cron-jobs i deres egen fil (cron.sql); loggen tages ikke med.
        '-x', 'cron.job', '-x', 'cron.job_run_details') },
    @{ fil = 'cron.sql'; args = @('--use-copy', '--data-only', '--schema', 'cron', '-x', 'cron.job_run_details'); valgfri = $true },
    @{ fil = 'migrationshistorik_schema.sql'; args = @('--schema', 'supabase_migrations') },
    @{ fil = 'migrationshistorik_data.sql'; args = @('--use-copy', '--data-only', '--schema', 'supabase_migrations') }
  )
  if ($DbKode) { $env:PGPASSWORD = $DbKode }
  try {
    foreach ($t in $trin) {
      Log "Dumper $($t.fil) ..."
      $sti = Join-Path $Mappe $t.fil
      $kode = Koer 'npx' (@('--yes', $SupabaseCli, 'db', 'dump', '--db-url', $DbUrlUdenKode, '-f', $sti) + $t.args)
      if ($kode -ne 0 -or -not (Test-Path $sti) -or (Get-Item $sti).Length -eq 0) {
        if ($t.valgfri) { Log "ADVARSEL: $($t.fil) blev ikke lavet (exit $kode). Cron-jobs kan genskabes fra migrationerne." }
        else { Log "FEJL: $($t.fil) blev ikke lavet (exit $kode)."; $fejl++ }
      }
    }
  } finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  }

  # Kontroltal: antal rækker pr. tabel, talt direkte i data.sql (COPY-blokke).
  $dataSti = Join-Path $Mappe 'data.sql'
  if (Test-Path $dataSti) {
    $tal = [ordered]@{}
    $aktuel = $null
    $reader = [IO.StreamReader]::new($dataSti, [Text.Encoding]::UTF8)
    try {
      while ($null -ne ($linje = $reader.ReadLine())) {
        if ($aktuel) {
          if ($linje -eq '\.') { $aktuel = $null } else { $tal[$aktuel]++ }
        } elseif ($linje -match '^COPY\s+("?[^"\s.]+"?\."?[^"\s(]+"?)\s.*FROM stdin;') {
          $aktuel = $matches[1].Replace('"', '')
          if (-not $tal.Contains($aktuel)) { $tal[$aktuel] = 0 }
        }
      }
    } finally { $reader.Close() }

    $kontrol = [ordered]@{
      lavet       = (Get-Date).ToString('o')
      miljoe      = $Miljoe
      projekt_ref = $ForventetRef
      tabeller    = $tal
    }
    $kontrol | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $Mappe 'kontroltal.json') -Encoding UTF8
    foreach ($n in 'auth.users', 'public.users', 'public.auctions', 'public.bids', 'public.trades', 'public.betalinger', 'public.transactions') {
      $v = if ($tal.Contains($n)) { $tal[$n] } else { '(ikke i dump!)' }
      Log ("  {0,-22} {1}" -f $n, $v)
    }
    if (-not $tal.Contains('public.trades') -or -not $tal.Contains('auth.users')) {
      Log 'FEJL: data.sql mangler centrale tabeller (auth.users/public.trades).'
      $fejl++
    }
  }
}

# --- Storage -----------------------------------------------------------------
if (-not $UdenStorage) {
  Log 'Henter Storage-filer ...'
  $env:SUPABASE_URL = $ApiUrl
  $env:SUPABASE_SECRET_KEY = $ServiceKey
  try {
    $kode = Koer 'node' @((Join-Path $PSScriptRoot 'backup-storage.mjs'), (Join-Path $Mappe 'storage'))
  } finally {
    Remove-Item Env:SUPABASE_URL, Env:SUPABASE_SECRET_KEY -ErrorAction SilentlyContinue
  }
  if ($kode -ne 0) { Log "FEJL: Storage-backup fejlede (exit $kode)."; $fejl++ }
}

# --- Tjeksummer ----------------------------------------------------------------
$tjek = Get-ChildItem -Path $Mappe -Recurse -File | Where-Object { $_.Name -ne 'sha256.txt' -and $_.Name -ne 'backup.log' } |
  ForEach-Object { '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.FullName.Substring($Mappe.Length + 1) }
$tjek | Set-Content -Path (Join-Path $Mappe 'sha256.txt') -Encoding UTF8
$mb = [math]::Round(((Get-ChildItem $Mappe -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 2)

# --- Kryptering ------------------------------------------------------------------
# Alt undtagen backup.log pakkes i backup.7z (AES-256, også filnavne). De
# ukrypterede filer slettes først, når arkivet er lavet OG testet med koden.
if ($SyvZip) {
  Log 'Krypterer backuppen med 7-Zip (AES-256) ...'
  $arkivTmp = "$Mappe.7z.tmp"
  Remove-Item $arkivTmp -Force -ErrorAction SilentlyContinue
  $kode = Koer-7z @('a', '-t7z', '-mhe=on', '-mx=5', '-p', '-bsp0', '-x!backup.log', $arkivTmp, '*') $Mappe
  if ($kode -eq 0) { $kode = Koer-7z @('t', '-bsp0', $arkivTmp) $Mappe }
  if ($kode -ne 0 -or -not (Test-Path $arkivTmp)) {
    Remove-Item $arkivTmp -Force -ErrorAction SilentlyContinue
    Log "FEJL: Krypteringen fejlede (exit $kode). De ukrypterede filer ligger stadig i $Mappe - slet dem selv, eller kør igen."
    exit 1
  }
  Get-ChildItem -Path $Mappe -Force | Where-Object { $_.Name -ne 'backup.log' } | Remove-Item -Recurse -Force
  Move-Item -Path $arkivTmp -Destination (Join-Path $Mappe 'backup.7z')
  $mb = [math]::Round(((Get-Item (Join-Path $Mappe 'backup.7z')).Length / 1MB), 2)
  Log 'Ukrypterede filer slettet. Tilbage: backup.7z og backup.log.'
} else {
  Log 'Ikke pakket med 7-Zip: backup-mappen ligger på et BitLocker-krypteret drev (-BitLocker).'
}

if ($fejl) { Log "Backup FÆRDIG MED $fejl FEJL ($mb MB): $Mappe"; exit 1 }
Log "Backup OK ($mb MB): $Mappe"
Log 'Husk: kopiér mappen til et sted uden for denne pc (ekstern disk/sky). Gem adgangskoden separat (password-manager) - uden den kan backuppen ikke åbnes.'
exit 0
