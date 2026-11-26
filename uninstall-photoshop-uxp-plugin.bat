@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "EXT=%APPDATA%\Adobe\UXP\Plugins\External"
set "DST=%EXT%\com.figmatoolbox.ps.uxp"

set "ANY="
if exist "%DST%" set "ANY=1"
for /d %%D in ("%EXT%\com.figmatoolbox.ps.uxp_*") do set "ANY=1"
if not defined ANY (
  echo Plugin directory not found; nothing to remove.
  echo Uninstall processing complete. Restart Photoshop.
  exit /b 0
)

rmdir /s /q "%DST%"
if exist "%DST%" (
  echo [ERROR] Could not remove plugin directory.
  exit /b 1
)
for /d %%D in ("%EXT%\com.figmatoolbox.ps.uxp_*") do (
  rmdir /s /q "%%~fD"
  if exist "%%~fD" (
    echo [ERROR] Could not remove versioned plugin directory: "%%~fD"
    exit /b 1
  )
)

if exist "%ROOT%uxp-plugin-register.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%uxp-plugin-register.ps1" -Action remove
  if errorlevel 1 (
    echo [ERROR] Plugin files were removed but the plugin list could not be updated.
    exit /b 1
  )
)

echo Removed plugin: "%DST%"
echo Uninstall processing complete. Restart Photoshop.
exit /b 0
