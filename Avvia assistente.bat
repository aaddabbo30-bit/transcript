@echo off
rem Double-click to start Call Assistant. Run Installa.bat first.
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo Prima fai doppio clic su Installa.bat  /  Run Installa.bat first.
  pause
  exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" -m call_assistant %*
