@echo off
rem Custom AI Workstation setup by R.G. Studios. Double-click to install (runs install.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
