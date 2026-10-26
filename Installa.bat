@echo off
rem Double-click to install (or repair) Call Assistant.
cd /d "%~dp0"
if not exist "%~dp0install.ps1" (
  echo Prima estrai lo ZIP: tasto destro sul file ZIP, "Estrai tutto", poi apri la cartella estratta.
  echo Extract the ZIP first: right-click it, "Extract All", then open the extracted folder.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
