import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const nav = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const styles = readFileSync(join(root, 'public', 'styles.css'), 'utf8');
const sw = readFileSync(join(root, 'public', 'sw.js'), 'utf8');

function mobileNavMarkup() {
  const start = index.indexOf('<nav class="mobile-nav"');
  const end = index.indexOf('</nav>', start);
  return index.slice(start, end);
}

test('Nutrition is a first-class mobile destination in the intended order', () => {
  const markup = mobileNavMarkup();
  const order = ['home', 'training', 'nutrition', 'progress', 'more'];
  let last = -1;
  for (const tab of order) {
    const position = markup.indexOf(`data-mobile-tab="${tab}"`);
    assert.ok(position > last, `${tab} should follow the preceding primary destination`);
    last = position;
  }
  assert.match(markup, /data-mobile-tab="nutrition"[^>]+onclick="switchTab\('nutrition'\)"/);
  assert.match(markup, /#i-utensils/);
  assert.doesNotMatch(markup, /data-mobile-tab="checkin"/);
});

test('Nutrition owns its active navigation state instead of highlighting More', () => {
  assert.match(nav, /tab==='nutrition'\?'nutrition'/);
  assert.match(nav, /if\(tab==='nutrition'\)\{setMobileNav\('nutrition'\);return;\}/);
  assert.match(nav, /tab==='checkin'\|\|isMobileSecondary\?'more'/);
  assert.match(nav, /if\(tab==='checkin'\|\|\['goals','handbook','comms'\]\.indexOf\(tab\)>=0\)\{setMobileNav\('more'\);return;\}/);
});

test('the five-item mobile bar remains evenly sized and the duplicate Nutrition entry is gone', () => {
  assert.match(styles, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  const moreStart = index.indexOf('<div class="more-menu"');
  const moreEnd = index.indexOf('</div>\n\n  <div class="ql-modal"', moreStart);
  const moreMarkup = index.slice(moreStart, moreEnd);
  assert.doesNotMatch(moreMarkup, /onclick="switchTab\('nutrition'\)"/);
});

test('Check-in remains prominent on Home and at the top of More when due', () => {
  assert.match(index, /id="checkinNudge"[^>]+onclick="switchTab\('checkin'\)"/);
  const moreStart = index.indexOf('<div class="more-menu"');
  const moreMarkup = index.slice(moreStart);
  assert.match(moreMarkup, /onclick="switchTab\('checkin'\)"[\s\S]*id="moreCheckinDue">Due/);
  assert.match(mobileNavMarkup(), /data-mobile-tab="more"[\s\S]*id="mobileCheckinDot"/);
  assert.match(nav, /moreCheckinDue[\s\S]*classList\.toggle\('visible',!done\)/);
});

test('installed PWAs receive the new navigation shell', () => {
  assert.match(index, /styles\.css\?v=118/);
  assert.match(index, /03-nav-nudges\.js\?v=96/);
  assert.match(sw, /dp-athlete-v150/);
  assert.match(sw, /styles\.css\?v=118/);
  assert.match(sw, /03-nav-nudges\.js\?v=96/);
});
