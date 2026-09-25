// Karl's real Upper A (2 days / wk) split and recent history, taken from
// Supabase on 26 Sep 2026. Used to audit the exercise screen against the
// session that prompted the redesign: 12 exercises, warm-ups, a unilateral
// slot, and the Wide Grip / Pec Dec / Dips badge cases.
const s = (weight, reps, extra = {}) => ({ weight: String(weight), reps: String(reps), done: true, ...extra });

export const upperA = [
  { exercise: 'Low Machine Row', sets: '4', reps: '8', repRange: '8-12', warmupSets: '2', workingSets: '2', rest: '90s', notes: 'First 2 sets warm-up', alts: ['Cable row (close grip)'] },
  { exercise: 'Wide Grip Machine Row', sets: '2', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '2', rest: '90s', notes: '', alts: ['Wide Grip Cable Row'] },
  { exercise: 'Pec Dec', sets: '3', reps: '8', repRange: '8-12', warmupSets: '1', workingSets: '2', rest: '90s', notes: 'First set warm-up', alts: ['Cable fly', 'Chest fly machine'] },
  { exercise: 'Incline Dumbbell Press', sets: '2', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '2', rest: '90s', notes: '', alts: ['Barbell incline bench press', 'Machine incline bench press'] },
  { exercise: 'Lat Pulldown', sets: '2', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '2', rest: '90s', notes: '', alts: ['Cable Lat Pulldown', 'Machine Lat Pulldown'] },
  { exercise: 'Machine Dips', sets: '2', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '2', rest: '90s', notes: '', alts: ['Assisted dips', 'Cable pushdown'] },
  { exercise: 'Machine Shoulder Press', sets: '2', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '2', rest: '90s', notes: '', alts: ['Dumbbell shoulder press', 'Seated barbell press'] },
  { exercise: 'Dumbbell Hammer Curl', sets: '2', reps: '8', repRange: '8-12', warmupSets: '0', workingSets: '2', rest: '90s', notes: '', alts: ['Bicep curl', 'Barbell curl'] },
  { exercise: 'Lateral Dumbbell Raise', sets: '2', reps: '10', repRange: '10-15', warmupSets: '0', workingSets: '2', rest: '90s', notes: '', alts: ['Machine lateral raise', 'Cable lateral raise'], leftRightExercises: ['Cable lateral raise'] },
  { exercise: 'Tricep Rope Extension', sets: '2', reps: '10', repRange: '10-15', warmupSets: '0', workingSets: '2', rest: '90s', notes: '', alts: ['Overhead rope extension', 'Cable pushdown (bar)'] },
  { exercise: 'Rear Delt Fly', sets: '2', reps: '10', repRange: '10-15', warmupSets: '0', workingSets: '2', rest: '90s', notes: '', alts: ['Cable rear delt fly', 'Face pull'] },
  { exercise: 'Cable Abdominal Crunch', sets: '3', reps: '10', repRange: '10-15', warmupSets: '0', workingSets: '3', rest: '90s', notes: '', alts: ['Crunch machine', 'Hanging knee raise'] },
];

export const upperAHistory = [
  { id: 'hist-0720', date: '2026-07-20', log: {
    'Wide Grip Machine Row': [s(35, 11, { done: false }), s(36.25, 11, { done: false })],
  } },
  { id: 'hist-0817', date: '2026-08-17', log: {
    'Cable Abdominal Crunch': [s(40.8, 13), s(40.8, 14), s(40.8, 11)],
    'Rear Delt Fly': [s(39, 13), s(39, 14)],
    'Lateral Dumbbell Raise': [s(8, 15), s(8, 12)],
  } },
  { id: 'hist-0914', date: '2026-09-14', log: {
    'Rear Delt Fly': [s(45, 14, { effort: 'too_easy' }), s(52, 11)],
    'Lateral Dumbbell Raise': [s(9, 15, { effort: 'on_target' }), s(9, 13)],
    'Pec Dec': [s(79, 10), s(93, 9, { effort: 'on_target' }), s(93, 8)],
    'Lat Pulldown': [s(66, 9, { effort: 'on_target' }), s(66, 8)],
    'Incline Dumbbell Press': [s(25, 9, { effort: 'on_target' }), s(25, 8)],
    'Machine Shoulder Press': [s(30.4, 10, { effort: 'on_target' }), s(30.4, 10)],
  } },
  { id: 'hist-0921', date: '2026-09-21', log: {
    'Low Machine Row': [s(13.6, 12), s(33.6, 9), s(38.6, 9, { effort: 'on_target' }), s(38.6, 9)],
    'Wide Grip Machine Row': [s(45.4, 8, { effort: 'too_easy' }), s(50.4, 8)],
    'Pec Dec': [s(75, 10), s(89, 10, { effort: 'on_target' }), s(89, 6)],
    'Incline Dumbbell Press': [s(27.5, 9, { effort: 'on_target' }), s(27.5, 8)],
    'Lat Pulldown': [s(70, 9, { effort: 'too_hard' }), s(70, 8)],
    'Machine Dips': [s(82.8, 8, { effort: 'on_target' }), s(82.8, 9)],
    'Machine Shoulder Press': [s(29.4, 10, { effort: 'too_easy' }), s(34.4, 10)],
    'Dumbbell Hammer Curl': [s(17.5, 10, { effort: 'on_target' }), s(17.5, 10)],
  } },
];
