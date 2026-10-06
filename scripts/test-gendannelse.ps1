<#
.SYNOPSIS
  Tester at en backup fra backup-database.ps1 kan gendannes - på en LOKAL, midlertidig Supabase.

.DESCRIPTION
  Scriptet tager INGEN forbindelsesstreng og kan derfor ikke ramme produktion eller testdatabasen.
  Det gør følgende:
    0. Er backuppen krypteret (backup.7z), pakkes den ud til en midlertidig mappe
       med adgangskoden fra C:\Users\jeppe\.bidhamr\backup-kode.txt (-KodeFil).
       Koden gives til 7-Zip på standard input. Mappen slettes igen til sidst.
    1. Starter en tom, lokal Supabase i Docker i en midlertidig mappe (egne porte 553xx).
    2. Indlæser roles.sql, schema.sql og data.sql som i Supabases vejledning
       (én transaktion, ON_ERROR_STOP, triggere slået fra under data-indlæsning).
       cron.sql (cron-jobs) indlæses ALDRIG.
    3. Sletter i samme psql-kald - både før og efter data.sql, også med
       -UdenEnTransaktion - alle pg_cron-jobs og ventende pg_net-kald, så den
       gendannede kopi ALDRIG kan kalde bidhamr.dk eller andre rigtige tjenester.
    4. Tæller rækker i alle tabeller og sammenligner med kontroltal.json fra backuppen.
    5. Stopper og sletter den lokale instans igen (medmindre -BeholdInstans).

  Docker-porte: Supabase CLI kan ikke binde portene til 127.0.0.1 alene (ingen
  indstilling i config.toml eller supabase start). Instansen kører kun under
  testen og har standard-adgangskoden "postgres". Kør derfor testen på et
  netværk, du stoler på (ikke offentligt wifi), og brug kun -BeholdInstans kort.
  Vil du være helt sikker, kan Docker Desktop sættes til at binde alle porte til
  127.0.0.1 ("ip": "127.0.0.1" i Docker Engine-indstillingerne).

  Kræver: Node (npx), Docker Desktop, der kører, og 7-Zip til krypterede backups.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-gendannelse.ps1
  (bruger den nyeste backup under C:\Users\jeppe\BidHamr-backups\prod)
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-gendannelse.ps1 -Backup C:\Users\jeppe\BidHamr-backups\prod\2026-10-06
#>
param(
  [string]$Backup = '',
  [ValidateSet('prod', 'test')]
  [string]$Miljoe = 'prod',
  [string]$BackupRod = (Join-Path $env:USERPROFILE 'BidHamr-backups'),
  [string]$Arbejdsmappe = (Join-Path $env:TEMP 'bidhamr-gendannelsestest'),
  [switch]$BeholdInstans,
  [switch]$UdenEnTransaktion,
  [string]$KodeFil = (Join-Path $env:USERPROFILE '.bidhamr\backup-kode.txt')
)

$ErrorActionPreference = 'Stop'
# Samme præcise version som backup-database.ps1.
$SupabaseCli = 'supabase@2.119.0'
$ProjektId = 'bidhamr-gendannelsestest'
$DbContainer = "supabase_db_$ProjektId"
$script:Udpakket = $null

function Log([string]$tekst) { Write-Host ('{0:HH:mm:ss} {1}' -f (Get-Date), $tekst) }
# Sletter den midlertidige, ukrypterede udpakning (indeholder persondata).
function Ryd-Udpakning {
  if ($script:Udpakket -and (Test-Path $script:Udpakket)) {
    Remove-Item -Recurse -Force $script:Udpakket -ErrorAction SilentlyContinue
    if (Test-Path $script:Udpakket) { Log "ADVARSEL: Kunne ikke slette $($script:Udpakket) - slet mappen selv." }
    else { Log 'Midlertidig udpakning slettet.' }
  }
  $script:Udpakket = $null
}
function Stop-Med([string]$tekst) { Log "FEJL: $tekst"; Ryd-Udpakning; exit 1 }
function Koer([string]$program, [string[]]$argumenter) {
  $gammel = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $program @argumenter 2>&1 | ForEach-Object { Write-Host "  $_" }
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $gammel }
}

# --- Find backup -------------------------------------------------------------
if (-not $Backup) {
  $seneste = Get-ChildItem -Path (Join-Path $BackupRod $Miljoe) -Directory -ErrorAction SilentlyContinue |
    Where-Object { (Test-Path (Join-Path $_.FullName 'backup.7z')) -or (Test-Path (Join-Path $_.FullName 'data.sql')) } |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $seneste) { Stop-Med "Ingen backup fundet under $(Join-Path $BackupRod $Miljoe). Kør backup-database.ps1 først." }
  $Backup = $seneste.FullName
}
$Backup = (Resolve-Path $Backup).Path
# Mappen, hvor resultatet noteres (den rigtige backup-mappe, ikke udpakningen).
$BackupMappe = $Backup
Log "Tester gendannelse af $Backup"

# --- Krypteret backup: pak ud til en midlertidig mappe ---------------------------
$arkiv = Join-Path $Backup 'backup.7z'
if (Test-Path $arkiv) {
  $SyvZip = $null
  foreach ($k in @((Get-Command '7z.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
                   (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
                   (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe'))) {
    if ($k -and (Test-Path $k)) { $SyvZip = $k; break }
  }
  if (-not $SyvZip) { Stop-Med 'Backuppen er krypteret (backup.7z), men 7-Zip er ikke installeret. Installér det fra https://www.7-zip.org.' }
  if (-not (Test-Path $KodeFil)) { Stop-Med "Adgangskodefilen mangler: $KodeFil (se docs\backup.md)." }
  $script:Udpakket = Join-Path $env:TEMP ('bidhamr-gendan-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $script:Udpakket | Out-Null
  Log "Pakker backup.7z ud til $($script:Udpakket) ..."
  $ud = [IO.Path]::GetTempFileName(); $fejlUd = [IO.Path]::GetTempFileName()
  try {
    # Ingen -p: 7-Zip spørger selv om koden og læser den fra standard input.
    $p = Start-Process -FilePath $SyvZip -ArgumentList @('x', '-y', '-bsp0', ('"-o' + $script:Udpakket + '"'), ('"' + $arkiv + '"')) `
      -RedirectStandardInput (Resolve-Path $KodeFil).Path -RedirectStandardOutput $ud -RedirectStandardError $fejlUd `
      -NoNewWindow -Wait -PassThru
    $kode = $p.ExitCode
    if ($kode -ne 0) { foreach ($l in (@(Get-Content $ud) + @(Get-Content $fejlUd))) { if ("$l".Trim()) { Log "  $l" } } }
  } finally { Remove-Item $ud, $fejlUd -Force -ErrorAction SilentlyContinue }
  if ($kode -ne 0) { Stop-Med "Kunne ikke pakke backup.7z ud (exit $kode). Forkert adgangskode i $KodeFil?" }
  $Backup = $script:Udpakket
}

foreach ($f in 'roles.sql', 'schema.sql', 'data.sql', 'kontroltal.json') {
  if (-not (Test-Path (Join-Path $Backup $f))) { Stop-Med "$f mangler i $Backup" }
}

# Tjeksummer (hvis de findes) - opdager en ødelagt eller ændret backupfil.
$shaFil = Join-Path $Backup 'sha256.txt'
if (Test-Path $shaFil) {
  $forkert = 0
  foreach ($l in Get-Content $shaFil) {
    if ($l -match '^([0-9a-f]{64})  (.+)$') {
      $sti = Join-Path $Backup $matches[2]
      if (-not (Test-Path $sti) -or (Get-FileHash $sti -Algorithm SHA256).Hash.ToLower() -ne $matches[1]) {
        Log "  Tjeksum passer ikke: $($matches[2])"; $forkert++
      }
    }
  }
  if ($forkert) { Stop-Med "$forkert fil(er) i backuppen er ændret eller ødelagt." }
  Log '  Tjeksummer OK'
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-Med 'Docker er ikke installeret. Installér Docker Desktop (se docs\backup.md).' }
if ((Koer 'docker' @('info', '--format', '{{.ServerVersion}}')) -ne 0) { Stop-Med 'Docker kører ikke. Start Docker Desktop.' }

# --- Tom lokal Supabase --------------------------------------------------------
$projektMappe = Join-Path $Arbejdsmappe $ProjektId
if (Test-Path $projektMappe) {
  Push-Location $projektMappe
  try { Koer 'npx' @('--yes', $SupabaseCli, 'stop', '--no-backup') | Out-Null } finally { Pop-Location }
  Remove-Item -Recurse -Force $projektMappe
}
New-Item -ItemType Directory -Force -Path $projektMappe | Out-Null
Push-Location $projektMappe
$resultat = 1
try {
  Log 'Opretter tom lokal Supabase ...'
  # Minimal config: tom database (ingen migrationer/seed), egne porte (553xx), kun det nødvendige.
  New-Item -ItemType Directory -Force -Path (Join-Path $projektMappe 'supabase') | Out-Null
  @"
project_id = "$ProjektId"

[api]
port = 55321

[db]
port = 55322
shadow_port = 55320
major_version = 17

[db.seed]
enabled = false

[studio]
enabled = false

[inbucket]
enabled = false

[analytics]
enabled = false

[edge_runtime]
enabled = false
"@ | Set-Content -Path (Join-Path $projektMappe 'supabase\config.toml') -Encoding ASCII
  Log 'Starter lokal Supabase (første gang hentes Docker-images, det kan tage flere minutter) ...'
  if ((Koer 'npx' @('--yes', $SupabaseCli, 'start')) -ne 0) { Stop-Med 'supabase start fejlede.' }

  $navn = (& docker ps --filter "name=^$DbContainer$" --format '{{.Names}}' | Select-Object -First 1)
  if ($navn -ne $DbContainer) { Stop-Med "Fandt ikke den lokale database-container $DbContainer." }

  # --- Indlæs backup ---------------------------------------------------------
  # Køres både FØR og EFTER data.sql i samme psql-kald (også med
  # -UdenEnTransaktion). Nye backups har slet ikke cron-jobs i data.sql (de
  # ligger i cron.sql, som aldrig indlæses her); ældre backups kan have dem.
  $sikkerhed = Join-Path $projektMappe 'efter-data.sql'
  @'
-- Gendannet kopi må aldrig kalde rigtige tjenester (cron -> bidhamr.dk, pg_net -> webhooks).
do $$
begin
  if to_regclass('cron.job') is not null then delete from cron.job; end if;
  if to_regclass('net.http_request_queue') is not null then delete from net.http_request_queue; end if;
end $$;
'@ | Set-Content -Path $sikkerhed -Encoding UTF8

  Koer 'docker' @('exec', $DbContainer, 'rm', '-rf', '/tmp/gendan') | Out-Null
  Koer 'docker' @('exec', $DbContainer, 'mkdir', '-p', '/tmp/gendan') | Out-Null
  foreach ($f in 'roles.sql', 'schema.sql', 'data.sql') {
    if ((Koer 'docker' @('cp', (Join-Path $Backup $f), "${DbContainer}:/tmp/gendan/$f")) -ne 0) { Stop-Med "Kunne ikke kopiere $f ind i containeren." }
  }
  Koer 'docker' @('cp', $sikkerhed, "${DbContainer}:/tmp/gendan/efter-data.sql") | Out-Null

  Log 'Indlæser roles.sql, schema.sql og data.sql ...'
  $psql = @('exec', '-e', 'PGPASSWORD=postgres', $DbContainer, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1')
  if (-not $UdenEnTransaktion) { $psql += '--single-transaction' }
  $psql += @('-f', '/tmp/gendan/roles.sql', '-f', '/tmp/gendan/schema.sql',
    '-f', '/tmp/gendan/efter-data.sql',
    '-c', 'SET session_replication_role = replica', '-f', '/tmp/gendan/data.sql',
    '-f', '/tmp/gendan/efter-data.sql')
  if ((Koer 'docker' $psql) -ne 0) {
    Stop-Med 'Gendannelsen fejlede (se fejlen ovenfor). Prøv evt. igen med -UdenEnTransaktion for at se alle fejl, og se "Fejlfinding" i docs\backup.md.'
  }

  # --- Sammenlign optællinger ------------------------------------------------
  $kontrol = Get-Content (Join-Path $Backup 'kontroltal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $navne = @($kontrol.tabeller.PSObject.Properties.Name)
  if (-not $navne.Count) { Stop-Med 'kontroltal.json indeholder ingen tabeller.' }
  $dele = foreach ($n in $navne) {
    $s, $t = $n.Split('.', 2)
    "select '$n' as t, count(*) as n from `"$s`".`"$t`""
  }
  $sqlFil = Join-Path $projektMappe 'optaelling.sql'
  (($dele -join "`nunion all ") + ';') | Set-Content -Path $sqlFil -Encoding UTF8
  Koer 'docker' @('cp', $sqlFil, "${DbContainer}:/tmp/gendan/optaelling.sql") | Out-Null
  $gammel = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $raekker = & docker exec -e PGPASSWORD=postgres $DbContainer psql -h 127.0.0.1 -U postgres -d postgres -At -F '|' -f /tmp/gendan/optaelling.sql 2>&1
  $kode = $LASTEXITCODE; $ErrorActionPreference = $gammel
  if ($kode -ne 0) { $raekker | ForEach-Object { Log "  $_" }; Stop-Med 'Optællingen fejlede.' }

  $gendannet = @{}
  foreach ($r in $raekker) { if ("$r" -match '^(.+)\|(\d+)$') { $gendannet[$matches[1]] = [long]$matches[2] } }

  $afvigelser = 0
  foreach ($n in $navne) {
    $forventet = [long]$kontrol.tabeller.$n
    $faktisk = if ($gendannet.ContainsKey($n)) { $gendannet[$n] } else { -1 }
    if ($faktisk -ne $forventet) { Log ("  AFVIGELSE {0}: backup {1}, gendannet {2}" -f $n, $forventet, $faktisk); $afvigelser++ }
  }
  Log 'Centrale tabeller (backup = gendannet):'
  foreach ($n in 'auth.users', 'public.users', 'public.auctions', 'public.bids', 'public.trades', 'public.betalinger', 'public.transactions') {
    if ($gendannet.ContainsKey($n)) { Log ("  {0,-22} {1}" -f $n, $gendannet[$n]) } else { Log ("  {0,-22} (ikke i backup)" -f $n) }
  }
  if ($afvigelser) { Log "GENDANNELSE FEJLEDE: $afvigelser tabel(ler) afviger." }
  else { Log "GENDANNELSE OK: alle $($navne.Count) tabeller har samme antal rækker som ved backup."; $resultat = 0 }

  # Notér testen i backup-mappen, så man kan se hvornår backuppen sidst er bevist gendannelig.
  Add-Content -Path (Join-Path $BackupMappe 'gendannelsestest.log') -Encoding UTF8 -Value ('{0:o} {1} ({2} tabeller, {3} afvigelser)' -f (Get-Date), $(if ($resultat -eq 0) { 'OK' } else { 'FEJL' }), $navne.Count, $afvigelser)
} finally {
  if (-not $BeholdInstans) {
    Log 'Stopper og sletter den lokale instans ...'
    Koer 'npx' @('--yes', $SupabaseCli, 'stop', '--no-backup') | Out-Null
  } else {
    Log "Lokal instans kører stadig: postgresql://postgres:postgres@127.0.0.1:55322/postgres (stop: cd $projektMappe; npx $SupabaseCli stop --no-backup)"
  }
  Pop-Location
  # Den ukrypterede udpakning slettes altid (også ved fejl). Data ligger nu
  # kun i den lokale instans, som slettes ovenfor (medmindre -BeholdInstans).
  Ryd-Udpakning
}
exit $resultat
