@echo off
setlocal EnableExtensions

rem Install the UXP plugin from a .ccx package without Creative Cloud Desktop.
rem A .ccx is a plain zip: extract it and reuse the folder installer.
rem Usage: drag font-mixer-uxp-*.ccx onto this file, or run:
rem        install-photoshop-uxp-from-ccx.bat "D:\path\plugin.ccx"

set "ROOT=%~dp0"
set "PKG=%~1"
if "%PKG%"=="" set "PKG=%ROOT%font-mixer-uxp-latest.ccx"

if not exist "%PKG%" (
  echo [ERROR] Package not found: "%PKG%"
  echo Usage: drag a .ccx file onto this script, or put font-mixer-uxp-latest.ccx next to it.
  goto fail
)

set "TMP=%TEMP%\psuxp-ccx-%RANDOM%%RANDOM%%RANDOM%"
if exist "%TMP%" rmdir /s /q "%TMP%"
mkdir "%TMP%"
if not exist "%TMP%" (
  echo [ERROR] Could not create a temporary directory.
  goto fail
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:PKG,$env:TMP)"
if errorlevel 1 (
  echo [ERROR] Could not extract the package. The file may be corrupt or not a .ccx.
  rmdir /s /q "%TMP%"
  goto fail
)

set "SRC=%TMP%"
if not exist "%SRC%\manifest.json" (
  set "SRC="
  for /d %%D in ("%TMP%\*") do if exist "%%~fD\manifest.json" set "SRC=%%~fD"
)
if not exist "%SRC%\manifest.json" (
  echo [ERROR] manifest.json was not found inside the package.
  rmdir /s /q "%TMP%"
  goto fail
)

call "%ROOT%install-photoshop-uxp-plugin.bat" "%SRC%"
set "RC=%ERRORLEVEL%"
rmdir /s /q "%TMP%"
if "%RC%"=="0" echo Package installed from "%PKG%".
exit /b %RC%

:fail
exit /b 1
