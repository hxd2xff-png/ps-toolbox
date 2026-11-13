@echo off
setlocal EnableExtensions

set "EXT=%APPDATA%\Adobe\CEP\extensions"
set "DST=%EXT%\com.figmatoolbox.ps"

if exist "%DST%" (
  rmdir /s /q "%DST%"
  echo Removed plugin: "%DST%"
) else (
  echo Plugin directory not found; nothing to remove.
)

choice /C YN /N /M "Also remove CSXS.9 PlayerDebugMode=1? [Y/N] "
if errorlevel 2 goto done
reg delete "HKCU\Software\Adobe\CSXS.9" /v PlayerDebugMode /f >nul 2>nul
echo Removed registry value: HKCU\Software\Adobe\CSXS.9\PlayerDebugMode

:done
echo Uninstall processing complete. Restart Photoshop.
exit /b 0

