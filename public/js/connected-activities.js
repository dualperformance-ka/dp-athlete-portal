// Connected activity feed: Garmin first, Strava fills the gaps.
//
// Garmin is the primary source (Karl, Nov 2026): session matching reads this
// feed, so a Garmin recording completes a session and its numbers are what the
// training log stores. A recording only Strava holds still completes one.
// The feed itself is never sent to an AI input; the coaches dashboard's AI
// summary reads weekly check-ins and body/nutrition averages, not these logs.
export function garminActivity(row) {
  if (!row || row.id == null || !row.startTime) return null;
  const raw = String(row.type || '').toLowerCase();
  const sport = /run/.test(raw) ? 'Run' : /cycl|bik|rid/.test(raw) ? 'Ride' : /swim/.test(raw) ? 'Swim' : 'Workout';
  const start = new Date(row.startTime);
  if (!Number.isFinite(start.getTime())) return null;
  return { id: 'garmin:' + row.id, provider: 'Garmin', device: row.device || null, name: row.name || sport,
    garminActivityId: Number(row.activityId) > 0 ? Number(row.activityId) : null,
    type: sport, sport_type: sport, start_date: start.toISOString(),
    start_date_local: row.localDate ? row.localDate + 'T' + start.toISOString().slice(11, 19) : start.toISOString(),
    distance: Number(row.distanceM) || 0, moving_time: Number(row.durationS) || 0,
    elapsed_time: Number(row.durationS) || 0, average_heartrate: row.avgHr || null,
    max_heartrate: row.maxHr || null };
}

/**
 * Garmin's copy of a recording Strava also holds, or null.
 *
 * Used to move a session Strava completed (because Strava's copy arrived
 * first) onto Garmin's copy once that lands. A combined match of several
 * Strava recordings has no single twin, so it stays Strava.
 */
export function garminTwinOf(stravaActivity, feedActivities) {
  if (!stravaActivity || typeof stravaActivity !== 'object' || stravaActivity.provider === 'Garmin') return null;
  if (Number(stravaActivity.source_activity_count) > 1) return null;
  const twins = (feedActivities || []).filter(candidate => candidate && candidate.provider === 'Garmin' && sameRecording(candidate, stravaActivity));
  return twins.length === 1 ? twins[0] : null;
}

/**
 * Strava's copy of a Garmin recording, or null. Garmin's summaries carry no
 * km splits, laps or route, so where Strava holds the same recording those
 * still come from Strava.
 */
export function stravaTwinOf(garminActivity, stravaActivities) {
  if (!garminActivity || garminActivity.provider !== 'Garmin') return null;
  const twins = (stravaActivities || []).filter(candidate => candidate && candidate.provider !== 'Garmin' && sameRecording(garminActivity, candidate));
  return twins.length === 1 ? twins[0] : null;
}

export function garminPaceLabel(activity) {
  const metres = Number(activity && activity.distance), seconds = Number(activity && (activity.moving_time || activity.elapsed_time));
  if (!(metres > 0) || !(seconds > 0)) return '';
  const perKm = Math.round(seconds / (metres / 1000));
  return Math.floor(perKm / 60) + ':' + String(perKm % 60).padStart(2, '0');
}

export function garminDeviceLabel(activity) {
  const device = activity && activity.device && !/^unknown$/i.test(String(activity.device)) ? String(activity.device).replace(/^Garmin\s*/i, '') : '';
  return device ? 'Garmin ' + device : 'Garmin';
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
    garminConnected: !!(garmin && garmin.connected),
    activitiesAvailable: true, activities: preferred.sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date)),
    // Every recording from each service, before de-duplication: stored matches
    // are restored by key from here, and Strava twins supply splits and laps.
    garminActivities: preferred.filter(activity => activity.provider === 'Garmin'),
    stravaActivities: other.map(activity => ({ ...activity, provider: 'Strava' })) };
}

if (typeof window !== 'undefined') {
  window.mergeConnectedActivities = mergeConnectedActivities;
  window.sameRecording = sameRecording;
  window.loadConnectedActivities = async function() {
    const results = await Promise.all([window._stravaLoadPromise, window._garminLoadPromise].map(p => Promise.resolve(p).catch(() => null)));
    return mergeConnectedActivities(results[0], results[1]);
  };
  window.renderConnectedActivities = async function() {
    const owner = typeof athlete !== 'undefined' && athlete && athlete.code;
    const data = await window.loadConnectedActivities();
    if (!owner || !athlete || athlete.code !== owner) return;
    window._connectedActivityFeed = data;
    const weeklyStatus = document.getElementById('weeklyGarminStatus');
    if(weeklyStatus)weeklyStatus.hidden = true;
    const el = document.getElementById('connectedActivities');
    if (!el) return;
    // Only add the combined feed when Garmin is enabled and connected.
    const garmin = await Promise.resolve(window._garminLoadPromise).catch(() => null);
    if (!garmin || !garmin.connected) { el.hidden = true; el.innerHTML = ''; if(typeof invalidateProgrammeVolume==='function')invalidateProgrammeVolume(); if(typeof paintStravaMatches==='function')paintStravaMatches(); if(typeof renderTrainingVolumeStrips==='function')renderTrainingVolumeStrips(); return; }
    const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const rows = data.activities.slice(0, 10).map(a => '<li><div><strong>' + escape(a.name || a.type) + '</strong><small>' + escape(String(a.start_date_local || a.start_date).slice(0,10)) + ' · ' + escape(a.provider === 'Garmin' ? 'Garmin' + (a.device ? ' ' + String(a.device).replace(/^Garmin\s*/i, '') : '') : 'Strava') + '</small></div><span>' + (Number(a.distance)/1000).toFixed(1) + ' km · ' + Math.round(Number(a.moving_time)/60) + ' min</span></li>').join('');
    el.hidden = false;
    const activityCount = Array.isArray(garmin.activities) ? garmin.activities.length : 0;
    const hasStrava = data.activities.some(a => a.provider === 'Strava');
    const countLabel = activityCount + (activityCount === 1 ? ' activity' : ' activities');
    if (weeklyStatus) {
      weeklyStatus.hidden = false;
      weeklyStatus.textContent = activityCount
        ? 'Garmin: ' + countLabel + ' received. Matching runs use Garmin.'
        : 'Garmin account linked — waiting for the first Garmin activity.' + (hasStrava ? ' Strava is supplying your recorded runs for now.' : '');
    }
    const syncStatus = activityCount
      ? 'Garmin: ' + countLabel + ' received. Matching recordings use Garmin once.'
      : 'Garmin account linked. Waiting for the first Garmin activity.' + (hasStrava ? ' Activities below are from Strava until Garmin sends a recording.' : '') + (garmin.historyAvailable === false ? ' Historical import is unavailable for this connection.' : '');
    el.innerHTML = '<p class="connected-attribution" role="status">' + escape(syncStatus) + '</p><details open><summary>Connected activities <span>Garmin + Strava · each activity counted once</span></summary>' + (rows ? '<ul>' + rows + '</ul>' : '<p>Record a new activity and sync your watch with Garmin Connect. If it does not arrive, check the Garmin push delivery settings.</p>') + '<p class="connected-attribution">Activity data supplied by Garmin and Strava. Each recording appears once across your connected accounts.</p></details>';
    if (typeof invalidateProgrammeVolume === 'function') invalidateProgrammeVolume();
    if (typeof paintStravaMatches === 'function') paintStravaMatches();
    if (typeof renderTrainingVolumeStrips === 'function') renderTrainingVolumeStrips();
  };
  window.garminTwinOf = garminTwinOf;
  window.stravaTwinOf = function(garmin) { return stravaTwinOf(garmin, window._connectedActivityFeed?.stravaActivities); };
  window.garminPaceLabel = garminPaceLabel;
  window.garminDeviceLabel = garminDeviceLabel;
  // The Garmin recording behind this session: the match itself when Garmin
  // completed it, or Garmin's copy of the Strava recording that did.
  window.sessionGarminTwin = function(session) {
    if (!session) return null;
    const entry = typeof logs !== 'undefined' && logs && logs[session.id];
    const live = typeof getStravaSessionMatch === 'function' && getStravaSessionMatch(session);
    const matched = live?.activity || entry?.__stravaMatch?.activity;
    if (matched && matched.provider === 'Garmin') return matched;
    const activities = window._connectedActivityFeed?.activities;
    return matched && activities?.length ? garminTwinOf(matched, activities) : null;
  };
  window.getGarminRideActivity = function(session) {
    const activities = window._connectedActivityFeed?.activities;
    if (!activities?.length || !session?.date) return null;

    const entry = typeof logs !== 'undefined' && logs[session.id];
    const liveMatch = typeof getStravaSessionMatch === 'function' && getStravaSessionMatch(session);
    const strava = liveMatch?.activity || entry?.__stravaMatch?.activity;
    const garminRides = activities.filter(activity =>
      activity.provider === 'Garmin' && activity.sport_type === 'Ride' &&
      String(activity.start_date_local || activity.start_date).slice(0, 10) === session.date
    );

    if (strava) {
      const matching = garminRides.filter(activity => sameRecording(activity, strava));
      return matching.length === 1 ? matching[0] : null;
    }

    if (typeof stravaSessionNeedsManualLog === 'function' && stravaSessionNeedsManualLog(session.id)) return null;
    const otherRide = typeof allSessions !== 'undefined' && (allSessions || []).some(candidate =>
      String(candidate.id) !== String(session.id) && candidate.date === session.date && getType(candidate) === 'ride'
    );
    if (otherRide || typeof window.matchRideActivityToSession !== 'function') return null;
    const match = window.matchRideActivityToSession(session, activities);
    return match.confidence === 'high' && match.activity?.provider === 'Garmin' ? match.activity : null;
  };
  window.getConnectedSessionMatch = function(session) {
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
    if (!match) return null;
    const parts = match.activities || [];
    if (parts.length > 1 && parts.every(a => a.provider === 'Garmin')) match.activity = Object.assign({}, match.activity, {provider:'Garmin'});
    return match;
  };
  window.garminSessionResultHtml = function(session, index) {
    const esc = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    // The run card only. Swims and rides have their own Garmin-first views.
    if (!session || typeof getType !== 'function' || getType(session) !== 'run') return '';
    const twin = window.sessionGarminTwin(session);
    let activity = twin, lowConfidence = false;
    if (!activity) {
      const match = window.getConnectedSessionMatch(session);
      if (!match || !match.matched || !match.activity || match.activity.provider !== 'Garmin') return '';
      activity = match.activity;
      lowConfidence = match.confidence === 'low';
    }
    const minutes = Math.round(activity.moving_time / 60);
    const pace = garminPaceLabel(activity);
    const stat = (label, value) => value ? '<div class="run-hero-stat"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>' : '';
    // Only a twin has something stored to remove: the Strava match behind it.
    const reject = twin && Number.isInteger(index) && index >= 0
      ? '<button type="button" class="run-hero-reject" onclick="event.stopPropagation();rejectStravaMatch(' + index + ')">Not this run</button>' : '';
    const link = activity.garminActivityId
      ? '<a class="run-hero-link" href="https://connect.garmin.com/modern/activity/' + encodeURIComponent(String(activity.garminActivityId)) + '" target="_blank" rel="noopener">View in Garmin Connect ↗</a>' : '';
    return '<section class="run-hero run-hero--garmin" aria-label="Your run from Garmin"><div class="run-hero-top"><span class="run-hero-source">' + esc(garminDeviceLabel(activity)) + '</span>' + reject + '</div>' +
      '<div class="run-hero-main"><span class="run-hero-label">Recorded run</span><strong class="run-hero-number">' + (activity.distance/1000).toFixed(1) + ' km</strong></div>' +
      '<div class="run-hero-stats">' + stat('Duration', minutes + ' min') + stat('Avg pace', pace ? pace + ' /km' : '') + stat('Avg HR', activity.average_heartrate ? Math.round(Number(activity.average_heartrate)) + ' bpm' : '') + '</div>' +
      '<p>Activity data supplied by Garmin. ' + (lowConfidence ? 'Possible session match. ' : '') + 'Your session feedback is saved separately.</p>' + link + '</section>';
  };
}
