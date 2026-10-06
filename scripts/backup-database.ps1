<#
.SYNOPSIS
  Logisk backup af BidHamrs Supabase-database (roller, schema, data) + Storage-filer.

.DESCRIPTION
  Følger Supabases egen vejledning (supabase db dump x3). Læser kun fra databasen.
  Resultatet lægges i en datomærket mappe UDEN FOR git, fx
    C:\Users\jeppe\BidHamr-backups\prod\2026-10-06\
  med roles.sql, schema.sql, data.sql, migrationshistorik, kontroltal.json,
  storage\<bucket>\... og sha256.txt.

  Hemmeligheder læses fra en lokal fil, som Filip selv udfylder (aldrig i git):
    C:\Users\jeppe\.bidhamr\backup-prod.env   (eller backup-test.env)
  med linjerne
    DB_URL=postgresql://postgres.<ref>:<adgangskode>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
    SUPABASE_URL=https://<ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=<service_role-nøgle>
  Miljøvariablerne BIDHAMR_DB_URL, BIDHAMR_SUPABASE_URL og BIDHAMR_SERVICE_ROLE_KEY
  vinder over filen.

  Kræver: Node (npx) og Docker Desktop, der kører (Supabase CLI kører pg_dump i Docker).

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
  [switch]$UdenDatabase
)

$ErrorActionPreference = 'Stop'
$ForventetRef = @{ prod = 'lkifkrexeldimmghnsie'; test = 'pjiigmzqwlfepxnjdvug' }[$Miljoe]
if (-not $Indstillinger) { $Indstillinger = Join-Path $env:USERPROFILE ".bidhamr\backup-$Miljoe.env" }
$RepoRod = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
# Supabase CLI-version låses, så en ny CLI ikke pludselig ændrer dump-formatet.
$SupabaseCli = 'supabase@2'

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
$ServiceKey = if ($env:BIDHAMR_SERVICE_ROLE_KEY) { $env:BIDHAMR_SERVICE_ROLE_KEY } else { $vaerdier['SUPABASE_SERVICE_ROLE_KEY'] }
$script:Hemmeligheder = @($DbUrl, $ServiceKey)
if ($DbUrl -match '://[^:]+:([^@]+)@') { $script:Hemmeligheder += $matches[1] }

if (-not $UdenDatabase) {
  if (-not $DbUrl) { Stop-Med "DB_URL mangler. Udfyld $Indstillinger (se docs\backup.md)." }
  if ($DbUrl -notmatch [regex]::Escape($ForventetRef)) {
    Stop-Med "DB_URL peger ikke på $Miljoe-projektet ($ForventetRef). Tjek $Indstillinger."
  }
}
if (-not $UdenStorage) {
  if (-not $ApiUrl -or -not $ServiceKey) { Stop-Med "SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY mangler i $Indstillinger (eller brug -UdenStorage)." }
  if ($ApiUrl -notmatch [regex]::Escape($ForventetRef)) { Stop-Med "SUPABASE_URL peger ikke på $Miljoe-projektet ($ForventetRef)." }
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
    @{ fil = 'data.sql'; args = @('--use-copy', '--data-only', '-x', 'storage.buckets_vectors', '-x', 'storage.vector_indexes') },
    @{ fil = 'migrationshistorik_schema.sql'; args = @('--schema', 'supabase_migrations') },
    @{ fil = 'migrationshistorik_data.sql'; args = @('--use-copy', '--data-only', '--schema', 'supabase_migrations') }
  )
  foreach ($t in $trin) {
    Log "Dumper $($t.fil) ..."
    $sti = Join-Path $Mappe $t.fil
    $kode = Koer 'npx' (@('--yes', $SupabaseCli, 'db', 'dump', '--db-url', $DbUrl, '-f', $sti) + $t.args)
    if ($kode -ne 0 -or -not (Test-Path $sti) -or (Get-Item $sti).Length -eq 0) {
      Log "FEJL: $($t.fil) blev ikke lavet (exit $kode)."
      $fejl++
    }
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
  $env:SUPABASE_SERVICE_ROLE_KEY = $ServiceKey
  try {
    $kode = Koer 'node' @((Join-Path $PSScriptRoot 'backup-storage.mjs'), (Join-Path $Mappe 'storage'))
  } finally {
    Remove-Item Env:SUPABASE_URL, Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
  }
  if ($kode -ne 0) { Log "FEJL: Storage-backup fejlede (exit $kode)."; $fejl++ }
}

# --- Tjeksummer ----------------------------------------------------------------
$tjek = Get-ChildItem -Path $Mappe -Recurse -File | Where-Object { $_.Name -ne 'sha256.txt' -and $_.Name -ne 'backup.log' } |
  ForEach-Object { '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.FullName.Substring($Mappe.Length + 1) }
$tjek | Set-Content -Path (Join-Path $Mappe 'sha256.txt') -Encoding UTF8
$mb = [math]::Round(((Get-ChildItem $Mappe -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 2)

if ($fejl) { Log "Backup FÆRDIG MED $fejl FEJL ($mb MB): $Mappe"; exit 1 }
Log "Backup OK ($mb MB): $Mappe"
Log 'Husk: kopiér mappen til et sted uden for denne pc (ekstern disk/sky). Den indeholder persondata.'
exit 0
