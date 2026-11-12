// Injects the list of built files into dist/sw.js so the service worker can precache the app shell.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', process.env.OUT_DIR || 'dist');
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = resolve(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [relative(dist, p).replaceAll('\\', '/')];
});
const files = walk(dist).filter((f) => f !== 'sw.js' && !f.endsWith('.map') && !f.endsWith('.json') && !/-(cyrillic|vietnamese|latin-ext)/.test(f) && !/\.woff$/.test(f));
// The cache name only changes when the app shell changes, not on every hourly weather deploy.
const hash = createHash('sha1');
for (const f of files) { hash.update(f); hash.update(readFileSync(resolve(dist, f))); }
const list = ['./', ...files.filter((f) => f !== 'index.html').map((f) => './' + f)];
const swPath = resolve(dist, 'sw.js');
const sw = readFileSync(swPath, 'utf8')
  .replace('"__PRECACHE__"', JSON.stringify(list))
  .replace('__BUILD__', hash.digest('hex').slice(0, 10));
writeFileSync(swPath, sw);
console.log(`sw.js: precaching ${list.length} files`);
