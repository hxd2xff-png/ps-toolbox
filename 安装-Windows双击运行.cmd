@echo off
rem ============================================================
rem  PS Toolbox CEP installer - double-click launcher
rem  All logic lives in install-windows.ps1 (UTF-8 BOM, Chinese OK there)
rem ============================================================
title PS Toolbox Installer
echo.
echo ==============================================
echo   PS Toolbox - Windows Installer
echo   (Photoshop 2019+, user-level, no admin)
echo ==============================================
echo.

where powershell >nul 2>nul
if errorlevel 1 goto NOPS

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
goto END

:NOPS
echo [ERROR] Windows PowerShell not found.

:END
echo.
pause
