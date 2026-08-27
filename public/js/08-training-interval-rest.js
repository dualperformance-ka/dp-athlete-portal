// ── INTERVAL REST TIME PARSER ──────────────────────────────────────────────────
// Rest times are coach-decided by this function based on session type/intensity.
// Priority: 1) Notion "Rep Rest" field (coach override), 2) this function's logic.
// Notion's Recovery Type / Recovery Time fields are NEVER used for rep rest.
function getIntervalRestInfo(meta, sessionTitle) {
  var title = String(sessionTitle || meta.name || '').toLowerCase();
  var intensity = String(meta.intensity || '').toLowerCase();
  var type = String(meta.type || '').toLowerCase();
  var description = String(meta.description || meta.target || '').toLowerCase();
  var haystack = title + ' ' + intensity + ' ' + type + ' ' + description;

  // Exclude continuous/easy/recovery sessions — no rep-based rest needed
  var isContinuous = /\beasy run\b|\blong run\b|\brecovery run\b|\brecovery\b|\beasy\b|\bcontinuous\b|\bsteady state\b/.test(type) ||
    /\beasy run\b|\blong run\b|\brecovery run\b/.test(title) ||
    intensity === 'aerobic' || intensity === 'easy';
  if (isContinuous) return null;

  // Exclude tempo/threshold runs that are continuous (no reps)
  var isContinuousTempo = /\btempo run\b|\bthreshold run\b|\bsteady tempo\b/.test(title) && !/[x×]|\brep\b|\brepeat/.test(haystack);
  if (isContinuousTempo) return null;

  // Must look like an interval/rep session
  var isInterval = /interval|track|repeat|\brep\b|speed|fartlek|hill sprint|hill rep|yasso|\d+\s*[x×]\s*\d|\d+\s*x\s*\d/.test(haystack);
  if (!isInterval) return null;

  // ── COACH LOGIC: decide rest time based on session type ──────────────────────
  var restTime, restType, restDesc, recoveryNote;

  if (/200\s*m|200m/.test(haystack)) {
    // 200m reps — near-maximal, full walk rest
    restTime = '60–90 sec'; restType = 'Walk Rest';
    restDesc = 'Walk back to the start line. Full recovery — these are near-maximal speed efforts.';
    recoveryNote = 'Short and sharp. Full rest is non-negotiable — rushing recovery kills quality.';

  } else if (/400\s*m|400m/.test(haystack)) {
    // 400m reps — VO2max, 60 sec walk rest
    restTime = '60 sec'; restType = 'Walk Rest';
    restDesc = 'Walk rest between each rep. Short and structured — this keeps the stimulus race-sharp.';
    recoveryNote = 'If pace drops >3 sec/lap by rep 5, add 15–20 sec to rest and hold pace — don\'t sacrifice quality for speed.';

  } else if (/800\s*m|800m/.test(haystack)) {
    // 800m reps — VO2max, jog/walk rest
    restTime = '2–3 min'; restType = 'Jog / Walk Rest';
    restDesc = 'Easy jog or brisk walk between reps. Aim to feel ~80% recovered before the next 800.';
    recoveryNote = 'Don\'t rush the recovery — these demand real effort and real rest.';

  } else if (/1\.6\s*km|1600\s*m/.test(haystack)) {
    // 1600m / mile reps
    restTime = '2–3 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. These are threshold-length efforts — you need proper recovery to hold pace.';
    recoveryNote = 'If pace drops >5 sec/km on a rep, the rest wasn\'t long enough.';

  } else if (/1\.5\s*k|1500\s*m/.test(haystack)) {
    restTime = '2–3 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. You should be breathing comfortably before the next one starts.';
    recoveryNote = 'Keep the jog very easy — legs should feel ready, not fatigued.';

  } else if (/1\s*km|1000\s*m/.test(haystack)) {
    // 1km reps — threshold/VO2max
    restTime = '90 sec – 2 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog recovery between each 1km rep. HR should drop noticeably before restarting.';
    recoveryNote = 'Consistent pacing across all reps is the goal — use the rest to make that happen.';

  } else if (/2\s*km|2000\s*m/.test(haystack)) {
    restTime = '2–3 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog or walk recovery. These are sustained efforts — give yourself enough time to reset.';
    recoveryNote = 'Aim for even splits across all reps.';

  } else if (/3\s*km|3000\s*m/.test(haystack)) {
    restTime = '3–4 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. Full aerobic recovery before the next effort.';
    recoveryNote = 'Quality over quantity — if pace slips >10 sec/km on a rep, cut it and rest more.';

  } else if (/yasso/.test(haystack)) {
    restTime = 'Equal to rep time'; restType = 'Easy Jog Rest';
    restDesc = 'Jog for the same duration as your 800m rep. Classic Yasso structure.';
    recoveryNote = 'E.g. if your 800m takes 4:00, jog for 4:00 before the next rep.';

  } else if (/hill rep|hill sprint/.test(haystack)) {
    restTime = 'Full walk-back'; restType = 'Walk Down Recovery';
    restDesc = 'Walk back down the hill completely. These are power reps — full recovery between each one.';
    recoveryNote = 'Don\'t jog back. The walk IS the rest. Rushing kills the next rep.';

  } else if (/fartlek/.test(haystack)) {
    restTime = 'Equal to work time'; restType = 'Easy Jog Recovery';
    restDesc = 'Match recovery to effort: 1 min hard = 1 min easy. Keep moving — no standing rest.';
    recoveryNote = 'Fartlek is about flow — never stop, just shift gears.';

  } else if (/cruise|tempo interval/.test(haystack)) {
    // Cruise intervals / tempo reps
    restTime = '60–90 sec'; restType = 'Easy Jog Rest';
    restDesc = 'Short jog recovery — these reps are at threshold, not race pace. The rest keeps lactate in check.';
    recoveryNote = 'You should feel controlled between reps, not destroyed.';

  } else if (/(\d+)\s*[x×]\s*(\d+)\s*min/.test(String(meta.description || sessionTitle || ''))) {
    // Timed reps e.g. 6×3min, 8×2min
    var minMatch = String(meta.description || sessionTitle || '').match(/(\d+)\s*[x×]\s*(\d+)\s*min/i);
    var repMins = minMatch ? parseInt(minMatch[2]) : 2;
    if (repMins <= 1) {
      restTime = '60 sec'; restType = 'Easy Jog Rest';
      restDesc = 'Short jog recovery between each 1min rep. Keep moving — these are aerobic surges.';
      recoveryNote = 'Match the intensity: hard 1min, easy 1min. Don\'t stop.';
    } else if (repMins <= 2) {
      restTime = '90 sec'; restType = 'Easy Jog Rest';
      restDesc = 'Easy jog recovery between each rep. Heart rate should come down before restarting.';
      recoveryNote = 'Aim for even pace across all reps. Slow down if needed — don\'t cut rest.';
    } else {
      restTime = '2 min'; restType = 'Easy Jog Rest';
      restDesc = 'Easy jog between longer reps. Give yourself time to reset — these are sustained efforts.';
      recoveryNote = 'Consistent splits are the goal. Add 30 sec rest if pace is falling off.';
    }

  } else {
    // Generic fallback
    restTime = '90 sec – 2 min'; restType = 'Easy Jog Rest';
    restDesc = 'Easy jog between reps. You should feel mostly recovered — controlled breathing — before each effort.';
    recoveryNote = 'Adjust rest up if needed. Consistent reps beat fast early, slow late.';
  }

  // ── NOTION OVERRIDE: "Rep Rest" field wins if coaches have set it ────────────
  // Add a "Rep Rest" property to the session in Notion to override the above.
  // E.g. "90 sec", "2 min jog", "3 min". Only this field is used — not Recovery Type.
  var notionRepRest = String(meta.repRest || '').trim();
  if (notionRepRest) {
    restTime = notionRepRest;
    restType = 'Coach-specified Rest';
    restDesc = 'Rest period as prescribed by your coaches. Stick to this — it\'s calibrated to your fitness and session load.';
    recoveryNote = 'Don\'t cut it short. Consistent reps across all efforts is the goal.';
  }

  return { restTime: restTime, restType: restType, restDesc: restDesc, recoveryNote: recoveryNote };
}

