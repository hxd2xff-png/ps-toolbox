'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
test('PowerShell installer and optional cleanup cover CSXS 9 through 19',()=>{
 const install=read('scripts/install-photoshop-plugin.ps1'),remove=read('scripts/uninstall-photoshop-plugin.ps1');
 for(const s of [install,remove]) {
  const bounds=/\$registryPaths = @\((\d+)\.\.(\d+) \| ForEach-Object/.exec(s);assert.ok(bounds);
  assert.deepEqual([Number(bounds[1]),Number(bounds[2])],[9,19]);
  assert.match(s,/foreach \(\$registryPath in \$registryPaths\)/);
 }
 assert.match(install,/New-ItemProperty -Path \$registryPath -Name 'PlayerDebugMode' -PropertyType String -Value '1'/);
 assert.match(install,/\$invalidDebugPaths = @\(\$registryPaths \| Where-Object/);
 assert.match(install,/\$invalidDebugPaths.Count -gt 0/);
 assert.match(remove,/if \(\$RemoveDebugMode\) \{\s+foreach/);
 assert.match(remove,/Remove-ItemProperty -Path \$registryPath -Name 'PlayerDebugMode'\s/);
 assert.doesNotMatch(remove,/Remove-ItemProperty[^\r\n]*SilentlyContinue/);
});
test('installer stops after failed removal or directory creation before copying',()=>{const s=read('install-photoshop-plugin.bat');assert.match(s,/rmdir \/s \/q "%DST%"\s+if exist "%DST%" \([\s\S]*?exit \/b 1\s+\)\s+mkdir "%DST%"\s+if errorlevel 1 \([\s\S]*?exit \/b 1\s+\)\s+robocopy/);assert.match(s,/if not exist "%EXT%" \([\s\S]*?exit \/b 1/);assert.match(s,/robocopy[^\n]*\nif errorlevel 8 \([\s\S]*?exit \/b 1/);});
test('uninstaller reports removal success only after checking directory and registry failures',()=>{const s=read('uninstall-photoshop-plugin.bat');assert.match(s,/rmdir \/s \/q "%DST%"\s+if exist "%DST%" \([\s\S]*?exit \/b 1\s+\)\s+echo Removed plugin/);assert.match(s,/reg query[^\n]*\nif errorlevel 1 \([\s\S]*?exit \/b 1/);assert.match(s,/reg delete[^\n]*\nif errorlevel 1 \([\s\S]*?exit \/b 1\s+\)\s+echo Removed registry/);});
