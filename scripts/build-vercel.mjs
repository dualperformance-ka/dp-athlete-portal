import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transform } from 'esbuild';

// This script minifies public/ IN PLACE. That is correct on Vercel, where the
// checkout is ephemeral, and destructive anywhere else: a local run overwrites
// the readable sources in the repo and there is no way back to them. So it only
// runs where the output is throwaway, or when someone says so explicitly.
if (!process.env.VERCEL && !process.argv.includes('--force')) {
  console.error('build-vercel.mjs minifies public/ in place and would overwrite your sources.');
  console.error('It runs automatically on Vercel. To run it here anyway, pass --force.');
  process.exit(1);
}

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const publicDir = join(root, 'public');
const topLevel = (await readdir(publicDir)).filter(name => /\.(?:js|css)$/.test(name)).map(name => join(publicDir, name));
const modules = (await readdir(join(publicDir, 'js'))).filter(name => name.endsWith('.js')).map(name => join(publicDir, 'js', name));
const files = topLevel.concat(modules);

const outputs = await Promise.all(files.map(async file => {
  const loader = file.endsWith('.css') ? 'css' : 'js';
  const source = await readFile(file, 'utf8');
  const result = await transform(source, {
    loader,
    minify: true,
    target: loader === 'js' ? 'es2020' : undefined,
    legalComments: 'none',
  });
  return [file, result.code];
}));

await Promise.all(outputs.map(([file, code]) => writeFile(file, code)));
console.log(`Minified ${outputs.length} portal assets in the Vercel build output.`);
