import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const nutrition = readFileSync(new URL('../public/js/06-nutrition.js', import.meta.url), 'utf8');
const progress = readFileSync(new URL('../public/js/07-progress.js', import.meta.url), 'utf8');
const training = readFileSync(new URL('../public/js/08-training.js', import.meta.url), 'utf8');
const nudges = readFileSync(new URL('../public/js/03-nav-nudges.js', import.meta.url), 'utf8');
const publicJs = ['01-core','02-login-goals','03-nav-nudges','04-checkin','05-handbook','06-nutrition','07-progress','08-strength-engine','08-training-focus','08-training','09-logging','10-boot']
  .map(name => readFileSync(new URL(`../public/js/${name}.js`, import.meta.url), 'utf8')).join('\n');

test('readouts own the live-number typography and colour contract', () => {
  assert.match(css, /\.readout[\s\S]*font-family:var\(--display\)[\s\S]*font-size:var\(--fs-readout\)[\s\S]*font-weight:700/);
  assert.match(css, /\.readout[\s\S]*font-variant-numeric:tabular-nums/);
  assert.match(css, /\.readout[\s\S]*color:var\(--readout\)/);
  assert.match(css, /\.readout-unit/);
  assert.match(css, /\.readout-delta/);
  assert.match(html + nutrition + training + nudges, /class="[^"]*readout/);
});

test('metric bars share one accessible implementation', () => {
  assert.match(css, /\.metric-bar[\s\S]*height:/);
  assert.match(css, /\.metric-bar-fill/);
  assert.match(html, /id="heroComplianceProgress"[^>]*role="progressbar"[^>]*aria-valuemin="0"/);
  assert.match(html, /id="photoCurrentProgress"[^>]*role="progressbar"[^>]*aria-valuemin="0"[^>]*aria-valuemax="5"/);
  assert.match(training, /heroComplianceProgress[\s\S]*aria-valuenow/);
  assert.match(progress, /photoCurrentProgress[\s\S]*aria-valuenow/);
  assert.match(nutrition, /class="metric-bar wkm-track"/);
});

test('one CSS ring replaces the dead SVG gauge builders', () => {
  assert.match(css, /\.ring[\s\S]*conic-gradient[\s\S]*calc\(var\(--value\)\*1%\)/);
  for (const size of ['32','44','52','72']) assert.match(css, new RegExp(`\\.ring--${size}`));
  assert.doesNotMatch(nutrition, /function buildKmGauge|function buildGymGauge|gaugePt|GAUGE_SWEEP/);
  assert.doesNotMatch(publicJs, /buildKmGauge\(|buildGymGauge\(/);
  assert.match(html, /hero-readiness-ring ring ring--32/);
  assert.match(nutrition, /sport-target-track ring ring--72/);
});

test('chips expose semantic variants and session type shape', () => {
  for (const variant of ['neutral','accent','watch','done','pb','strava']) assert.match(css, new RegExp(`\\.chip--${variant}`));
  assert.match(training, /session-mark session-mark--['"]?\+getType\(s\)/);
  assert.match(css, /\.session-mark--run[\s\S]*border-radius:var\(--r-pill\)/);
  assert.match(css, /\.session-mark--strength[\s\S]*border:[^;]*solid/);
  assert.match(css, /\.session-mark--swim[\s\S]*border-radius:/);
});

test('all chart families compose the shared frame', () => {
  assert.match(css, /\.chart-frame/);
  assert.match(css, /\.chart-grid[\s\S]*var\(--t-4\)/);
  assert.match(css, /\.chart-target-band/);
  assert.match(css, /\.chart-endpoint/);
  assert.match(css, /\.chart-legend/);
  assert.match(html, /id="pgChart" class="chart-frame/);
  assert.match(html, /id="pgVolumeChart" class="chart-frame/);
  assert.match(nutrition, /chart-frame vstrip-running-block/);
  assert.match(training, /chart-frame chart-frame--sparkline exercise-history-mini/);
  assert.match(nudges, /chart-frame chart-frame--history pb-history-card/);
});

test('skeleton, empty and error states stay distinct', () => {
  assert.doesNotMatch(html + publicJs, /ldots|ldot/);
  assert.match(css, /\.skeleton/);
  assert.match(css, /\.empty-state/);
  assert.match(css, /\.error-state/);
  assert.match(html, /class="loading skeleton skeleton--session"/);
  assert.match(html, /class="load-error error-state"/);
  assert.match(html, /class="noplan empty-state"/);
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*\.skeleton/);
});
