@echo off
rem Checks Python, Whisper, the API key and the audio devices (records 5 seconds).
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Prima fai doppio clic su Installa.bat  /  Run Installa.bat first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m call_assistant --check
echo.
pause
