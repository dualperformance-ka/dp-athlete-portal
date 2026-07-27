import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const publicDir = join(root, 'public');
const index = readFileSync(join(publicDir, 'index.html'), 'utf8');
const worker = readFileSync(join(publicDir, 'sw.js'), 'utf8');
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const failures = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

for (const file of walk(join(root, 'api')).concat(walk(publicDir)).filter((file) => file.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push(`JavaScript syntax failed: ${file}\n${error.stderr || error.message}`);
  }
}

const localAssets = [...index.matchAll(/(?:src|href)="((?:\/)?[^:"#?]+(?:\?[^"#]+)?)"/g)]
  .map((match) => match[1].startsWith('/') ? match[1] : `/${match[1]}`)
  .filter((asset) => /\.(?:js|css)(?:\?|$)/.test(asset));
const cachedAssets = new Set([...worker.matchAll(/'([^']+)'/g)].map((match) => match[1]));

for (const asset of localAssets) {
  const path = join(publicDir, asset.split('?')[0]);
  if (!existsSync(path)) failures.push(`Missing referenced asset: ${asset}`);
  if (!cachedAssets.has(asset)) failures.push(`Service worker is missing current asset: ${asset}`);
}

const publicScripts = walk(publicDir).filter((file) => file.endsWith('.js'));
for (const file of publicScripts) {
  const source = readFileSync(file, 'utf8');
  if (/\bsbClient\s*\.\s*from\s*\(/.test(source)) {
    failures.push(`Direct browser database query remains: ${file}`);
  }
  if (/api\.cloudinary\.com/.test(source)) {
    failures.push(`Direct browser Cloudinary mutation remains: ${file}`);
  }
}

const rewrites = vercel.rewrites || [];
if (!rewrites.some((item) => item.source === '/api/portal-data' && item.destination === '/api/write?mode=portal')) {
  failures.push('Authenticated /api/portal-data rewrite is missing');
}

const apiFunctions = readdirSync(join(root, 'api')).filter((name) => name.endsWith('.js'));
if (apiFunctions.length > 12) failures.push(`Vercel function limit exceeded: ${apiFunctions.length}/12`);

if (!index.includes('accessibility.js?v=1')) failures.push('Accessibility runtime is not loaded');
if (!index.includes('aria-label="Previous training week"')) failures.push('Calendar controls need accessible names');
if (/id="(?:trainingKmCard|weeklyKmCard)"/.test(index)) {
  failures.push('The duplicate weekly target card has returned to the Training schedule');
}
for (const id of ['trainingVolumeStrip', 'weeklyVolumeStrip']) {
  if (!index.includes(`id="${id}"`)) failures.push(`Training volume strip mount is missing: ${id}`);
}

const globalHeaders = (vercel.headers || []).find((entry) => entry.source === '/(.*)');
const csp = globalHeaders?.headers?.find((header) => header.key === 'Content-Security-Policy')?.value || '';
for (const directive of ["object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"]) {
  if (!csp.includes(directive)) failures.push(`CSP is missing: ${directive}`);
}

for (const name of ['ingest.js', 'my-logs.js', 'progress-photos.js', 'reminders.js', 'strava.js', 'write.js']) {
  const source = readFileSync(join(root, 'api', name), 'utf8');
  if (!source.includes('getRequestAthlete')) failures.push(`Protected API lost its athlete auth boundary: api/${name}`);
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`Portal checks passed: ${apiFunctions.length} functions, ${localAssets.length} shell assets, no direct browser DB access.`);
