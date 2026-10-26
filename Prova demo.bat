@echo off
rem Try the assistant without a call: replays a sample conversation in the window.
rem Uses Claude if your API key is set (a few cents at most). Add --fake-llm for a fully offline demo.
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo Prima fai doppio clic su Installa.bat  /  Run Installa.bat first.
  pause
  exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" -m call_assistant --demo --speed 2 %*
