@echo off
rem Removes the program files and shortcuts. Your data in Documents\Call Assistant is kept.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
