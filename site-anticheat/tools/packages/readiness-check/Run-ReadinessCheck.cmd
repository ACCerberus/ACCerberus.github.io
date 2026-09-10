@echo off
REM Cerberus Readiness Check 1.0.0 - double-click launcher.
REM Runs the PowerShell script next to this file with the current user's rights.
REM Nothing is installed and nothing leaves this PC.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Cerberus-ReadinessCheck.ps1" %*
set "CRB_EXIT=%ERRORLEVEL%"
echo.
echo Exit code: %CRB_EXIT%  (0 = ready, 1 = ready with warnings, 2 = not ready, 3 = script error)
echo.
pause
endlocal & exit /b %CRB_EXIT%
