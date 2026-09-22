import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const styles=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
const logging=fs.readFileSync(new URL('../public/js/09-logging.js',import.meta.url),'utf8');

test('phase 2 exposes the complete shared token contract',()=>{
  [
    '--edge-lift:','--edge-float:','--r-4:20px','--sp-8:64px',
    '--dur-state:120ms','--dur-reveal:180ms','--dur-sheet:240ms',
    '--dur-celebrate:320ms','--ease-in:cubic-bezier(.2,.8,.2,1)',
    '--ease-out:cubic-bezier(.4,0,1,1)','--c1:#92D2ED','--c2:#6FB6C9',
    '--c3:#A0AEB6','--c4:#C9BFA8','--c5:#E0A96D','--c6:#F0AD4E'
  ].forEach(token=>assert.ok(styles.includes(token),token));
});

test('buttons share one component contract and real interaction states',()=>{
  assert.match(styles,/\.btn,\s*\.calls-btn/);
  assert.match(styles,/\.btn--primary/);
  assert.match(styles,/\.btn--secondary/);
  assert.match(styles,/\.btn--quiet/);
  assert.match(styles,/\.btn--danger/);
  assert.match(styles,/\.btn[^{}]*:focus-visible/);
  assert.match(styles,/\[aria-busy="true"\]::after/);
  assert.match(styles,/@media\s*\(prefers-reduced-motion:reduce\)[\s\S]*?\[aria-busy="true"\]::after/);
  assert.match(styles,/min-height:44px/);
});

test('session saves keep their accessible name while busy',()=>{
  const lock=logging.slice(logging.indexOf('function lockSaveButton('),logging.indexOf('function unlockSaveButton('));
  assert.doesNotMatch(lock,/textContent\s*=/);
  assert.match(logging,/function setButtonBusy\(/);
  assert.match(logging,/setAttribute\('aria-busy','true'\)/);
  assert.match(logging,/setTimeout\([^]*?,2000\)/);
});

test('fields and cards expose shared aliases',()=>{
  assert.match(styles,/\.field,\s*\.stat-input/);
  assert.match(styles,/\.field--range/);
  assert.match(styles,/\.field\.is-error/);
  assert.match(styles,/\.card--flat/);
  assert.match(styles,/\.card--raised/);
  assert.match(styles,/\.card--accent/);
  assert.match(styles,/\.card,\s*\.accordion-card/);
});

test('focused fields use one premium DP-blue illuminated edge in both themes',()=>{
  assert.match(styles,/--focus-ring:#92d2ed/);
  assert.match(styles,/--focus-surface:color-mix\(in srgb,var\(--g-well\) 94%,var\(--focus-ring\)\)/);
  assert.match(styles,/\.outdoor-mode\{[^}]*--focus-ring:var\(--run-deep\)[^}]*--focus-surface:color-mix\(in srgb,var\(--color-white\) 97%,var\(--focus-ring\)\)/);
  const start=styles.lastIndexOf('.field:focus-visible');
  const focusedFields=styles.slice(start,styles.indexOf('\n}',start)+2);
  assert.match(focusedFields,/outline:none/);
  assert.match(focusedFields,/background:var\(--focus-surface\)/);
  assert.match(focusedFields,/0 0 0 2px var\(--focus-ring\)/);
  assert.match(focusedFields,/0 6px 18px var\(--focus-ring-soft\)/);
});

test('converted component classes have no daylight component overrides',()=>{
  const classes=[
    'calls-btn','calls-btn-primary','ci-btn-back','ci-btn-next','comms-btn',
    'comms-btn-quiet','data-request-btn','focus-done-btn','goals-prompt-btn',
    'lbtn','load-error-btn','month-today-btn','photo-next-btn','quicklog-btn',
    'reschedule-btn','save-run-btn','savebtn','todaybtn','accordion-card',
    'calls-card','card','ci-card','ci-testimonial-card','comms-card',
    'goals-section-card','hb-card','insight-card','pb-history-card',
    'programme-details-card','progress-card','progress-collapsible-card',
    'progress-photo-card','run-prescription-card','vstrip-card','week-card','wkm-card'
  ];
  const daylightSelectors=[];
  for(const match of styles.matchAll(/([^{}]+)\{[^{}]*\}/g)){
    match[1].split(',').forEach(selector=>{
      if(/(^|[\s>+~])(?:html\.)?\.outdoor-mode\b/.test(selector)) daylightSelectors.push(selector);
    });
  }
  classes.forEach(name=>assert.ok(!daylightSelectors.some(selector=>new RegExp('\\.'+name+'(?:[^a-zA-Z0-9_-]|$)').test(selector)),name));
});
