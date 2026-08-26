import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transform } from 'esbuild';

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
