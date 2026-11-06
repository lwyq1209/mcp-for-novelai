// The update helper of Windows: a fixed PowerShell script that the app writes into the update's state folder and starts
// outside its own process tree (Win32_Process.Create, hidden) right before it quits (updater.ts). Its values are
// parameters of -File (bound as strings, never evaluated); the app checks them first.
//
//   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File helper.ps1 -State <dir> -AppPid <pid>
//     -Installer <setup.exe> -Sha256 <hex> -InstallDir <dir> -Exe <MCP for NovelAI.exe> -From <version> -To <version>
//     [-Background 0|1] [-ExitTimeout 300] [-ConfirmTimeout 120] [-OthersTimeout 15]
//
// Steps: write helper-pid; wait for the app to exit (never kills it; at most ExitTimeout s, else nothing changes),
// stopping at once, changing nothing, when the app withdraws the update meanwhile (its state folder or pending.json is
// gone: a batch arrived); wait until no other app of this installation runs (its main processes, not its MCP servers or
// Chromium's helper processes; at most OthersTimeout s): another copy that keeps running — an app with another data
// folder — makes it give up, because the installer would end it (it ends every process running from the installation
// folder; MCP servers of agents are ended too, which only breaks a call under way: the app no longer accepts work by
// then); check the installer's SHA-256 on disk once more; run it silently into the same folder (/S --updated
// /D=<folder>: the same per-user installation, shortcuts kept); check that the installed executable now has the new
// version (its FileVersion); start it (Win32_Process.Create, outside any job, with this helper's environment — what the
// system needs plus the data folder, environment.ts — and --updated-from=<from>); wait for its confirmed file. When the
// installer fails, whatever is installed is started again with --update-rolled-back=<to> (there is no rollback of its
// own: the installer leaves the old version in place when it stops before extracting; the app then says the update did
// not complete). Whenever it gives up it removes <data root>\runtime\updating.json.
export const WINDOWS_HELPER_SCRIPT = String.raw`# MCP for NovelAI update helper (Windows). Written and started by the app; see electron/update/helper-windows.ts.
param(
  [Parameter(Mandatory = $true)][string]$State,
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Sha256,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$From,
  [Parameter(Mandatory = $true)][string]$To,
  [int]$Background = 0,
  [int]$ExitTimeout = 300,
  [int]$ConfirmTimeout = 120,
  [int]$OthersTimeout = 15
)
$ErrorActionPreference = 'Continue'

function Write-Log([string]$Message) {
  try { Add-Content -LiteralPath (Join-Path $State 'helper.log') -Value ('{0} {1}' -f [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message) -Encoding UTF8 } catch { }
}
function Set-Mark([string]$Value) {
  try { Add-Content -LiteralPath (Join-Path $State 'helper-state') -Value $Value -Encoding ASCII } catch { }
  Write-Log ('state ' + $Value)
}
function Test-Alive([int]$Id) { return [bool](Get-Process -Id $Id -ErrorAction SilentlyContinue) }

function Start-App([string]$Argument) {
  $exePath = Join-Path $InstallDir $Exe
  if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { Write-Log 'the app executable is missing'; return $false }
  $show = 1
  if ($Background -eq 1) { $show = 4 }
  $environment = [string[]](Get-ChildItem Env: | ForEach-Object { $_.Name + '=' + $_.Value })
  # launch.args: extra arguments, one per line (rehearsal builds only); the app checked them (no quotes, no final backslash).
  $extra = @()
  $argsFile = Join-Path $State 'launch.args'
  if (Test-Path -LiteralPath $argsFile) { $extra = @(Get-Content -LiteralPath $argsFile | Where-Object { $_ -ne '' }) }
  $commandLine = '"' + $exePath + '" ' + $Argument + (($extra | ForEach-Object { ' "' + $_ + '"' }) -join '')
  try {
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]$show; EnvironmentVariables = $environment }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $InstallDir; ProcessStartupInformation = $startup }
    if ($result.ReturnValue -eq 0) { Write-Log ('started pid ' + $result.ProcessId); return $true }
    Write-Log ('Win32_Process.Create returned ' + $result.ReturnValue)
  } catch { Write-Log ('Win32_Process.Create failed: ' + $_.Exception.Message) }
  try { Start-Process -FilePath $exePath -ArgumentList (@($Argument) + $extra) -WorkingDirectory $InstallDir | Out-Null; return $true }
  catch { Write-Log ('Start-Process failed: ' + $_.Exception.Message); return $false }
}

if (-not (Test-Path -LiteralPath $State -PathType Container)) { exit 2 }
if ($Sha256 -notmatch '^[0-9a-f]{64}$') { exit 2 }
$updates = Split-Path -Parent $State
$marker = Join-Path (Join-Path (Split-Path -Parent $updates) 'runtime') 'updating.json'
function Remove-Marker { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
# The app withdraws an update it could not hand over, or that a new batch called off, by removing the state folder and
# pending.json.
function Test-Withdrawn { return (-not (Test-Path -LiteralPath (Join-Path $State 'helper-state'))) -or (-not (Test-Path -LiteralPath (Join-Path $updates 'pending.json'))) }
try { Set-Content -LiteralPath (Join-Path $State 'helper-pid') -Value $PID -Encoding ASCII } catch { }
Write-Log ('helper started for ' + $From + ' -> ' + $To + ' (pid ' + $AppPid + ')')
Set-Mark 'waiting'

# 1. The app quits on its own; it is never killed.
$deadline = [DateTime]::UtcNow.AddSeconds($ExitTimeout)
while (Test-Alive $AppPid) {
  if (Test-Withdrawn) { exit 0 }
  if ([DateTime]::UtcNow -gt $deadline) { Write-Log 'the app did not quit'; Set-Mark 'aborted:app_running'; Remove-Marker; exit 1 }
  Start-Sleep -Milliseconds 200
}
Write-Log 'the app has quit'
if (Test-Withdrawn) { exit 0 }

# The main processes of apps running from this installation (not MCP servers, which run the bundle as Node, and not
# Chromium's helper processes).
function Get-OtherApps {
  $prefix = $InstallDir.TrimEnd('\') + '\'
  return @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -and
    ($_.CommandLine -notmatch '--type=') -and ($_.CommandLine -notmatch 'novelai-mcp\.mjs') -and $_.ProcessId -ne $PID
  })
}
# Its renderer and GPU processes end right after it; an app reopened meanwhile quits by itself (it sees the update).
$deadline = [DateTime]::UtcNow.AddSeconds($OthersTimeout)
$others = Get-OtherApps
while ($others.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500; $others = Get-OtherApps }
Start-Sleep -Milliseconds 1000
$others = Get-OtherApps
if ($others.Count -gt 0) {
  Write-Log ('another copy of the app runs from this installation (pid ' + (($others | ForEach-Object { $_.ProcessId }) -join ', ') + '); the installer would end it')
  Set-Mark 'aborted:other_instance'
  Remove-Marker
  if (-not (Start-App ('--update-rolled-back=' + $To))) { Write-Log 'the app could not be started again' }
  exit 1
}
if (Test-Withdrawn) { exit 0 }

# The installer as it is on disk now, checked once more.
$actual = $null
try { $actual = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() } catch { }
if ($actual -ne $Sha256) {
  Write-Log 'the installer on disk does not match the signed checksum'
  Set-Mark 'aborted:installer_changed'
  Remove-Marker
  if (-not (Start-App ('--update-rolled-back=' + $To))) { Write-Log 'the app could not be started again' }
  exit 1
}

# 2. The installer, silently, into the same folder (/D= must be last and unquoted).
Set-Mark 'installing'
$code = -1
try {
  $process = Start-Process -FilePath $Installer -ArgumentList ('/S --updated /D=' + $InstallDir) -Wait -PassThru -WindowStyle Hidden
  $code = $process.ExitCode
} catch { Write-Log ('the installer could not run: ' + $_.Exception.Message) }
Write-Log ('installer exit code ' + $code)
$exePath = Join-Path $InstallDir $Exe
# electron-builder writes the app version into the FileVersion string (with a build number appended when the build
# had one); ProductVersion holds only the numeric x.y.z.n form.
$installed = $null
if (Test-Path -LiteralPath $exePath -PathType Leaf) { $installed = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exePath).FileVersion }
Write-Log ('installed version ' + $installed)
$sameVersion = $installed -and (($installed -eq $To) -or $installed.StartsWith($To + '.'))
if ($code -ne 0 -or -not $sameVersion) {
  Set-Mark 'failed:installer_failed'
  Remove-Marker
  if (-not (Start-App ('--update-rolled-back=' + $To))) { Write-Log 'no app could be started' }
  exit 1
}
Set-Mark 'swapped'

# 3. The new app starts and confirms.
if (-not (Start-App ('--updated-from=' + $From))) { Set-Mark 'failed:launch_failed'; Remove-Marker; exit 1 }
Set-Mark 'launched'
$deadline = [DateTime]::UtcNow.AddSeconds($ConfirmTimeout)
while ([DateTime]::UtcNow -lt $deadline) {
  if (Test-Path -LiteralPath (Join-Path $State 'confirmed')) { Set-Mark 'confirmed'; Remove-Marker; Set-Mark 'done'; exit 0 }
  Start-Sleep -Milliseconds 500
}
Set-Mark 'slow'
exit 0
`;
