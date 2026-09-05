// ── MUSCLE COVERAGE ───────────────────────────────────────────────────────────
// What the session was written to train, against what has actually been
// logged. Moved out of 08-training.js unchanged — same names, same signatures,
// same global scope. Loads before 08-training.js, which calls into it.

// What the session was written to train, against what has actually been logged.
// With swaps in play the exercise names alone no longer answer that, so the
// readout works off muscle groups: a session where every exercise was
// substituted still confirms the target groups were covered — or shows exactly
// which one got dropped when the athlete ran out of time.
function buildMuscleCoverage(i,splitKey){
  var exercises=getSplit(splitKey),s=sessions[i];
  if(!s||!exercises.length) return [];
  var planned={},order=[];
  exercises.forEach(function(ex){
    var group=(typeof exerciseMuscleGroup==='function')?exerciseMuscleGroup(ex.exercise):null;
    if(!group) return;
    if(!planned[group.key]){planned[group.key]={key:group.key,label:group.label,plannedSets:0,loggedSets:0};order.push(group.key);}
    planned[group.key].plannedSets+=parseInt(ex.workingSets||ex.sets,10)||0;
  });
  exercises.forEach(function(ex,ei){
    var resolvedEx=exPicks[ex.exercise]||ex.exercise;
    var sets=collectExerciseSets(i,ei,true);
    if(!sets.length&&logs[s.id]) sets=getExerciseSetsFromLog(logs[s.id],resolvedEx)||[];
    // Credit the group the athlete actually trained. Swapping a row for a
    // pull-up moves the work from horizontal to vertical pull, and the readout
    // should show that honestly rather than assume the prescription was met.
    var group=(typeof exerciseMuscleGroup==='function')?exerciseMuscleGroup(resolvedEx):null;
    if(!group) return;
    if(!planned[group.key]){planned[group.key]={key:group.key,label:group.label,plannedSets:0,loggedSets:0};order.push(group.key);}
    sets.forEach(function(set){
      if(typeof strengthSetWorkload==='function'&&strengthSetWorkload(set)) planned[group.key].loggedSets++;
    });
  });
  return order.map(function(key){return planned[key];});
}
function muscleCoverageHtml(groups){
  if(!groups||!groups.length) return '';
  var covered=groups.filter(function(g){return g.loggedSets>0;}).length;
  var missing=groups.filter(function(g){return g.plannedSets>0&&g.loggedSets===0;});
  var summary=covered+' of '+groups.length+' muscle groups trained';
  var chips='';
  groups.forEach(function(g){
    var state=g.loggedSets===0?'todo':(g.plannedSets&&g.loggedSets>=g.plannedSets?'done':'partial');
    chips+='<span class="mcov-chip is-'+state+'"><span class="mcov-chip-label">'+esc(g.label)+'</span><span class="mcov-chip-sets">'+g.loggedSets+(g.plannedSets?'/'+g.plannedSets:'')+'</span></span>';
  });
  return '<div class="mcov-head"><span class="mcov-title">Muscle groups this session</span><span class="mcov-sum">'+esc(summary)+'</span></div>'
    +'<div class="mcov-chips">'+chips+'</div>'
    +(missing.length?'<div class="mcov-gap">Still untouched: '+esc(missing.map(function(g){return g.label;}).join(', '))+'</div>':'');
}
function refreshMuscleCoverage(i,splitKey){
  var mount=document.getElementById('mcov_'+i);
  if(!mount) return;
  var html=muscleCoverageHtml(buildMuscleCoverage(i,splitKey));
  mount.innerHTML=html;
  mount.style.display=html?'block':'none';
}
