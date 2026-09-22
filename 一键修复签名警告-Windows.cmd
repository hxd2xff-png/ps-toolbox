@echo off
setlocal EnableExtensions
setlocal EnableDelayedExpansion
rem ============================================================
rem  "Pirated PS Toolbox" - one-click fix for the
rem  "extension is not properly signed" error (CEP unsigned load)
rem
rem  What this does (user-level only, NO admin required):
rem    1. Writes PlayerDebugMode = 1 (String) into
rem       HKCU\Software\Adobe\CSXS.9 .. CSXS.14
rem       -> covers Photoshop 2019 (CSXS.9) through latest
rem    2. Reads every value back and verifies it
rem    3. Shows a clear verdict; tells you to fully restart PS
rem
rem  Why: self-signed CEP extensions are only loaded when
rem  PlayerDebugMode = 1. The value MUST be a REG_SZ (string),
rem  not a DWORD - CEP ignores DWORD 1.
rem ============================================================
title PS Toolbox - Fix "not properly signed" warning
echo.
echo  ==============================================
echo   Fix: extension "not properly signed" warning
echo   (writes PlayerDebugMode=1 for CEP 9-14, user-level)
echo  ==============================================
echo.

set FOUND_MISMATCH=0

for %%V in (9 10 11 12 13 14) do (
  echo [CSXS.%%V]
  set KEY_VERIFIED=0
  reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
  if errorlevel 1 (
    echo   [FAIL] could not write - is the registry locked by policy?
    set FOUND_MISMATCH=1
  ) else (
    for /f "tokens=1,2,*" %%A in ('reg query "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode 2^>nul ^| findstr /i "PlayerDebugMode"') do (
      if /i "%%B"=="REG_SZ" if "%%C"=="1" (
        echo   [OK] PlayerDebugMode = 1 ^(REG_SZ^) written and verified
        set KEY_VERIFIED=1
      ) else (
        echo   [WARN] readback shows: %%B %%C
        set FOUND_MISMATCH=1
        set KEY_VERIFIED=1
      )
    )
    if "!KEY_VERIFIED!"=="0" (
      echo   [FAIL] write reported success but readback found NOTHING - registry may be redirected
      set FOUND_MISMATCH=1
    )
  )
  echo.
)

echo  ----------------------------------------------
if "%FOUND_MISMATCH%"=="1" (
  echo  [RESULT] Some values failed - see above.
  echo  Send this window's text back to the developer.
) else (
  echo  [RESULT] All CSXS.9-14 keys verified: PlayerDebugMode = 1
  echo.
  echo  NEXT STEP - important:
  echo    Fully QUIT Photoshop ^(all windows^) and start it again.
  echo    CEP reads these keys ONLY at Photoshop startup.
  echo    Then: Window ^> Extensions ^> Pirated PS Toolbox
)
echo  ----------------------------------------------
rem if Photoshop is running right now, CEP will not see these keys until restart
rem (no find.exe dependency: tasklist /FO csv is greppable without external tools
rem  is unreliable, so use errorlevel of tasklist's own filter instead)
tasklist /FI "IMAGENAME eq Photoshop.exe" /NH 2>nul | findstr /i "Photoshop.exe" >nul
if not errorlevel 1 (
  echo  [NOTE] Photoshop is RUNNING right now - you MUST fully quit and restart it.
) else (
  echo  [NOTE] Photoshop is not running. Start it after this script.
)
echo.
pause
endlocal
