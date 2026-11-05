// The update helper of Windows: a fixed PowerShell script that the app writes into the update's state folder and starts
// outside its own process tree (Win32_Process.Create, hidden) right before it quits (updater.ts). Its values are
// parameters of -File (bound as strings, never evaluated); the app checks them first.
//
//   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File helper.ps1 -State <dir> -AppPid <pid>
//     -Installer <setup.exe> -InstallDir <dir> -Exe <MCP for NovelAI.exe> -From <version> -To <version>
//     [-Background 0|1] [-ExitTimeout 300] [-ConfirmTimeout 120]
//
// Steps: wait for the app to exit (never kills it; at most ExitTimeout s, else nothing changes); run the checked NSIS
// installer silently into the same folder (/S --updated /D=<folder>: the same per-user installation, shortcuts kept);
// check that the installed executable now has the new version; start it (Win32_Process.Create, outside any job, with this
// helper's environment — the app's own — and --updated-from=<from>); wait for its confirmed file. When the installer
// fails, whatever is installed is started again with --update-rolled-back=<to> (the installer leaves the old version in
// place when it stops before extracting; the app then says the update did not complete).
export const WINDOWS_HELPER_SCRIPT = String.raw`# MCP for NovelAI update helper (Windows). Written and started by the app; see electron/update/helper-windows.ts.
param(
  [Parameter(Mandatory = $true)][string]$State,
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$From,
  [Parameter(Mandatory = $true)][string]$To,
  [int]$Background = 0,
  [int]$ExitTimeout = 300,
  [int]$ConfirmTimeout = 120
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
Write-Log ('helper started for ' + $From + ' -> ' + $To + ' (pid ' + $AppPid + ')')
Set-Mark 'waiting'

# 1. The app quits on its own; it is never killed.
$deadline = [DateTime]::UtcNow.AddSeconds($ExitTimeout)
while (Test-Alive $AppPid) {
  if ([DateTime]::UtcNow -gt $deadline) { Write-Log 'the app did not quit'; Set-Mark 'aborted:app_running'; exit 1 }
  Start-Sleep -Milliseconds 200
}
Write-Log 'the app has quit'
# The app withdraws an update it could not hand over by removing the state folder (and pending.json).
if (-not (Test-Path -LiteralPath (Join-Path $State 'helper-state')) -or -not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $State) 'pending.json'))) { exit 1 }
# Its other processes (renderer, GPU) end right after it.
Start-Sleep -Milliseconds 1500

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
  if (-not (Start-App ('--update-rolled-back=' + $To))) { Write-Log 'no app could be started' }
  exit 1
}
Set-Mark 'swapped'

# 3. The new app starts and confirms.
if (-not (Start-App ('--updated-from=' + $From))) { Set-Mark 'failed:launch_failed'; exit 1 }
Set-Mark 'launched'
$deadline = [DateTime]::UtcNow.AddSeconds($ConfirmTimeout)
while ([DateTime]::UtcNow -lt $deadline) {
  if (Test-Path -LiteralPath (Join-Path $State 'confirmed')) { Set-Mark 'confirmed'; Set-Mark 'done'; exit 0 }
  Start-Sleep -Milliseconds 500
}
Set-Mark 'slow'
exit 0
`;
