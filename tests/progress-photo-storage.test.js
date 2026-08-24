import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseImageData } from '../api/progress-photos.js';

const root = new URL('..', import.meta.url).pathname;
const route = readFileSync(join(root, 'api', 'progress-photos.js'), 'utf8');
test('progress photo uploads decode only supported image data URLs', () => {
  const parsed = parseImageData('data:image/png;base64,aGVsbG8=');
  assert.equal(parsed.mimeType, 'image/png');
  assert.equal(parsed.bytes.toString(), 'hello');
  assert.throws(() => parseImageData('data:text/plain;base64,aGVsbG8='));
});

test('progress photos use the same Cloudinary public IDs as the coach dashboard', () => {
  assert.match(route, /dp_progress\/\$\{athlete\}\/\$\{week\}\/\$\{athlete\}_\$\{week\}_\$\{slot\}/);
  assert.match(route, /api\.cloudinary\.com\/v1_1/);
  assert.match(route, /resources\/image\/upload/);
  assert.match(route, /image\/destroy/);
  assert.doesNotMatch(route, /uploadObject\(BUCKET/);
  assert.doesNotMatch(route, /createSignedObjectUrl\(BUCKET/);
});

test('the authenticated athlete identity controls the Cloudinary folder', () => {
  assert.match(route, /cleanSlug\(identity\.athlete\.code\)/);
  assert.doesNotMatch(route, /cleanSlug\(body\.athleteCode\)/);
});
