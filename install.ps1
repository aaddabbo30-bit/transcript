#Requires -Version 5.1
<#
.SYNOPSIS
    Installs Call Assistant on Windows: Python, libraries, Whisper model,
    Anthropic API key and the "Avvia assistente" desktop shortcut.

.DESCRIPTION
    Easiest way: double-click "Installa.bat" in this folder.
    Or from PowerShell:  powershell -ExecutionPolicy Bypass -File .\install.ps1
    Safe to run again at any time: it repairs or updates the installation.

.PARAMETER WhisperModel
    tiny, base, small (default), medium or large-v3-turbo. Asked interactively if omitted.

.PARAMETER NonInteractive
    Never ask questions (uses defaults, keeps the existing API key).
#>
[CmdletBinding()]
param(
    [ValidateSet('', 'tiny', 'base', 'small', 'medium', 'large-v3-turbo')]
    [string]$WhisperModel = '',
    [switch]$SkipModel,
    [switch]$SkipShortcut,
    [switch]$NonInteractive
)

# 'Continue': native tools (pip, winget) write progress to stderr, which Windows
# PowerShell 5.1 would otherwise turn into terminating errors. Exit codes are checked instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'   # much faster downloads on Windows PowerShell 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$AppDir = $PSScriptRoot
Set-Location -LiteralPath $AppDir   # "python -m call_assistant" needs this folder as working directory
$VenvDir = Join-Path $AppDir '.venv'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$VenvPythonW = Join-Path $VenvDir 'Scripts\pythonw.exe'
$PythonVersion = '3.12.10'
$PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"
$ShortcutName = 'Avvia assistente'

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }
function Stop-Install([string]$Text) {
    Write-Host ''
    Write-Host "ERRORE / ERROR: $Text" -ForegroundColor Red
    Write-Host 'Puoi rilanciare Installa.bat dopo aver risolto. / Fix the problem and run Installa.bat again.'
    exit 1
}
function Ask-YesNo([string]$Question, [bool]$Default) {
    if ($NonInteractive) { return $Default }
    $hint = if ($Default) { '[S/n]' } else { '[s/N]' }
    $answer = Read-Host "    $Question $hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim().ToLower() -in @('s', 'si', 'sì', 'y', 'yes')
}

# --- Python ----------------------------------------------------------------
function Test-PythonExe([string]$Exe) {
    # A usable Python is 3.10-3.13, 64-bit x64 (the speech libraries have no ARM64
    # or 32-bit builds; x64 Python also runs on Windows on ARM), with working Tk and venv.
    if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { return $false }
    $probe = "import sys, platform, tkinter, venv; tkinter.Tcl(); " +
             "ok = (3, 10) <= sys.version_info[:2] <= (3, 13) and platform.machine() == 'AMD64' and sys.maxsize > 2**32; " +
             "sys.exit(0 if ok else 1)"
    try {
        & $Exe -c $probe 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Find-Python {
    # Never let the new "Python install manager" start installing while we only probe.
    $env:PYTHON_MANAGER_AUTOMATIC_INSTALL = 'false'
    $candidates = New-Object System.Collections.Generic.List[string]
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($v in '3.12', '3.11', '3.13', '3.10') {
            try {
                $exe = & py "-$v" -c "import sys; print(sys.executable)" 2>$null
                if ($LASTEXITCODE -eq 0 -and $exe) { $candidates.Add(($exe | Select-Object -First 1).Trim()) }
            } catch { }
        }
    }
    foreach ($v in '312', '311', '313', '310') {
        $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Python\Python$v\python.exe"))
        if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles "Python$v\python.exe")) }
    }
    # python on PATH, including Microsoft Store Python. If only the Store *alias* exists,
    # it just exits with an error when called with arguments, and is skipped.
    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath) { $candidates.Add($onPath.Source) }
    foreach ($c in $candidates) { if (Test-PythonExe $c) { return $c } }
    return $null
}

function Install-Python {
    Write-Step "Installo Python $PythonVersion (solo per il tuo utente) / Installing Python $PythonVersion"
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host '    Uso winget... / Using winget...'
        try {
            & winget install --id Python.Python.3.12 --exact --scope user --architecture x64 --silent --accept-package-agreements --accept-source-agreements | Out-Host
        } catch { Write-Note "winget non ha funzionato / winget failed: $_" }
        $found = Find-Python
        if ($found) { return $found }
    }
    $installer = Join-Path $env:TEMP "python-$PythonVersion-amd64.exe"
    Write-Host "    Scarico / Downloading $PythonUrl"
    try { Invoke-WebRequest -Uri $PythonUrl -OutFile $installer -UseBasicParsing -ErrorAction Stop }
    catch { Stop-Install "Download di Python non riuscito / Python download failed: $_" }
    $installArgs = '/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_tcltk=1 Include_pip=1 Include_test=0'
    $proc = Start-Process -FilePath $installer -ArgumentList $installArgs -Wait -PassThru
    if ($proc.ExitCode -ne 0) { Stop-Install "Installazione di Python non riuscita (codice $($proc.ExitCode))." }
    return Find-Python
}

# --- Microsoft Visual C++ runtime ---------------------------------------------------
# The speech engine (CTranslate2) and the voice detector (onnxruntime) need it.
# Most PCs already have it; a freshly installed Windows may not.
function Test-VCRuntime { return (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\msvcp140_1.dll')) }

function Install-VCRuntime {
    if (Test-VCRuntime) { return }
    Write-Step 'Installo Microsoft Visual C++ Runtime / Installing the Visual C++ runtime'
    Write-Host '    Windows chiederà il permesso di amministratore. / Windows will ask for administrator permission.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        try {
            & winget install --id Microsoft.VCRedist.2015+.x64 --exact --silent --accept-package-agreements --accept-source-agreements | Out-Host
        } catch { Write-Note "winget: $_" }
    }
    if (-not (Test-VCRuntime)) {
        $vcInstaller = Join-Path $env:TEMP 'vc_redist.x64.exe'
        try {
            Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $vcInstaller -UseBasicParsing -ErrorAction Stop
            Start-Process -FilePath $vcInstaller -ArgumentList '/install /quiet /norestart' -Verb RunAs -Wait -ErrorAction Stop
        } catch { Write-Note "Visual C++ runtime: $_" }
    }
    if (Test-VCRuntime) { Write-Ok 'Visual C++ runtime OK' }
    else { Write-Note 'Installalo a mano / install it manually: https://aka.ms/vs/17/release/vc_redist.x64.exe' }
}

# --- API key -------------------------------------------------------------------
function Read-ApiKey {
    $secure = Read-Host -AsSecureString '    Incolla la chiave (sk-ant-...) e premi Invio - solo Invio per saltare / paste key, Enter to skip'
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($null -eq $plain) { return '' }
    return $plain.Trim()
}

# --- Shortcuts -------------------------------------------------------------------
function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$Description, [string]$Icon = '') {
    $shell = New-Object -ComObject WScript.Shell -ErrorAction Stop
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath = $Target
    $link.Arguments = $Arguments
    $link.WorkingDirectory = $AppDir
    if (-not $Icon) { $Icon = (Join-Path $AppDir 'assets\icon.ico') + ',0' }
    $link.IconLocation = $Icon
    $link.Description = $Description
    $link.Save()
}

# ==============================================================================
Write-Host ''
Write-Host '  Call Assistant - installazione / setup' -ForegroundColor White
Write-Host "  Cartella / folder: $AppDir"

if (-not [Environment]::Is64BitOperatingSystem) { Stop-Install 'Serve Windows a 64 bit. / 64-bit Windows is required.' }
if ($AppDir -like '*OneDrive*') {
    Write-Note 'La cartella è dentro OneDrive: funziona, ma OneDrive sincronizzerà migliaia di file (.venv, modelli).'
    Write-Note 'Meglio spostarla, ad esempio in C:\Users\<nome>\CallAssistant. / Better move it outside OneDrive.'
}

# Files extracted from a downloaded ZIP are marked "from the internet": unblock them
# so Windows does not ask for confirmation every time.
Get-ChildItem -LiteralPath $AppDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike "$VenvDir*" } |
    Unblock-File -ErrorAction SilentlyContinue

Write-Step 'Cerco Python 3.10-3.13 / Looking for Python'
$python = Find-Python
if (-not $python) { $python = Install-Python }
if (-not $python) {
    Stop-Install 'Python non trovato. Installa Python 3.12 da https://www.python.org/downloads/ (spunta "Add python.exe to PATH" e "tcl/tk"), poi rilancia.'
}
Write-Ok "Python: $python"

if (-not (Test-PythonExe $VenvPython)) {
    Write-Step "Creo l'ambiente dell'app (.venv) / Creating the app environment"
    if (Test-Path -LiteralPath $VenvDir) { Remove-Item -LiteralPath $VenvDir -Recurse -Force -ErrorAction SilentlyContinue }
    & $python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $VenvPython)) { Stop-Install 'Creazione di .venv non riuscita.' }
}
Write-Ok "Ambiente / environment: $VenvDir"

Write-Step 'Installo le librerie (alcuni minuti) / Installing libraries (a few minutes)'
& $VenvPython -m pip install --upgrade pip --disable-pip-version-check --quiet
& $VenvPython -m pip install -r (Join-Path $AppDir 'requirements.txt') --disable-pip-version-check
if ($LASTEXITCODE -ne 0) {
    Stop-Install 'Installazione delle librerie non riuscita (vedi i messaggi sopra): di solito è la connessione a internet. / Library installation failed (see above), usually the internet connection.'
}
Write-Ok 'Librerie installate / libraries installed'

Install-VCRuntime
& $VenvPython -c "import ctranslate2, onnxruntime, numpy, anthropic, pyaudiowpatch" 2>$null
if ($LASTEXITCODE -ne 0) {
    Stop-Install 'Le librerie non si avviano: installa Microsoft Visual C++ Runtime (https://aka.ms/vs/17/release/vc_redist.x64.exe), riavvia il PC e rilancia Installa.bat.'
}
Write-Ok 'Librerie verificate / libraries checked'

Write-Step 'Chiave API Anthropic / Anthropic API key'
Write-Host '    Serve per i suggerimenti di Claude. Si crea su https://console.anthropic.com (API Keys).'
Write-Host '    Viene salvata come variabile d''ambiente utente ANTHROPIC_API_KEY, mai in un file.'
$existingKey = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User')
$askKey = $true
if ($existingKey) {
    Write-Ok 'Già configurata / already set'
    $askKey = Ask-YesNo 'Vuoi sostituirla? / Replace it?' $false
} elseif ($NonInteractive) {
    $askKey = $false
}
if ($askKey) {
    $key = Read-ApiKey
    if ($key -like 'sk-ant-*') {
        [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $key, 'User')
        $env:ANTHROPIC_API_KEY = $key
        Write-Ok 'Chiave salvata / key saved'
    } elseif ($key) {
        Write-Note 'Non sembra una chiave Anthropic (dovrebbe iniziare con sk-ant-): non salvata.'
    } else {
        Write-Note 'Saltato: potrai inserirla dall''app (Impostazioni). / Skipped: you can add it in the app (Settings).'
    }
}

if (-not $SkipModel) {
    Write-Step 'Modello di trascrizione Whisper / Whisper speech model'
    if (-not $WhisperModel) {
        $WhisperModel = 'small'
        if (-not $NonInteractive) {
            Write-Host '    1) base   - PC poco potenti / older PCs           (~150 MB)'
            Write-Host '    2) small  - consigliato / recommended              (~500 MB)'
            Write-Host '    3) medium - PC potenti, più preciso / fast PCs     (~1.5 GB)'
            $choice = "$(Read-Host '    Scegli 1, 2 o 3 (Invio = 2)')"
            switch ($choice.Trim()) { '1' { $WhisperModel = 'base' } '3' { $WhisperModel = 'medium' } default { $WhisperModel = 'small' } }
        }
    }
    Write-Host "    Scarico '$WhisperModel' (solo la prima volta) / Downloading (first time only)..."
    & $VenvPython -m call_assistant --download-model $WhisperModel
    if ($LASTEXITCODE -ne 0) {
        Write-Note 'Download del modello non riuscito: verrà riprovato al primo avvio. / Will retry at first start.'
    } else {
        Write-Ok "Modello '$WhisperModel' pronto / ready"
    }
}

if (-not $SkipShortcut) {
    Write-Step 'Creo le icone / Creating shortcuts'
    $desktop = [Environment]::GetFolderPath('Desktop')
    $programs = [Environment]::GetFolderPath('Programs')
    $menu = Join-Path $programs 'Call Assistant'
    # Your data folder (memory, call summaries): the same one the app uses.
    $dataDir = if ($env:CALL_ASSISTANT_HOME) { $env:CALL_ASSISTANT_HOME } else { Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Call Assistant' }
    $memoryDir = Join-Path $dataDir 'memory'
    $callsDir = Join-Path $dataDir 'calls'
    $folderIcon = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',3'
    try {
        foreach ($dir in @($menu, $memoryDir, $callsDir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $legacy = Join-Path $programs "$ShortcutName.lnk"   # created by older versions of this installer
        if (Test-Path -LiteralPath $legacy) { Remove-Item -LiteralPath $legacy -Force }

        # Desktop: the one icon you need during calls.
        New-Shortcut (Join-Path $desktop "$ShortcutName.lnk") $VenvPythonW '-m call_assistant' 'Assistente per chiamate e video (Whisper + Claude)'
        # Start menu > Call Assistant: every tool of the project.
        New-Shortcut (Join-Path $menu "$ShortcutName.lnk") $VenvPythonW '-m call_assistant' 'Assistente per chiamate e video (Whisper + Claude)'
        New-Shortcut (Join-Path $menu 'Prova demo.lnk') $VenvPythonW '-m call_assistant --demo --speed 2' 'Prova senza chiamata: riproduce una conversazione di esempio'
        New-Shortcut (Join-Path $menu 'Verifica installazione.lnk') (Join-Path $AppDir 'Verifica installazione.bat') '' 'Controlla Python, Whisper, chiave API e audio'
        New-Shortcut (Join-Path $menu 'Memoria.lnk') $memoryDir '' 'La tua memoria personale (file Markdown)' $folderIcon
        New-Shortcut (Join-Path $menu 'Chiamate.lnk') $callsDir '' 'Riassunti e trascrizioni delle chiamate' $folderIcon
        New-Shortcut (Join-Path $menu 'Disinstalla.lnk') (Join-Path $AppDir 'Disinstalla.bat') '' 'Rimuove il programma (i tuoi dati restano)'
        Write-Ok "Desktop: '$ShortcutName'"
        Write-Ok "Menu Start > Call Assistant: $ShortcutName, Prova demo, Verifica installazione, Memoria, Chiamate, Disinstalla"
    } catch {
        Write-Note "Icone non create / shortcuts not created: $_  (usa 'Avvia assistente.bat')"
    }
}

Write-Host ''
Write-Host '  Fatto! / Done!' -ForegroundColor Green
Write-Host "  Doppio clic su '$ShortcutName' sul Desktop per aprire l'assistente."
Write-Host "  Per provarlo senza una chiamata: 'Prova demo.bat'. Per un controllo: 'Verifica installazione.bat'."
Write-Host ''
if (-not $NonInteractive -and (Ask-YesNo "Avvio l'assistente adesso? / Start it now?" $true)) {
    Start-Process -FilePath $VenvPythonW -ArgumentList '-m', 'call_assistant' -WorkingDirectory $AppDir
}
