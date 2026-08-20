import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseImageData } from '../api/progress-photos.js';

const root = new URL('..', import.meta.url).pathname;
const route = readFileSync(join(root, 'api', 'progress-photos.js'), 'utf8');
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260820115252_integrated_notification_inbox_and_storage.sql'), 'utf8');

test('progress photo uploads decode only supported image data URLs', () => {
  const parsed = parseImageData('data:image/png;base64,aGVsbG8=');
  assert.equal(parsed.mimeType, 'image/png');
  assert.equal(parsed.bytes.toString(), 'hello');
  assert.throws(() => parseImageData('data:text/plain;base64,aGVsbG8='));
});

test('new progress photos use private Supabase storage and Postgres metadata', () => {
  assert.match(route, /uploadObject\(BUCKET/);
  assert.match(route, /createSignedObjectUrl\(BUCKET/);
  assert.match(route, /upsert\('progress_photos'/);
  assert.match(route, /migrateLegacyPhotos/, 'historic Cloudinary photos must be copied forward on first recall');
  assert.doesNotMatch(route, /image\/destroy/, 'new deletes must never mutate the legacy store');
  assert.match(migration, /'progress-photos',[\s\S]*false/);
  assert.match(migration, /create table if not exists public\.progress_photos/);
  assert.match(migration, /revoke all on table public\.progress_photos from anon, authenticated/);
});
