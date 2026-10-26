#Requires -Version 5.1
<#
.SYNOPSIS
    Removes Call Assistant's program files (.venv, Whisper models, shortcuts).
    Your memory and call summaries in Documents\Call Assistant are NOT deleted.
    Run: double-click "Disinstalla.bat" (or powershell -ExecutionPolicy Bypass -File .\uninstall.ps1)
#>
$ErrorActionPreference = 'Continue'
$AppDir = $PSScriptRoot
Write-Host 'Chiudi prima l''assistente se è aperto. / Close the assistant first if it is running.'
Read-Host 'Premi Invio per continuare / Press Enter to continue' | Out-Null
function Get-ShellFolder([string]$Name, [string]$RegistryName) {
    try { $path = [Environment]::GetFolderPath($Name); if ($path) { return $path } } catch { }
    try { return (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders' -ErrorAction Stop).$RegistryName } catch { return $null }
}
$desktop = Get-ShellFolder 'Desktop' 'Desktop'
$programs = Get-ShellFolder 'Programs' 'Programs'
foreach ($link in @((Join-Path $desktop 'Avvia assistente.lnk'), (Join-Path $desktop 'Avvia assistente.bat'), (Join-Path $programs 'Avvia assistente.lnk'))) {
    if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force; Write-Host "Rimosso / removed: $link" }
}
$menu = Join-Path $programs 'Call Assistant'
if (Test-Path -LiteralPath $menu) { Remove-Item -LiteralPath $menu -Recurse -Force; Write-Host "Rimosso / removed: $menu" }
foreach ($sub in @('.venv', 'models')) {
    $path = Join-Path $AppDir $sub
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $path) { Write-Host "NON rimosso del tutto (file in uso?) / not fully removed (files in use?): $path" -ForegroundColor Yellow }
        else { Write-Host "Rimosso / removed: $path" }
    }
}
$answer = Read-Host 'Cancellare anche la chiave API (ANTHROPIC_API_KEY)? / Also delete the API key? [s/N]'
if ("$answer".Trim().ToLower() -in @('s', 'si', 'sì', 'y', 'yes')) {
    try { [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User') }
    catch { Remove-ItemProperty -Path 'HKCU:\Environment' -Name 'ANTHROPIC_API_KEY' -ErrorAction SilentlyContinue }
    Write-Host 'Chiave rimossa / key removed'
}
Write-Host ''
Write-Host 'Fatto. Ora puoi cancellare questa cartella. I tuoi dati restano in Documenti\Call Assistant.'
Write-Host 'Done. You can now delete this folder. Your data stays in Documents\Call Assistant.'
