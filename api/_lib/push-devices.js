// ── PUSH DEVICE HYGIENE ───────────────────────────────────────────────────────
// Push subscriptions accumulate. Every reinstall of the home-screen app, every
// re-granted permission and every Safari point release mints a brand-new
// endpoint, while the previous row survives until Apple returns 404/410 — which
// in practice it often never does. Left alone, one athlete's single iPhone
// collects a dozen rows and every reminder buzzes a dozen times.
//
// These helpers collapse an athlete's rows down to one live subscription per
// physical device and merge the per-row delivery history, so that:
//   * a reminder fires once per device, not once per stale endpoint, and
//   * a freshly minted endpoint (last_sent: {}) never replays reminders the
//     athlete has already been shown on the same phone.
//
// Everything here is pure — no network, no Supabase — so the delivery rules can
// be tested directly.

export const MAX_DEVICES_PER_ATHLETE = 3;

// Coarse device fingerprint: platform + browser family, with every version
// number stripped. A Safari point release ("Version/26.5" -> "Version/26.6")
// must not read as a new handset, which is exactly how one athlete's phone
// became four subscription rows.
export function deviceKey(userAgent) {
  const ua = String(userAgent || '').trim();
  if (!ua) return 'unknown';
  const platform = /iPad/i.test(ua) ? 'ipad'
    : /iPhone|iPod/i.test(ua) ? 'iphone'
    : /Android/i.test(ua) ? 'android'
    : /Macintosh|Mac OS X/i.test(ua) ? 'mac'
    : /Windows/i.test(ua) ? 'windows'
    : /Linux/i.test(ua) ? 'linux'
    : 'other';
  // Order matters: Edge and Chrome both carry "Safari/" in their UA string.
  const browser = /Edg(?:A|iOS)?\//i.test(ua) ? 'edge'
    : /FxiOS|Firefox\//i.test(ua) ? 'firefox'
    : /CriOS|Chrome\//i.test(ua) ? 'chrome'
    : /Safari\//i.test(ua) ? 'safari'
    : 'other';
  return platform + '|' + browser;
}

function rowTime(row) {
  const stamp = (row && (row.updated_at || row.created_at)) || '';
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function groupByAthlete(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const code = String((row && row.athlete_code) || '').toUpperCase();
    if (!code) continue;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(row);
  }
  return groups;
}

// Newest value wins per reminder type. Morning types store a local ISO date
// ("2026-08-17"), coach updates store a full ISO timestamp; both compare
// correctly as plain strings, and a given key never mixes the two formats.
export function mergeLastSent(rows) {
  const merged = {};
  for (const row of rows || []) {
    const last = (row && row.last_sent) || {};
    if (typeof last !== 'object') continue;
    for (const [type, value] of Object.entries(last)) {
      if (!value) continue;
      if (!merged[type] || String(value) > String(merged[type])) merged[type] = String(value);
    }
  }
  return merged;
}

// The athlete's preferences are whatever they last chose, from whichever device
// they last chose it on — a single athlete-level intent rather than a per-row
// setting that silently disagrees with itself. (JOJO switching everything but
// training off on their phone should not leave a second row still shipping
// coach updates.)
export function newestPrefs(rows) {
  let newest = null;
  for (const row of rows || []) {
    if (!row || !row.prefs || typeof row.prefs !== 'object') continue;
    if (!newest || rowTime(row) > rowTime(newest)) newest = row;
  }
  return (newest && newest.prefs) || {};
}

// One live subscription per device: the newest row per fingerprint, then the
// MAX_DEVICES_PER_ATHLETE most recently active of those. Everything else is
// dropped. `pinnedEndpoint` is the subscription that just checked in — it is
// always kept, even if its timestamps have not landed yet.
export function selectLiveDevices(rows, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0
    ? options.limit
    : MAX_DEVICES_PER_ATHLETE;
  const pinned = options.pinnedEndpoint || null;
  const all = (rows || []).filter(Boolean);

  const byDevice = new Map();
  for (const row of all) {
    const key = deviceKey(row.user_agent);
    const current = byDevice.get(key);
    if (!current) { byDevice.set(key, row); continue; }
    if (pinned && current.endpoint === pinned) continue;
    if ((pinned && row.endpoint === pinned) || rowTime(row) > rowTime(current)) byDevice.set(key, row);
  }

  const ranked = [...byDevice.values()].sort((a, b) => {
    if (pinned) {
      if (a.endpoint === pinned) return -1;
      if (b.endpoint === pinned) return 1;
    }
    return rowTime(b) - rowTime(a);
  });

  const keep = ranked.slice(0, limit);
  const kept = new Set(keep.map((row) => row.endpoint));
  const drop = all.filter((row) => !kept.has(row.endpoint));
  return { keep, drop };
}

// ── MANAGED CATEGORIES ───────────────────────────────────────────────────────
// Coaching reminders are part of the service, not a feature athletes opt into,
// so the portal offers no per-category toggles and every athlete receives every
// category. Exemptions are agreed case by case and recorded in the database
// (athletes.notifications_managed = false), never in the portal UI.
//
// Add a category here as it ships and every managed athlete gets it with no
// migration and no re-consent.
export const MANAGED_CATEGORIES = ['sessions', 'logging', 'checkins', 'photos', 'calls', 'coach'];

const MANAGED_PREFS = Object.freeze(
  MANAGED_CATEGORIES.reduce((prefs, key) => Object.assign(prefs, { [key]: true }), {})
);

// Returns a fresh object every call — a caller mutating the result must never
// reach back into the shared constant.
export function resolvePrefs(rows, options = {}) {
  return options.managed ? Object.assign({}, MANAGED_PREFS) : newestPrefs(rows);
}
