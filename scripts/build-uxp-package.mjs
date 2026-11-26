// Build the UXP deliverables in one step:
//   1. output/font-mixer-uxp-<version>-cep-source-<stamp>.ccx
//   2. output/font-mixer-uxp-<version>-portable-<stamp>.zip
// The portable zip carries the plugin folder, both installers, the registration
// helper and the .ccx itself, so a machine without Creative Cloud Desktop can
// still install by running a .bat file.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(process.cwd());
const pluginDir = join(root, 'com.figmatoolbox.ps.uxp');
const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'));
const version = manifest.version;

const now = new Date();
const pad = n => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

const outDir = join(root, 'output');
mkdirSync(outDir, { recursive: true });

const ccx = join(outDir, `font-mixer-uxp-${version}-cep-source-${stamp}.ccx`);
const built = spawnSync(process.execPath, [join(root, 'artifacts', 'uxp-ccx', 'build-ccx.mjs'), pluginDir, ccx], {
  encoding: 'utf8'
});
if (built.status !== 0) {
  process.stderr.write(built.stdout || '');
  process.stderr.write(built.stderr || '');
  throw new Error('build-ccx failed');
}

const latestCcx = join(outDir, 'font-mixer-uxp-latest.ccx');
cpSync(ccx, latestCcx);

const stage = join(outDir, `font-mixer-uxp-${version}-portable-${stamp}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(pluginDir, join(stage, 'com.figmatoolbox.ps.uxp'), { recursive: true });
for (const file of [
  'install-photoshop-uxp-plugin.bat',
  'uninstall-photoshop-uxp-plugin.bat',
  'install-photoshop-uxp-from-ccx.bat',
  'uxp-plugin-register.ps1'
]) {
  const from = join(root, file);
  if (!existsSync(from)) throw new Error(`missing ${file}`);
  copyFileSync(from, join(stage, file));
}
cpSync(ccx, join(stage, 'font-mixer-uxp-latest.ccx'));

const installText = [
  `盗版PS的工具箱 UXP ${version} 便携安装`,
  '',
  '方式一（推荐，不需要 Creative Cloud Desktop）',
  '  1. 先退出 Photoshop。',
  '  2. 解压本压缩包到任意目录（不要在压缩包里直接运行）。',
  '  3. 双击 install-photoshop-uxp-plugin.bat。',
  '  4. 启动 Photoshop，在 增效工具/Plugins 菜单打开“盗版PS的工具箱”。',
  '',
  '方式二（拖拽 .ccx，同样不需要 Creative Cloud Desktop）',
  '  把 font-mixer-uxp-latest.ccx 拖到 install-photoshop-uxp-from-ccx.bat 上。',
  '',
  '安装脚本会复制到：',
  '%APPDATA%\\Adobe\\UXP\\Plugins\\External\\com.figmatoolbox.ps.uxp',
  '并写入 %APPDATA%\\Adobe\\UXP\\PluginsInfo\\v1\\PS.json，',
  '让 Photoshop 像 CCX 商店安装一样识别插件；旧的 com.figmatoolbox.ps.uxp_* 版本目录会被清理。',
  '',
  '如果面板没有出现：',
  '  1. 确认安装前已完全退出 Photoshop，然后再启动；',
  '  2. 打开 编辑 > 首选项 > 增效工具，勾选“启用开发人员模式”；',
  '  3. 仍不行就再运行一次安装脚本。',
  '',
  '卸载：双击 uninstall-photoshop-uxp-plugin.bat，然后重启 Photoshop。',
  ''
].join('\r\n');
writeFileSync(join(stage, 'INSTALL.txt'), installText, 'utf8');

const zipPath = join(outDir, `font-mixer-uxp-${version}-portable-${stamp}.zip`);
rmSync(zipPath, { force: true });
const zipped = spawnSync('powershell', [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-Command',
  'Compress-Archive -Path (Join-Path $env:STAGE_DIR "*") -DestinationPath $env:ZIP_PATH -CompressionLevel Optimal -Force'
], {
  encoding: 'utf8',
  env: { ...process.env, STAGE_DIR: stage, ZIP_PATH: zipPath }
});
if (zipped.status !== 0) {
  process.stderr.write(zipped.stdout || '');
  process.stderr.write(zipped.stderr || '');
  throw new Error('Compress-Archive failed');
}
// The staging folder is only an input to Compress-Archive; the zip is the
// deliverable and can be extracted when someone needs to inspect it.
rmSync(stage, { recursive: true, force: true });

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
const size = path => readFileSync(path).length;
console.log(`version=${version}`);
console.log(`ccx=${ccx}`);
console.log(`ccxBytes=${size(ccx)} sha256=${sha(ccx)}`);
console.log(`zip=${zipPath}`);
console.log(`zipBytes=${size(zipPath)} sha256=${sha(zipPath)}`);
