@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "SRC=%ROOT%com.figmatoolbox.ps.uxp"
rem Optional source override: install-photoshop-uxp-plugin.bat "D:\path\to\com.figmatoolbox.ps.uxp"
if not "%~1"=="" set "SRC=%~1"
set "PLUGINS=%APPDATA%\Adobe\UXP\Plugins"
set "EXT=%PLUGINS%\External"
set "DST=%EXT%\com.figmatoolbox.ps.uxp"

if not exist "%SRC%" (
  echo [ERROR] Source plugin not found: "%SRC%"
  goto fail
)

tasklist /FI "IMAGENAME eq Photoshop.exe" 2>nul | find /I "Photoshop.exe" >nul
if not errorlevel 1 (
  echo [WARN] Photoshop is running. Close it before installing so the plugin list
  echo        and plugin files are not rewritten by the running process.
)

set "MANIFEST_JSON=%SRC%\manifest.json"
set "ID_FILE=%TEMP%\psuxp-id-%RANDOM%%RANDOM%%RANDOM%.txt"
if exist "%ID_FILE%" del "%ID_FILE%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{$m=Get-Content -LiteralPath $env:MANIFEST_JSON -Raw|ConvertFrom-Json;[IO.File]::WriteAllText($env:ID_FILE,[string]$m.id)}catch{[IO.File]::WriteAllText($env:ID_FILE,'')}"
if errorlevel 1 (
  echo [ERROR] Could not parse manifest.json; the plugin id was not verified.
  if exist "%ID_FILE%" del "%ID_FILE%" >nul 2>nul
  goto fail
)
set "MANIFEST_ID="
if exist "%ID_FILE%" set /p MANIFEST_ID=<"%ID_FILE%"
if exist "%ID_FILE%" del "%ID_FILE%" >nul 2>nul
rem A direct parse fallback: if the temp file handshake produced nothing, read the id
rem again in one step so a lost temp file can never masquerade as a bad manifest.
if "%MANIFEST_ID%"=="" (
  for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try{$m=Get-Content -LiteralPath $env:MANIFEST_JSON -Raw|ConvertFrom-Json;[Console]::Out.Write([string]$m.id)}catch{[Console]::Out.Write('')}"`) do set "MANIFEST_ID=%%I"
)
if "%MANIFEST_ID%"=="" (
  echo [ERROR] Could not read the plugin id from manifest.json.
  goto fail
)
if /i not "%MANIFEST_ID%"=="com.figmatoolbox.ps.uxp" (
  echo [ERROR] manifest.json does not declare id com.figmatoolbox.ps.uxp.
  goto fail
)


if not exist "%PLUGINS%" mkdir "%PLUGINS%"
if not exist "%PLUGINS%" (
  echo [ERROR] Could not create plugin root: "%PLUGINS%"
  goto fail
)
if not exist "%EXT%" mkdir "%EXT%"
if not exist "%EXT%" (
  echo [ERROR] Could not create external plugin directory: "%EXT%"
  goto fail
)

if exist "%DST%" rmdir /s /q "%DST%"
if exist "%DST%" (
  echo [ERROR] Could not remove previous plugin directory.
  goto fail
)
rem Remove old CCX-installed version folders (com.figmatoolbox.ps.uxp_<version>)
rem so Photoshop cannot keep loading a stale host/UI after an update.
for /d %%D in ("%EXT%\com.figmatoolbox.ps.uxp_*") do (
  rmdir /s /q "%%~fD"
  if exist "%%~fD" (
    echo [ERROR] Could not remove previous versioned plugin directory: "%%~fD"
    goto fail
  )
)

robocopy "%SRC%" "%DST%" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo [ERROR] Plugin copy failed.
  goto fail
)

if not exist "%DST%\manifest.json" (
  echo [ERROR] Plugin manifest missing after copy.
  goto fail
)

if not exist "%ROOT%uxp-plugin-register.ps1" (
  echo [ERROR] Missing uxp-plugin-register.ps1 next to this installer.
  goto fail
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%uxp-plugin-register.ps1" -Action add -ManifestPath "%DST%\manifest.json" -FolderName "com.figmatoolbox.ps.uxp"
if errorlevel 1 (
  echo [ERROR] Plugin files were copied but the plugin list could not be updated.
  echo         Fallback: open Photoshop ^> Edit ^> Preferences ^> Plugins and enable
  echo         "Enable Developer Mode", then restart Photoshop.
  goto fail
)

echo Photoshop UXP plugin installed successfully.
echo Plugin: "%DST%"
echo If the panel does not appear, enable Edit ^> Preferences ^> Plugins ^> "Enable Developer Mode".
echo Then open "PS Toolbox" from the Plugins menu.
echo Restart Photoshop if it was already running before this install.
exit /b 0

:fail
exit /b 1
