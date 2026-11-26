// 生成 .ccx（= zip），口径对齐 Adobe UDT 的 Package：manifest.json 在根、条目用正斜杠、忽略同款文件。
// 为什么不用 build-ccx.ps1：本机 ExecutionPolicy 禁止运行 .ps1，powershell -File 也拿不到脚本内变量。
// 用法: node build-ccx.mjs <srcDir> <outFile>
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep, extname, basename, dirname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const SKIP_NAMES = new Set(['.uxprc', '.gitignore', 'yarn.lock', '.npmignore', '.DS_Store', 'manifest.json', 'package-lock.json']);
const SKIP_EXT = new Set(['.ccx', '.xdx']);

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const [srcArg, outArg] = process.argv.slice(2);
if (!srcArg || !outArg) {
  console.error('usage: node build-ccx.mjs <srcDir> <outFile>');
  process.exit(2);
}
const src = srcArg.replace(/[\\/]+$/, '');
const manifestPath = join(src, 'manifest.json');
const manifestRaw = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestRaw);
if (!manifest.id) throw new Error('manifest.id missing');
// 与 UDT 一致：根 manifest.json 用 2 空格缩进重写
const manifestNormalized = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

const entries = [{ name: 'manifest.json', data: manifestNormalized }];
for (const full of walk(src)) {
  const name = basename(full);
  if (SKIP_NAMES.has(name)) continue;
  if (SKIP_EXT.has(extname(full).toLowerCase())) continue;
  if (name.startsWith('.')) continue;
  const rel = relative(src, full).split(sep).join('/');
  entries.push({ name: rel, data: readFileSync(full) });
}

const chunks = [];
const central = [];
let offset = 0;
const now = new Date();
const { time, date } = dosTime(now);

for (const e of entries) {
  const nameBuf = Buffer.from(e.name, 'utf8');
  const crc = crc32(e.data);
  const deflated = deflateRawSync(e.data, { level: 9 });
  const useDeflate = deflated.length < e.data.length;
  const payload = useDeflate ? deflated : e.data;
  const method = useDeflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(e.data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, payload);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(time, 12);
  cd.writeUInt16LE(date, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(payload.length, 20);
  cd.writeUInt32LE(e.data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([cd, nameBuf]));

  offset += local.length + nameBuf.length + payload.length;
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...chunks, cdBuf, eocd]);
mkdirSync(dirname(outArg), { recursive: true });
writeFileSync(outArg, zip);

console.log(`out=${outArg}`);
console.log(`bytes=${zip.length}`);
console.log(`sha256=${createHash('sha256').update(zip).digest('hex').toUpperCase()}`);
console.log('entries:');
for (const e of entries) console.log(`  ${e.name} (${e.data.length})`);