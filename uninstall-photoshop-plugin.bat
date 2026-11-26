@echo off
setlocal EnableExtensions

set "EXT=%APPDATA%\Adobe\CEP\extensions"
set "DST=%EXT%\com.figmatoolbox.ps"

if exist "%DST%" (
  rmdir /s /q "%DST%"
  if exist "%DST%" (
    echo [ERROR] Could not remove plugin directory.
    exit /b 1
  )
  echo Removed plugin: "%DST%"
) else (
  echo Plugin directory not found; nothing to remove.
)

choice /C YN /N /M "Also remove CSXS.9 ~ CSXS.19 PlayerDebugMode=1? [Y/N] "
if errorlevel 3 (
  echo [ERROR] Registry cleanup prompt failed; registry values were not removed.
  exit /b 1
)
if errorlevel 2 goto done
if not errorlevel 1 (
  echo [ERROR] Registry cleanup prompt was interrupted; registry values were not removed.
  exit /b 1
)
for /l %%V in (9,1,19) do (
  reg query "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode >nul 2>nul
  if not errorlevel 1 (
    reg delete "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /f >nul 2>nul
    if errorlevel 1 (
      echo [ERROR] Could not remove registry value for CSXS.%%V.
      goto registry_error
    )
    reg query "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode >nul 2>nul
    if not errorlevel 1 (
      echo [ERROR] Registry value still exists for CSXS.%%V.
      goto registry_error
    )
    echo Removed registry value: HKCU\Software\Adobe\CSXS.%%V\PlayerDebugMode
  )
)

:done
echo Uninstall processing complete. Restart Photoshop.
exit /b 0

:registry_error
exit /b 1

