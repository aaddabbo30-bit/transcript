#Requires -Version 5.1
<#
.SYNOPSIS
    Removes Call Assistant's program files (.venv, Whisper models, shortcuts).
    Your memory and call summaries in Documents\Call Assistant are NOT deleted.
    Run: powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
$ErrorActionPreference = 'Continue'
$AppDir = $PSScriptRoot
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $link = Join-Path $folder 'Avvia assistente.lnk'
    if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force; Write-Host "Rimosso / removed: $link" }
}
foreach ($sub in @('.venv', 'models')) {
    $path = Join-Path $AppDir $sub
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force; Write-Host "Rimosso / removed: $path" }
}
$answer = Read-Host 'Cancellare anche la chiave API (ANTHROPIC_API_KEY)? / Also delete the API key? [s/N]'
if ($answer.Trim().ToLower() -in @('s', 'si', 'y', 'yes')) {
    [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')
    Write-Host 'Chiave rimossa / key removed'
}
Write-Host ''
Write-Host 'Fatto. Ora puoi cancellare questa cartella. I tuoi dati restano in Documenti\Call Assistant.'
Write-Host 'Done. You can now delete this folder. Your data stays in Documents\Call Assistant.'
