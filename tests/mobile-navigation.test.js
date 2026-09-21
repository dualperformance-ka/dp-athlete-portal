import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const nav = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const styles = readFileSync(join(root, 'public', 'styles.css'), 'utf8');
const sw = readFileSync(join(root, 'public', 'sw.js'), 'utf8');

function mobileNavMarkup() {
  const start = index.indexOf('<nav class="mobile-nav"');
  const end = index.indexOf('</nav>', start);
  return index.slice(start, end);
}

function desktopRailMarkup() {
  const start = index.indexOf('<div class="tabs"');
  const end = index.indexOf('<!-- TRAINING -->', start);
  return index.slice(start, end);
}

test('phone, tablet, and desktop expose the same five destinations in the same order', () => {
  const order = ['today', 'week', 'log', 'progress', 'coaching'];
  for (const [markup, attribute] of [[mobileNavMarkup(), 'data-mobile-tab'], [desktopRailMarkup(), 'data-tab']]) {
    let last = -1;
    for (const destination of order) {
      const position = markup.indexOf(`${attribute}="${destination}"`);
      assert.ok(position > last, `${destination} should follow the preceding primary destination`);
      last = position;
    }
  }
  assert.match(mobileNavMarkup(), /class="[^"]*mobile-nav-log[^"]*"[^>]+data-mobile-tab="log"/);
  assert.match(styles, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(styles, /--bottom-bar-h:calc\(72px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(styles, /--railw:248px/);
});

test('retired primary destinations and the More sheet are absent', () => {
  const primary = mobileNavMarkup() + desktopRailMarkup();
  for (const retired of ['nutrition', 'calls', 'checkin', 'training', 'weekly', 'more']) {
    assert.doesNotMatch(primary, new RegExp(`data-(?:mobile-)?tab="${retired}"`));
  }
  assert.doesNotMatch(index, /id="moreMenu"|class="more-menu/);
  assert.doesNotMatch(nav, /function toggleMoreMenu|trainingView|function applyTrainingView/);
});

test('the destination state is a plain map and analytics receives only new destination names', () => {
  assert.match(nav, /var PORTAL_DESTINATIONS=\{/);
  assert.match(nav, /today:\{panel:'training'/);
  assert.match(nav, /week:\{panel:'weekly'/);
  assert.match(nav, /coaching:\{panel:'calls'/);
  assert.match(nav, /track\('tab_viewed',\{tab:destination\}\)/);
  assert.doesNotMatch(nav, /tab==='weekly'\?'training'/);
});

test('coaching owns the only owed-work dot and keeps check-in one tap away', () => {
  const markup = mobileNavMarkup();
  assert.match(markup, /data-mobile-tab="coaching"[\s\S]*id="mobileCoachingDot"/);
  assert.match(index, /id="callsSurface"/);
  assert.match(nav, /onclick="openCheckinSheet\(\)"/);
  assert.doesNotMatch(index, /mobileCallsDot|mobileCheckinDot/);
  assert.equal((markup.match(/mobile-nav-dot/g) || []).length, 2,
    'only Coaching and Progress may expose badges');
});

test('the header is contextual and the avatar opens the profile actions', () => {
  const header = index.slice(index.indexOf('<header>'), index.indexOf('</header>'));
  assert.match(header, /id="portalSectionLabel"/);
  assert.match(header, /id="saveStatePill"/);
  assert.match(header, /id="notificationBell"/);
  assert.match(header, /id="profileAvatar"[^>]+onclick="toggleProfileMenu\(true\)"/);
  assert.doesNotMatch(header, /refreshBtn|themeToggle|goalsBtn|data-portal-dest="handbook"|data-portal-dest="comms"/);
  assert.match(index, /id="profileMenu"[\s\S]*Goals[\s\S]*Guide[\s\S]*Preferences[\s\S]*Theme[\s\S]*Data and privacy[\s\S]*Sign out/);
});

test('the reconciliation body classes are completely gone', () => {
  const retired = /mobile-portal-home|mobile-training-calendar|mobile-checkin-tab|mobile-progress-tab|mobile-calls-tab|mobile-secondary-tab/;
  assert.doesNotMatch(styles, retired);
  assert.doesNotMatch(nav, retired);
});

test('nutrition targets have homes on Today and Week and retain the 60 second guard', () => {
  assert.match(index, /id="todayFuelTarget"/);
  assert.match(index, /id="weekFuelTargets"/);
  assert.match(nav, /\(destination==='today'\|\|destination==='week'\)&&Date\.now\(\)-_nutLastLoad>60000/);
});

// The exact version values should change freely. What matters is that the page
// and service worker agree, so installed PWAs cannot remain on a stale shell.
test('installed PWAs receive the new navigation shell', () => {
  const served = (source, file) => {
    const match = source.match(new RegExp(file.replace(/[.]/g, '\\.') + '\\?v=(\\d+)'));
    assert.ok(match, `${file} should be served with a version in this file`);
    return match[1];
  };
  for (const file of ['styles.css', '03-nav-nudges.js', '06-nutrition.js', '08-training.js']) {
    assert.equal(served(index, file), served(sw, file),
      `${file}: index.html and sw.js must request the same version`);
  }
  assert.match(sw, /const CACHE_NAME = 'dp-athlete-v\d+'/);
});
