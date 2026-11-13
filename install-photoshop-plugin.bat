@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "SRC=%ROOT%com.figmatoolbox.ps"
set "EXT=%APPDATA%\Adobe\CEP\extensions"
set "DST=%EXT%\com.figmatoolbox.ps"

if not exist "%SRC%\CSXS\manifest.xml" (
  echo [ERROR] Source plugin not found: "%SRC%"
  exit /b 1
)

if not exist "%EXT%" mkdir "%EXT%"
if not exist "%EXT%" (
  echo [ERROR] Could not create extension directory.
  exit /b 1
)
if exist "%DST%" rmdir /s /q "%DST%"
if exist "%DST%" (
  echo [ERROR] Could not remove previous plugin directory.
  exit /b 1
)
mkdir "%DST%"
if errorlevel 1 (
  echo [ERROR] Could not create plugin directory.
  exit /b 1
)

robocopy "%SRC%" "%DST%" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo [ERROR] Plugin copy failed.
  exit /b 1
)

reg add "HKCU\Software\Adobe\CSXS.9" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
if errorlevel 1 (
  echo [ERROR] Could not enable CEP development loading.
  exit /b 1
)

echo Photoshop plugin installed successfully.
echo Plugin: "%DST%"
echo Registry: HKCU\Software\Adobe\CSXS.9\PlayerDebugMode = 1
echo Restart Photoshop before opening the extension.
exit /b 0

