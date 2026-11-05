// Display-only provider data. Never persist this feed into training logs or AI inputs.
export function garminActivity(row) {
  if (!row || row.id == null || !row.startTime) return null;
  const raw = String(row.type || '').toLowerCase();
  const sport = /run/.test(raw) ? 'Run' : /cycl|bik|rid/.test(raw) ? 'Ride' : /swim/.test(raw) ? 'Swim' : 'Workout';
  const start = new Date(row.startTime);
  if (!Number.isFinite(start.getTime())) return null;
  return { id: 'garmin:' + row.id, provider: 'Garmin', device: row.device || null, name: row.name || sport,
    type: sport, sport_type: sport, start_date: start.toISOString(),
    start_date_local: row.localDate ? row.localDate + 'T' + start.toISOString().slice(11, 19) : start.toISOString(),
    distance: Number(row.distanceM) || 0, moving_time: Number(row.durationS) || 0,
    elapsed_time: Number(row.durationS) || 0, average_heartrate: row.avgHr || null };
}

export function sameRecording(a, b) {
  const sport = value => /run/i.test(value) ? 'Run' : /ride|cycl|bik/i.test(value) ? 'Ride' : /swim/i.test(value) ? 'Swim' : String(value);
  if (sport(a.sport_type || a.type) !== sport(b.sport_type || b.type)) return false;
  const startA = Date.parse(a.start_date), startB = Date.parse(b.start_date);
  if (!Number.isFinite(startA) || !Number.isFinite(startB) || Math.abs(startA - startB) > 90000) return false;
  const distanceA = Number(a.distance), distanceB = Number(b.distance);
  const durationA = Number(a.elapsed_time || a.moving_time), durationB = Number(b.elapsed_time || b.moving_time);
  // Require both metrics: missing data must not erase a genuine second activity.
  return distanceA > 0 && distanceB > 0 && durationA > 0 && durationB > 0 &&
    Math.abs(distanceA - distanceB) <= Math.max(150, Math.max(distanceA, distanceB) * .03) &&
    Math.abs(durationA - durationB) <= Math.max(60, Math.max(durationA, durationB) * .05);
}

export function mergeConnectedActivities(strava, garmin) {
  const preferred = (garmin && garmin.connected ? garmin.activities || [] : []).map(garminActivity).filter(Boolean);
  const other = strava && strava.connected && strava.activitiesAvailable !== false ? strava.activities || [] : [];
  const used = new Set();
  other.forEach(activity => {
    const index = preferred.findIndex((candidate, i) => candidate.provider === 'Garmin' && !used.has(i) && sameRecording(candidate, activity));
    if (index >= 0) used.add(index);
    else preferred.push({ ...activity, provider: 'Strava' });
  });
  return { connected: !!((strava && strava.connected && strava.activitiesAvailable !== false) || (garmin && garmin.connected)),
    activitiesAvailable: true, activities: preferred.sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date)) };
}

if (typeof window !== 'undefined') {
  window.mergeConnectedActivities = mergeConnectedActivities;
  window.loadConnectedActivities = async function() {
    const results = await Promise.all([window._stravaLoadPromise, window._garminLoadPromise].map(p => Promise.resolve(p).catch(() => null)));
    return mergeConnectedActivities(results[0], results[1]);
  };
  window.renderConnectedActivities = async function() {
    const owner = typeof athlete !== 'undefined' && athlete && athlete.code;
    const data = await window.loadConnectedActivities();
    if (!owner || !athlete || athlete.code !== owner) return;
    window._connectedActivityFeed = data;
    const el = document.getElementById('connectedActivities');
    if (!el) return;
    // Only add the combined feed when Garmin is enabled and connected.
    const garmin = await Promise.resolve(window._garminLoadPromise).catch(() => null);
    if (!garmin || !garmin.connected) { el.hidden = true; el.innerHTML = ''; if(typeof invalidateProgrammeVolume==='function')invalidateProgrammeVolume(); if(typeof paintStravaMatches==='function')paintStravaMatches(); if(typeof renderTrainingVolumeStrips==='function')renderTrainingVolumeStrips(); return; }
    const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const rows = data.activities.slice(0, 10).map(a => '<li><div><strong>' + escape(a.name || a.type) + '</strong><small>' + escape(String(a.start_date_local || a.start_date).slice(0,10)) + ' · ' + escape(a.provider === 'Garmin' ? 'Garmin' + (a.device ? ' ' + String(a.device).replace(/^Garmin\s*/i, '') : '') : 'Strava') + '</small></div><span>' + (Number(a.distance)/1000).toFixed(1) + ' km · ' + Math.round(Number(a.moving_time)/60) + ' min</span></li>').join('');
    el.hidden = false;
    el.innerHTML = '<details open><summary>Connected activities <span>Garmin + Strava · each activity counted once</span></summary>' + (rows ? '<ul>' + rows + '</ul>' : '<p>Waiting for your first Garmin sync. History can take a little while to arrive.</p>') + '<p class="connected-attribution">Activity data supplied by Garmin and Strava. Each recording appears once across your connected accounts.</p></details>';
    if (typeof invalidateProgrammeVolume === 'function') invalidateProgrammeVolume();
    if (typeof paintStravaMatches === 'function') paintStravaMatches();
    if (typeof renderTrainingVolumeStrips === 'function') renderTrainingVolumeStrips();
  };
  window.garminSessionResultHtml = function(session) {
    const feed = window._connectedActivityFeed;
    if (!feed || !session || !window.matchActivityToSession || typeof getType !== 'function' || getType(session) !== 'run') return '';
    // Allocate each recording once across the loaded programme, including two-a-days.
    const candidates = (typeof allSessions !== 'undefined' && allSessions || []).filter(s => getType(s) === 'run' && s.date);
    if (!candidates.some(s => String(s.id) === String(session.id))) candidates.push(session);
    const claimed = new Set();
    let match = null;
    for (const planned of candidates) {
      const result = window.matchActivityToSession(planned, feed.activities, { plannedKm: typeof plannedRunKm === 'function' ? plannedRunKm(planned) : 0, claimedActivityIds: claimed });
      if (!result.matched) continue;
      (result.activityKeys || [String(result.activity.id)]).forEach(key => claimed.add(key));
      if (String(planned.id) === String(session.id)) match = result;
    }
    if (!match) return '';
    if (!match.matched || !match.activity || match.activity.provider !== 'Garmin') return '';
    const activity = match.activity;
    return '<section class="run-hero" aria-label="Your run from Garmin"><div class="run-hero-top"><span class="run-hero-source">' + String(activity.device ? 'Garmin ' + String(activity.device).replace(/^Garmin\s*/i, '') : 'Garmin').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])) + '</span></div><div class="run-hero-main"><span class="run-hero-label">Recorded run</span><strong class="run-hero-number">' + (activity.distance/1000).toFixed(1) + ' km</strong></div><div class="run-hero-stats"><div class="run-hero-stat"><span>Duration</span><strong>' + Math.round(activity.moving_time/60) + ' min</strong></div>' + (activity.average_heartrate ? '<div class="run-hero-stat"><span>Avg HR</span><strong>' + Number(activity.average_heartrate) + ' bpm</strong></div>' : '') + '</div><p>Activity data supplied by Garmin. ' + (match.confidence === 'low' ? 'Possible session match. ' : '') + 'Your session feedback is saved separately.</p></section>';
  };
}
