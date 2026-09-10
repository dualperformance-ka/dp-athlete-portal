// ── STRENGTH PROGRESSION ENGINE ───────────────────────────────────────────────
// Pure, deterministic decision layer for the strength tracker. No DOM, no
// storage, no side effects: the same inputs always produce the same decision
// object, and 08-training.js renders from it.
//
// Three stages, in order:
//   1. normaliseStrengthPrescription() — what the coach actually asked for.
//   2. normaliseStrengthSets()         — what the athlete actually did.
//   3. strengthCalibrationDecision() / strengthProgressionDecision().
//
// Every decision carries a `reason` and a `confidence` so the card can say why
// it is saying it, and whether the number came from the coach, from confirmed
// history, from the equipment the athlete has actually used, or from an
// estimate that needs rounding to a real setting.
//
// Policy lives in one object. Thresholds are never inlined at a call site.
var STRENGTH_POLICY = {
  // Bump when a rule change would reinterpret an already-submitted session.
  // Stored with the session so old logs stay explainable under their own rules.
  version: 4,
  // Training to failure is never required. Absent a coach target, calibrate at
  // roughly two clean reps in reserve.
  defaultTargetRir: 2,
  defaultTargetRpe: 8,
  // Effort bands, in reps-in-reserve either side of the coach's target.
  easyRirMargin: 2,       // >= target + 2 reserve => meaningfully too easy
  hardRirMargin: 2,       // <= target - 2 reserve => meaningfully too hard
  nearTargetRir: 1,       // within +/- 1 of target counts as on target
  conflictRirGap: 3,      // self-reported effort vs quality button disagreement
  maxRungsPerChange: 1,   // never more than one known rung at a time
  maxLoadKg: 500,         // absolute safety cap on any suggested load
  minLoadKg: 0,
  minLearnGapKg: 0.5,     // below this, treat a gap as noise
  maxLearnGapKg: 25,      // above this, treat a gap as a deload, not a rung
  minRungSamples: 2,      // distinct loads needed before a ladder is trusted
  outlierGapMultiple: 4,  // a lone load this far off the ladder is a likely typo
  plateauSessions: 3,     // comparable completed sessions before a plateau call
  plateauHighEffortSessions: 2,
  historyPoints: 6,      // sessions shown in the progression strip
  impossibleReps: 100,    // above this the entry is bad data, not a set
  defaultRepFloor: 8,
  defaultWorkingSets: 3
};
function strengthPolicy(){return STRENGTH_POLICY;}

// ── small helpers ────────────────────────────────────────────────────────────
function _seNum(value){
  if(value==null)return null;
  var text=String(value).trim();
  if(text==='')return null;
  var n=Number(text);
  return isFinite(n)?n:null;
}
function _seInt(value){
  var n=_seNum(value);
  if(n==null)return null;
  n=Math.round(n);
  return n;
}
function _seRound(value){return Math.round(value*100)/100;}
function _seText(value){return String(value==null?'':value).trim();}
function _seLower(value){return _seText(value).toLowerCase();}
function _seHas(value){return _seText(value)!=='';}

// ── prescription normalisation ───────────────────────────────────────────────
// The coach's prescription is authoritative. Typed fields on the exercise win
// over anything guessed from the exercise name, and nothing here parses the
// human-readable prescription line.
var STRENGTH_ASSISTED_RE=/\bassist(?:ed|ance)?\b/i;
var STRENGTH_BODYWEIGHT_RE=/\b(?:bodyweight|body weight|push[- ]?up|press[- ]?up|pull[- ]?up|chin[- ]?up|dip|plank|hollow hold|hanging leg raise|sit[- ]?up|nordic)\b/i;
var STRENGTH_WEIGHTED_BW_RE=/\b(?:weighted|loaded|\+\s*\d)/i;
var STRENGTH_BAND_RE=/\bband(?:ed|s)?\b/i;
var STRENGTH_PERHAND_RE=/\b(?:dumbbell|dumbell|\bdb\b|kettlebell|\bkb\b)\b/i;

function strengthIsAssistedName(name){return STRENGTH_ASSISTED_RE.test(_seText(name));}

function strengthLoadMode(pres,name){
  var explicit=_seLower(pres&&(pres.loadMode||pres.load_mode));
  if(/^(external|assisted|bodyweight|bodyweight_plus|band_unknown|none)$/.test(explicit))return explicit;
  var text=_seText(name);
  if(STRENGTH_ASSISTED_RE.test(text))return 'assisted';
  if(STRENGTH_BAND_RE.test(text))return 'band_unknown';
  if(STRENGTH_BODYWEIGHT_RE.test(text))return STRENGTH_WEIGHTED_BW_RE.test(text)?'bodyweight_plus':'bodyweight';
  return 'external';
}
function strengthLoadUnit(pres){
  var unit=_seLower(pres&&(pres.loadUnit||pres.load_unit));
  return unit==='lb'||unit==='lbs'?'lb':'kg';
}
function strengthLoadConvention(pres,name){
  var conv=_seLower(pres&&(pres.loadConvention||pres.load_convention));
  if(/^(total|per_hand|machine)$/.test(conv))return conv;
  // Not inferred from the name: a dumbbell press has been logged as a total for
  // years in this portal, and silently reclassifying it would compare two
  // different numbers. Only a coach field changes the convention.
  return 'total';
}
function strengthRepMode(pres){
  var mode=_seLower(pres&&(pres.repMode||pres.rep_mode));
  if(mode==='seconds'||mode==='time'||mode==='hold'||mode==='isometric')return 'seconds';
  if(mode==='distance'||mode==='metres'||mode==='meters')return 'distance';
  if(mode==='left_right')return 'left_right';
  if(mode==='reps'||mode==='')return null;   // resolved from the rep numbers
  return 'other';
}
// Only clearly defined rule shapes are executed. Anything else is displayed as
// the coach wrote it, falls back to double progression, and is flagged for
// review rather than being interpreted as code.
function strengthProgressionRule(raw){
  var text=_seText(raw);
  if(!text)return {type:'double',raw:'',supported:true,step:null};
  var lower=text.toLowerCase();
  if(/^(double|double progression|dp)$/.test(lower))return {type:'double',raw:text,supported:true,step:null};
  if(/^(exact|exact reps|fixed|fixed reps|straight sets)$/.test(lower))return {type:'exact_reps',raw:text,supported:true,step:null};
  if(/^(hold|maintain|no progression)$/.test(lower))return {type:'hold',raw:text,supported:true,step:null};
  if(/^(top set|top set \+ back ?off|ramp|ramped|ramp to top set)$/.test(lower))return {type:'ramped',raw:text,supported:true,step:null};
  var linear=lower.match(/^(?:linear\s*)?\+?\s*(\d+(?:\.\d+)?)\s*(kg|lb)?\s*(?:per|\/)?\s*(?:session|week)?$/);
  if(linear)return {type:'linear_load',raw:text,supported:true,step:Number(linear[1])};
  return {type:'coach_text',raw:text,supported:false,step:null};
}
function strengthRepBounds(pres){
  var min=_seInt(pres&&(pres.repMin!=null?pres.repMin:pres.rep_min));
  var max=_seInt(pres&&(pres.repMax!=null?pres.repMax:pres.rep_max));
  if(min==null||max==null){
    var range=_seText(pres&&(pres.repRange||pres.reps));
    var parts=range.split(/[-–—]/);
    var a=_seInt(parts[0]),b=_seInt(parts[parts.length-1]);
    if(min==null)min=a;
    if(max==null)max=(b==null?a:b);
  }
  if(min==null&&max!=null)min=max;
  if(max==null&&min!=null)max=min;
  return {min:min,max:max};
}
function normaliseStrengthPrescription(ex,resolvedName){
  ex=ex||{};
  var variation=_seText(resolvedName)||_seText(ex.exercise);
  var loadMode=strengthLoadMode(ex,variation);
  var bounds=strengthRepBounds(ex);
  var explicitRepMode=strengthRepMode(ex);
  var repMode=explicitRepMode;
  if(!repMode){
    repMode=(bounds.min!=null&&bounds.max!=null&&bounds.max>bounds.min)?'range':'exact';
    if(bounds.min==null&&bounds.max==null)repMode='range';
  }
  var repFloor=bounds.min!=null?bounds.min:STRENGTH_POLICY.defaultRepFloor;
  var repCeiling=bounds.max!=null?bounds.max:repFloor;
  var rule=strengthProgressionRule(ex.progression||ex.progression_rule||ex.progressionRule);
  if(rule.type==='double'&&repMode==='exact')rule={type:'exact_reps',raw:rule.raw,supported:true,step:null};
  var targetRir=_seNum(ex.targetRir!=null?ex.targetRir:ex.rir);
  var targetRpe=_seNum(ex.targetRpe!=null?ex.targetRpe:ex.rpe);
  var rirSource='default';
  if(targetRir!=null)rirSource='coach';
  else if(targetRpe!=null){targetRir=Math.max(0,10-targetRpe);rirSource='coach';}
  else targetRir=STRENGTH_POLICY.defaultTargetRir;
  if(targetRpe==null)targetRpe=Math.max(1,10-targetRir);
  var sets=_seInt(ex.sets)||0;
  var warmupSets=_seInt(ex.warmupSets!=null?ex.warmupSets:ex.warmup_sets)||0;
  var workingSets=_seInt(ex.workingSets!=null?ex.workingSets:ex.working_sets)||0;
  if(!workingSets)workingSets=Math.max(1,sets-warmupSets)||STRENGTH_POLICY.defaultWorkingSets;
  var unit=strengthLoadUnit(ex);
  var convention=strengthLoadConvention(ex,variation);
  var setPlan=Array.isArray(ex.setPlan)?ex.setPlan:(Array.isArray(ex.set_plan)?ex.set_plan:null);
  return {
    exercise:_seText(ex.exercise),
    variation:variation,
    loadMode:loadMode,
    assisted:loadMode==='assisted',
    bodyweight:loadMode==='bodyweight'||loadMode==='bodyweight_plus',
    unit:unit,
    convention:convention,
    repMode:repMode,
    repFloor:repFloor,
    repCeiling:repCeiling,
    exactReps:repMode==='exact'?repFloor:null,
    sets:sets||(warmupSets+workingSets),
    warmupSets:warmupSets,
    workingSets:workingSets,
    targetLoad:_seNum(ex.targetLoad!=null?ex.targetLoad:ex.target_load),
    percent1rm:_seNum(ex.percent1rm!=null?ex.percent1rm:ex.percent_1rm),
    targetRir:targetRir,
    targetRpe:targetRpe,
    targetEffortSource:rirSource,
    progression:rule,
    setPlan:setPlan,
    // Two prescriptions only share history when the movement, the unit and the
    // load convention all match. A machine swap or a per-hand switch starts a
    // new ladder rather than inheriting the old one.
    contextKey:_seLower(variation).replace(/\s+/g,' ')+'|'+unit+'|'+convention,
    coachReview:!rule.supported,
    coachReviewReason:rule.supported?'':'Progression rule needs a coach to confirm how it should run.'
  };
}

// ── set normalisation ────────────────────────────────────────────────────────
// A row is only evidence once it carries reps. A weight typed into an empty row
// is a set in progress, never a zero-rep set. Zero external load IS valid data
// on a bodyweight movement.
function strengthSetRole(pres,rowIndex,fallbackIndex){
  var index=rowIndex==null?fallbackIndex:rowIndex;
  if(index==null)return 'working';
  if(index<pres.warmupSets)return 'warmup';
  if(index<pres.warmupSets+pres.workingSets)return 'working';
  return 'bonus';
}
function strengthQualityCode(value){
  var code=_seLower(value);
  if(code==='reserve')return 'too_easy';           // legacy: "more reps available"
  if(code==='failure')return 'at_limit';           // legacy: "no clean rep left"
  if(code==='form_break')return 'form_pain';       // legacy: technique stop
  if(/^(on_target|too_easy|too_hard|form_pain|at_limit)$/.test(code))return code;
  return '';
}
function strengthQualityIsLegacy(value){return /^(reserve|failure|form_break)$/.test(_seLower(value));}
function strengthSetReps(set){
  if(!set)return null;
  var left=_seInt(set.repsLeft),right=_seInt(set.repsRight);
  if(left!=null||right!=null){
    var values=[];
    if(left!=null)values.push(left);
    if(right!=null)values.push(right);
    return Math.min.apply(null,values);
  }
  return _seInt(set.reps);
}
function normaliseStrengthSets(rows,pres,roleOverride){
  var out=[];
  (rows||[]).forEach(function(row,fallbackIndex){
    if(!row)return;
    var rowIndex=_seInt(row._rowIndex);
    var reps=strengthSetReps(row);
    var left=_seInt(row.repsLeft),right=_seInt(row.repsRight);
    var rawLoad=_seNum(row.weight);
    var hasLoadInput=_seHas(row.weight);
    var invalid=null;
    if(reps!=null&&(reps<0||reps>STRENGTH_POLICY.impossibleReps))invalid='reps';
    if(rawLoad!=null&&(rawLoad<0||rawLoad>STRENGTH_POLICY.maxLoadKg))invalid='load';
    // Bodyweight keeps a logged 0 as a real load. Everything else treats 0 or a
    // blank box as "no load recorded" rather than as zero kilos.
    var load=null;
    if(rawLoad!=null&&invalid!=='load'){
      if(pres.bodyweight)load=rawLoad;
      else if(rawLoad>0)load=rawLoad;
    }
    var rpe=_seNum(row.rpe);
    if(rpe!=null&&(rpe<1||rpe>10))rpe=null;
    var rir=_seNum(row.rir);
    if(rir!=null&&(rir<0||rir>10))rir=null;
    out.push({
      index:rowIndex==null?fallbackIndex:rowIndex,
      rowIndex:rowIndex,
      role:roleOverride||strengthSetRole(pres,rowIndex,fallbackIndex),
      reps:invalid==='reps'?null:reps,
      repsLeft:left,repsRight:right,
      unilateral:left!=null||right!=null,
      weakerSide:(left!=null&&right!=null)?(left<=right?'left':'right'):null,
      load:load,
      hasLoad:load!=null,
      hasLoadInput:hasLoadInput,
      rpe:rpe,
      rir:rir,
      quality:strengthQualityCode(row.effort),
      done:!!row.done,
      invalid:invalid,
      // Evidence needs reps. Anything else is a row still being filled in.
      counts:invalid==null&&reps!=null
    });
  });
  return out;
}
function strengthWorkingRows(rows){
  return (rows||[]).filter(function(row){return row.role==='working';});
}
// Reps recorded, in the order they were logged, for the sets that count.
function strengthCompletedRows(rows){
  return strengthWorkingRows(rows).filter(function(row){return row.counts;});
}

// ── effort ───────────────────────────────────────────────────────────────────
// RPE and RIR are related but not interchangeable. The coach's prescription
// decides the target; the athlete's entries are evidence, and a material
// disagreement between them is reported rather than averaged away.
function strengthEffortEvidence(pres,set){
  if(!set)return {rir:null,source:'none',band:null,conflict:false,note:''};
  var reported=null,source='none';
  if(set.rir!=null){reported=set.rir;source='rir';}
  else if(set.rpe!=null){reported=Math.max(0,10-set.rpe);source='rpe';}
  var implied=null;
  if(set.quality==='too_easy')implied=pres.targetRir+STRENGTH_POLICY.easyRirMargin;
  else if(set.quality==='on_target')implied=pres.targetRir;
  else if(set.quality==='too_hard')implied=Math.max(0,pres.targetRir-STRENGTH_POLICY.hardRirMargin);
  else if(set.quality==='at_limit')implied=0;
  var conflict=false,note='';
  if(reported!=null&&implied!=null&&Math.abs(reported-implied)>=STRENGTH_POLICY.conflictRirGap){
    conflict=true;
    note='Your effort rating and the quality answer disagree.';
  }
  var rir=implied!=null?implied:reported;
  if(implied!=null&&reported!=null&&!conflict)rir=Math.min(implied,reported);
  var band=null;
  if(rir!=null){
    if(rir>=pres.targetRir+STRENGTH_POLICY.easyRirMargin)band='easy';
    else if(rir<=Math.max(0,pres.targetRir-STRENGTH_POLICY.hardRirMargin))band='hard';
    else band='on';
  }
  if(set.quality==='form_pain'){band='stop';note=note||'Technique or a niggle stopped the set.';}
  return {rir:rir,reported:reported,implied:implied,source:source,band:band,conflict:conflict,note:note};
}
function strengthEffortAcceptable(evidence){
  // Acceptable means "not a technique/pain stop and not obviously past the
  // prescribed effort". Missing effort data is acceptable but low confidence.
  if(!evidence)return true;
  return evidence.band!=='stop'&&evidence.band!=='hard';
}

// ── equipment ladder ─────────────────────────────────────────────────────────
// Coach-defined increment first, then the rungs the athlete has actually used
// on this exact context, then a clearly-labelled estimate.
function _seGuessStep(name,load){
  var n=_seLower(name);
  if(STRENGTH_ASSISTED_RE.test(n))return 5;
  if(STRENGTH_BODYWEIGHT_RE.test(n)&&!STRENGTH_WEIGHTED_BW_RE.test(n))return 0;
  if(/lateral raise|face pull|rear delt|reverse fly|\bfly\b|\bcurl\b|tricep|pushdown|calf|cuff|rotator/.test(n))return 2.5;
  var barbell=/\bsquat\b|deadlift|\brdl\b|romanian|bench press|barbell|overhead press|\bohp\b|hip thrust|\bpress\b/.test(n);
  var notBar=/machine|cable|smith|dumbbell|\bdb\b|goblet|kettlebell|band|bodyweight|leg press/.test(n);
  if(barbell&&!notBar)return 2.5;
  if(STRENGTH_PERHAND_RE.test(n)||/goblet/.test(n))return 2.5;
  if(/machine|cable|smith|leg press|pulldown|pec de|extension|hamstring curl|leg curl|\brow\b/.test(n))return 5;
  return Math.max(2.5,Math.round((load||0)*0.025*2)/2);
}
// History rows arrive as [{sets:[...]}]. Only working sets from the same
// context contribute rungs, so a bonus set on a different machine can never
// redefine the ladder.
function strengthLearnLadder(history,pres,sliceWorking){
  var loads={},counts={};
  (history||[]).forEach(function(entry){
    if(!entry)return;
    if(entry.context&&entry.context!==pres.contextKey)return;
    var raw=Array.isArray(entry)?entry:(entry.sets||[]);
    var rows=typeof sliceWorking==='function'?sliceWorking(raw):raw;
    normaliseStrengthSets(rows,pres).forEach(function(row){
      if(row.role==='bonus'||row.role==='warmup')return;
      if(row.invalid)return;
      if(row.load==null||row.load<=0)return;
      var key=_seRound(row.load);
      loads[key]=1;counts[key]=(counts[key]||0)+1;
    });
  });
  var values=Object.keys(loads).map(parseFloat).sort(function(a,b){return a-b;});
  if(values.length<STRENGTH_POLICY.minRungSamples)return null;
  var gaps={},any=[];
  for(var i=1;i<values.length;i++){
    var d=_seRound(values[i]-values[i-1]);
    if(d<STRENGTH_POLICY.minLearnGapKg||d>STRENGTH_POLICY.maxLearnGapKg)continue;
    gaps[d]=(gaps[d]||0)+1;any.push(d);
  }
  if(!any.length)return null;
  var step=null,best=0;
  Object.keys(gaps).map(parseFloat).sort(function(a,b){return a-b;}).forEach(function(d){
    if(gaps[d]>best){best=gaps[d];step=d;}
  });
  if(step==null)return null;
  // A single log sitting far off the ladder is far more likely to be a typo
  // than a real setting, so it is dropped from the rungs. The log itself is
  // untouched: it still counts as a completed set and as volume.
  var rungs=values.filter(function(value,index){
    if(counts[_seRound(value)]>1)return true;
    var prev=index>0?values[index-1]:null,next=index<values.length-1?values[index+1]:null;
    var nearest=null;
    if(prev!=null)nearest=value-prev;
    if(next!=null)nearest=nearest==null?next-value:Math.min(nearest,next-value);
    if(nearest==null)return true;
    return nearest<=step*STRENGTH_POLICY.outlierGapMultiple;
  });
  if(rungs.length<STRENGTH_POLICY.minRungSamples)rungs=values;
  return {step:step,rungs:rungs,source:'learned',exact:true};
}
function strengthLadder(pres,history,sliceWorking){
  var coachStep=_seNum(pres&&(pres.loadStep||pres.load_step))||(pres.progression&&pres.progression.type==='linear_load'?pres.progression.step:null);
  if(coachStep!=null&&coachStep>0){
    return {step:coachStep,rungs:null,source:'coach',exact:true};
  }
  var learned=strengthLearnLadder(history,pres,sliceWorking);
  if(learned)return learned;
  if(pres.loadMode==='band_unknown')return {step:null,rungs:null,source:'unknown',exact:false};
  if(pres.loadMode==='bodyweight')return {step:0,rungs:null,source:'bodyweight',exact:true};
  var guess=_seGuessStep(pres.variation,0);
  return {step:guess,rungs:null,source:'estimated',exact:false};
}
function _seCap(pres,value){
  if(value==null)return null;
  if(pres.assisted)return Math.max(STRENGTH_POLICY.minLoadKg,_seRound(value));
  return Math.min(STRENGTH_POLICY.maxLoadKg,Math.max(STRENGTH_POLICY.minLoadKg,_seRound(value)));
}
// One rung harder. On an assisted machine that means LESS assistance, and the
// journey stops at zero: there is no negative assistance.
function strengthHarderRung(pres,load,ladder){
  if(load==null)return {load:null,exact:false,source:ladder.source,atBoundary:false};
  if(pres.loadMode==='band_unknown')return {load:null,exact:false,source:'unknown',atBoundary:false};
  if(pres.loadMode==='bodyweight')return {load:load,exact:true,source:'bodyweight',atBoundary:true};
  if(pres.assisted){
    var below=null;
    if(ladder.rungs){
      for(var i=ladder.rungs.length-1;i>=0;i--){if(ladder.rungs[i]<load-0.01){below=ladder.rungs[i];break;}}
    }
    if(below==null&&ladder.step!=null)below=Math.max(0,_seRound(load-ladder.step));
    if(below==null)return {load:null,exact:false,source:ladder.source,atBoundary:false};
    return {load:_seCap(pres,below),exact:ladder.exact,source:ladder.source,atBoundary:below<=0};
  }
  var above=null;
  if(ladder.rungs){
    for(var j=0;j<ladder.rungs.length;j++){if(ladder.rungs[j]>load+0.01){above=ladder.rungs[j];break;}}
  }
  if(above==null&&ladder.step!=null&&ladder.step>0)above=_seRound(load+ladder.step);
  if(above==null)return {load:null,exact:false,source:ladder.source,atBoundary:false};
  var capped=_seCap(pres,above);
  return {load:capped,exact:ladder.exact,source:ladder.source,atBoundary:capped>=STRENGTH_POLICY.maxLoadKg};
}
// One rung easier: less weight, or more assistance.
function strengthEasierRung(pres,load,ladder){
  if(load==null)return {load:null,exact:false,source:ladder.source,atBoundary:false};
  if(pres.loadMode==='band_unknown')return {load:null,exact:false,source:'unknown',atBoundary:false};
  if(pres.loadMode==='bodyweight')return {load:load,exact:true,source:'bodyweight',atBoundary:true};
  if(pres.assisted){
    var above=null;
    if(ladder.rungs){
      for(var i=0;i<ladder.rungs.length;i++){if(ladder.rungs[i]>load+0.01){above=ladder.rungs[i];break;}}
    }
    if(above==null&&ladder.step!=null)above=_seRound(load+ladder.step);
    if(above==null)return {load:null,exact:false,source:ladder.source,atBoundary:false};
    return {load:_seCap(pres,above),exact:ladder.exact,source:ladder.source,atBoundary:false};
  }
  var below=null;
  if(ladder.rungs){
    for(var j=ladder.rungs.length-1;j>=0;j--){if(ladder.rungs[j]<load-0.01){below=ladder.rungs[j];break;}}
  }
  if(below==null&&ladder.step!=null&&ladder.step>0)below=Math.max(0,_seRound(load-ladder.step));
  if(below==null)return {load:null,exact:false,source:ladder.source,atBoundary:false};
  return {load:_seCap(pres,below),exact:ladder.exact,source:ladder.source,atBoundary:below<=0};
}
function strengthConfidence(level,detail){
  var labels={
    coach_set:'Coach-set',
    confirmed:'Confirmed history',
    learned:'Learned equipment',
    estimated:'Estimated',
    low:'Needs better data'
  };
  return {level:level,label:labels[level]||'Estimated',detail:detail||''};
}
function strengthLadderConfidence(ladder){
  if(!ladder)return strengthConfidence('estimated');
  if(ladder.source==='coach')return strengthConfidence('coach_set');
  if(ladder.source==='learned')return strengthConfidence('learned');
  if(ladder.source==='bodyweight')return strengthConfidence('confirmed');
  if(ladder.source==='unknown')return strengthConfidence('low');
  return strengthConfidence('estimated');
}

// ── first-working-set calibration ────────────────────────────────────────────
// The first working set is a readiness check at the prescribed range and target
// effort, never an all-out test. Outcomes resolve conservatively, and reps plus
// effort are read together so one vague button cannot move a load on its own.
function strengthCalibrationDecision(input){
  input=input||{};
  var pres=input.prescription;
  var set=input.set||null;
  var ladder=input.ladder||{step:null,rungs:null,source:'estimated',exact:false};
  var scope=input.finalSet?'next session':'remaining sets';
  var evidence=strengthEffortEvidence(pres,set);
  var reps=set?set.reps:null;
  var load=set?set.load:null;
  var base={
    outcome:'hold',direction:'same',tone:'green',targetLoad:load,repTarget:pres.repFloor,
    conflict:false,scope:scope,confidence:strengthLadderConfidence(ladder),
    effort:evidence,policyVersion:STRENGTH_POLICY.version
  };
  if(!set||!set.quality){
    base.outcome='none';base.tone='blue';base.targetLoad=load;
    base.message='';
    return null;
  }
  // Technique or pain outranks everything. Never an increase, no diagnosis.
  if(set.quality==='form_pain'){
    var easier=strengthEasierRung(pres,load,ladder);
    base.outcome='reduce';base.direction='easier';base.tone='red';
    base.targetLoad=easier.load!=null&&easier.load!==load?easier.load:load;
    base.flagCoach=true;
    base.confidence=strengthConfidence('low','technique or niggle');
    base.message=load==null
      ?'Technique or a niggle stopped this set — stop the exercise or drop to a load you control, and tell your coach.'
      :(easier.load!=null&&easier.load!==load
        ?'Technique or a niggle stopped this set — drop to '+_seLoadLabel(pres,easier.load)+' for the '+scope+' or stop here, and tell your coach.'
        :'Technique or a niggle stopped this set — stop or reduce the load for the '+scope+', and tell your coach.');
    return base;
  }
  if(load==null&&!pres.bodyweight){
    base.outcome='hold';base.tone='blue';base.targetLoad=null;
    base.confidence=strengthConfidence('low','no load recorded');
    base.message='Log the load you used before the '+scope+' can be adjusted.';
    return base;
  }
  var belowFloor=reps!=null&&reps<pres.repFloor;
  var aboveCeiling=reps!=null&&reps>pres.repCeiling;
  var atLimit=set.quality==='at_limit'||evidence.band==='hard';
  var claimsEasy=set.quality==='too_easy'||evidence.band==='easy';
  // Conflicting evidence never moves a load. It holds, says so, and drops the
  // confidence rather than picking whichever input is louder.
  if(evidence.conflict||(claimsEasy&&belowFloor)||(set.quality==='too_hard'&&aboveCeiling)){
    base.outcome='hold';base.tone='yellow';base.targetLoad=load;base.conflict=true;
    base.confidence=strengthConfidence('low','inputs disagree');
    base.message='Your reps and your effort rating do not agree, so the load stays where it is for the '+scope+'. Check the numbers or ask your coach.';
    return base;
  }
  if(belowFloor&&atLimit){
    var down=strengthEasierRung(pres,load,ladder);
    base.outcome='reduce';base.direction='easier';base.tone='yellow';
    base.targetLoad=down.load!=null?down.load:load;
    base.confidence=down.exact?strengthLadderConfidence(ladder):strengthConfidence('estimated');
    base.message=down.load!=null&&down.load!==load
      ?'That came in under '+pres.repFloor+' reps at a hard effort — '+_seChangeVerb(pres,'easier')+_seLoadLabel(pres,down.load)+' for the '+scope+'.'
      :'That came in under '+pres.repFloor+' reps at a hard effort — take the '+scope+' a notch easier.';
    return base;
  }
  if(belowFloor){
    base.outcome='hold';base.tone='yellow';base.targetLoad=load;
    base.confidence=strengthConfidence('low','reps under the range');
    base.message='That came in under '+pres.repFloor+' reps. Hold '+_seLoadLabel(pres,load)+' for the '+scope+' and aim for '+pres.repFloor+'.';
    return base;
  }
  if(aboveCeiling||claimsEasy){
    var up=strengthHarderRung(pres,load,ladder);
    if(up.load==null||up.load===load){
      base.outcome='hold';base.tone='yellow';base.targetLoad=load;
      base.confidence=strengthLadderConfidence(ladder);
      base.message=pres.bodyweight
        ?'More reps were there — add clean reps or move to a harder variation for the '+scope+'.'
        :'More reps were there — pick the next setting up on your equipment for the '+scope+'.';
      return base;
    }
    base.outcome='increase';base.direction='harder';base.tone='yellow';
    base.targetLoad=up.load;
    base.repTarget=pres.repMode==='exact'?pres.exactReps:pres.repFloor;
    base.confidence=up.exact?strengthLadderConfidence(ladder):strengthConfidence('estimated');
    base.message=(aboveCeiling?'That went past '+pres.repCeiling+' reps':'You had clean reps left')+' — '+_seChangeVerb(pres,'harder')+_seLoadLabel(pres,up.load)+' for the '+scope+', back to '+base.repTarget+' reps.';
    return base;
  }
  base.outcome='hold';base.tone='green';base.targetLoad=load;
  base.message='Target hit — keep '+_seLoadLabel(pres,load)+' for the '+scope+'.';
  return base;
}
function _seLoadValue(pres,load){
  if(load==null)return '--';
  var n=_seRound(load);
  return (Number.isInteger(n)?String(n):n.toFixed(1))+pres.unit;
}
function _seLoadLabel(pres,load){
  if(load==null)return 'this load';
  if(pres.assisted)return _seLoadValue(pres,load)+' assistance';
  if(pres.loadMode==='bodyweight'&&_seRound(load)===0)return 'bodyweight';
  return _seLoadValue(pres,load);
}
// One place decides how an action reads, so "assistance" is never doubled up
// and an assisted machine never reads as though the number should go up.
function _seActionText(pres,direction,load,ramped){
  if(load==null)return direction==='hold'?'Hold this setting':'Choose a setting you control';
  var value=_seLoadValue(pres,load);
  if(direction==='harder'){
    if(pres.assisted)return 'Reduce assistance to '+value;
    return (ramped?'Top set to ':'Increase to ')+value;
  }
  if(direction==='easier'){
    return pres.assisted?('Increase assistance to '+value):('Reduce to '+value);
  }
  if(direction==='start'){
    return pres.assisted?('Start with '+value+' assistance'):('Start at '+value);
  }
  if(pres.assisted)return (ramped?'Hardest set stays at ':'Stay at ')+value+' assistance';
  return (ramped?'Top set stays at ':'Stay at ')+value;
}
function _seChangeVerb(pres,direction){
  if(pres.assisted)return direction==='harder'?'reduce assistance to ':'increase assistance to ';
  return direction==='harder'?'move up to ':'reduce to ';
}

// ── progression decision ─────────────────────────────────────────────────────
// One decision object per exercise. `decision` is the machine-readable verdict;
// status/action/reason are the copy rendered from it.
function _seDecision(fields){
  var base={
    policyVersion:STRENGTH_POLICY.version,
    decision:'hold_load',tone:'blue',status:'Hold',action:'',weightKg:null,arrow:'→',
    target:null,targetNote:null,reason:'',confidence:strengthConfidence('low'),
    estimated:false,conflict:false,painFlag:false,coachReview:false,perSet:null,
    beatenBy:null,ramped:false
  };
  Object.keys(fields||{}).forEach(function(key){base[key]=fields[key];});
  return base;
}
function _seFilled(n,value){var out=[];for(var i=0;i<n;i++)out.push(value);return out;}
function _seSessionLoad(pres,rows){
  var loads=rows.filter(function(r){return r.hasLoad;}).map(function(r){return r.load;});
  if(!loads.length)return null;
  return pres.assisted?Math.min.apply(null,loads):Math.max.apply(null,loads);
}
// Ramped / top-set work is not one load. Roles are read from the coach's set
// plan when there is one, and otherwise inferred from the loads themselves.
function _seRoles(pres,rows){
  var loads=rows.filter(function(r){return r.hasLoad;}).map(function(r){return r.load;});
  var distinct={};loads.forEach(function(v){distinct[_seRound(v)]=1;});
  var ramped=Object.keys(distinct).length>1;
  if(!ramped)return {ramped:false,top:null,backoff:null};
  var top=pres.assisted?Math.min.apply(null,loads):Math.max.apply(null,loads);
  var rest=loads.filter(function(v){return v!==top;});
  var backoff=rest.length?(pres.assisted?Math.min.apply(null,rest):Math.max.apply(null,rest)):null;
  return {ramped:true,top:top,backoff:backoff};
}
function _seDecide(input){
  input=input||{};
  var pres=input.prescription;
  var rows=input.sets||[];
  var history=input.history||[];
  var ladder=input.ladder||strengthLadder(pres,history,input.sliceWorking);
  var working=strengthWorkingRows(rows);
  var completed=strengthCompletedRows(rows);
  var required=pres.workingSets;
  var reps=completed.map(function(r){return r.reps;});
  var load=_seSessionLoad(pres,completed.length?completed:working);
  var roles=_seRoles(pres,completed);
  var painRow=working.filter(function(r){return r.quality==='form_pain';})[0]||null;
  var hardRow=working.filter(function(r){
    var evidence=strengthEffortEvidence(pres,r);
    return r.quality==='too_hard'||r.quality==='at_limit'||evidence.band==='hard';
  })[0]||null;

  // 0. Rep modes the rep engine has no business running on.
  if(pres.repMode==='seconds'||pres.repMode==='distance'||pres.repMode==='other'){
    var unitWord=pres.repMode==='seconds'?'time under tension':(pres.repMode==='distance'?'distance':'prescription');
    return _seDecision({
      decision:'mode_deferred',status:'Follow The Prescription',tone:'blue',
      action:load!=null?_seActionText(pres,'hold',load):'As written',
      weightKg:load,arrow:'→',
      targetNote:'This exercise is prescribed by '+unitWord+'. Hold the written target and let your coach change it.',
      reason:'Rep-based progression does not apply to a '+unitWord+' prescription.',
      confidence:strengthConfidence('coach_set','coach prescription'),
      assisted:pres.assisted,coachReview:false
    });
  }

  // 2. Nothing usable yet: calibrate against the coach's target, never invent a
  //    precise kilo figure the equipment may not have.
  if(!completed.length&&load==null){
    if(pres.targetLoad!=null){
      return _seDecision({
        decision:'coach_target',status:'Coach Target',tone:'blue',
        action:_seActionText(pres,'start',pres.targetLoad),weightKg:pres.targetLoad,arrow:'→',
        target:_seFilled(required,pres.repFloor),
        reason:'Your coach set this load. Work at '+_seEffortLabel(pres)+'.',
        confidence:strengthConfidence('coach_set','coach target load'),assisted:pres.assisted
      });
    }
    return _seDecision({
      decision:'calibrate',tone:'blue',status:pres.assisted?'Set Assistance':'Find Your Load',
      action:pres.assisted?'Choose your assistance level':(pres.bodyweight?'Bodyweight to start':'Choose a load you control'),
      weightKg:null,arrow:'',
      targetNote:(pres.bodyweight
        ?'Aim for '+pres.repFloor+' clean reps and '+_seEffortLabel(pres)+'.'
        :'Pick a setting you control for '+pres.repFloor+' clean reps, stopping when you could complete about '+pres.targetRir+' more clean reps.'),
      reason:'First session on this exercise, so there is nothing to compare against yet.',
      confidence:strengthConfidence('low','no history yet'),
      estimated:true,assisted:pres.assisted
    });
  }

  // 3. Safety feedback outranks every progression signal, including an earlier
  //    "too easy" answer or enough reps to otherwise earn an increase.
  if(painRow){
    var painLoad=painRow.load!=null?painRow.load:load;
    var painEasier=strengthEasierRung(pres,painLoad,ladder);
    var firstPain=painRow===working[0];
    return _seDecision({
      decision:firstPain?'reduce_load':'technique_check',status:firstPain?'Reduce Load':'Technique Check',tone:'red',
      action:painEasier.load!=null&&painEasier.load!==painLoad
        ?_seActionText(pres,firstPain?'start':'easier',painEasier.load)
        :('Hold '+_seLoadLabel(pres,painLoad)),
      weightKg:painEasier.load!=null?painEasier.load:painLoad,arrow:'↻',
      target:_seFilled(required,pres.repFloor),
      reason:firstPain
        ?'Your first working set lost clean technique. The next workout starts easier so every rep stays controlled.'
        :'A working set was stopped for technique or a niggle, so the load does not go up. Reduce it or leave the movement out next session, and tell your coach.',
      confidence:strengthConfidence('low','technique or niggle'),
      painFlag:true,coachReview:true,assisted:pres.assisted
    });
  }
  if(hardRow){
    var hardLoad=hardRow.load!=null?hardRow.load:load;
    var missedFloor=hardRow.reps!=null&&hardRow.reps<pres.repFloor;
    var hardEasier=missedFloor?strengthEasierRung(pres,hardLoad,ladder):null;
    return _seDecision({
      decision:missedFloor?'reduce_load':'hold_load',
      status:missedFloor?'Reduce Load':'Hold The Load',tone:'red',
      action:missedFloor&&hardEasier&&hardEasier.load!=null&&hardEasier.load!==hardLoad
        ?_seActionText(pres,'easier',hardEasier.load)
        :_seActionText(pres,'hold',hardLoad),
      weightKg:missedFloor&&hardEasier&&hardEasier.load!=null?hardEasier.load:hardLoad,arrow:missedFloor?'↻':'→',
      target:_seFilled(required,pres.repFloor),
      reason:missedFloor
        ?'A working set came in under '+pres.repFloor+' reps at a hard effort. Reduce the load and regain the bottom of the programmed range with clean technique.'
        :'The effort was harder than prescribed, so the load does not go up. Hold it and finish with clean reps at '+_seEffortLabel(pres)+'.',
      confidence:missedFloor&&hardEasier&&hardEasier.exact?strengthLadderConfidence(ladder):strengthConfidence('low','hard effort recorded'),
      assisted:pres.assisted
    });
  }

  var hasEasySignal=completed.some(function(row){
    var evidence=strengthEffortEvidence(pres,row);
    return row.quality==='too_easy'||evidence.band==='easy';
  });
  var firstWorking=working[0]||null;
  var hasSameDayHarder=!!(firstWorking&&working.slice(1).some(function(row){
    return row.hasLoad&&firstWorking.hasLoad&&_seIsHarder(pres,row.load,firstWorking.load);
  }));
  if(hasEasySignal&&!hasSameDayHarder&&completed.some(function(row){return row.reps<pres.repFloor;})){
    return _seDecision({
      decision:'hold_load',status:'Build The Reps',tone:'red',
      action:_seActionText(pres,'hold',load),weightKg:load,arrow:'→',
      target:_seFilled(required,pres.repFloor),
      reason:'A working set came in under '+pres.repFloor+' reps. The coach-programmed range outranks an easy rating, so own the bottom of the range before the load moves.',
      confidence:strengthConfidence('confirmed','programmed rep floor'),assisted:pres.assisted
    });
  }

  // 4. First-working-set calibration can correct an obviously wrong starting
  //    point today, and carries forward only once a later set confirms it.
  var first=working[0]||null;
  if(first&&first.quality&&first.quality!=='on_target'){
    var calibration=strengthCalibrationDecision({prescription:pres,set:first,ladder:ladder,finalSet:true});
    if(calibration&&calibration.outcome==='reduce'&&calibration.targetLoad!=null){
      return _seDecision({
        decision:'reduce_load',status:'Reduce Load',tone:'red',
        action:_seActionText(pres,'start',calibration.targetLoad),
        weightKg:calibration.targetLoad,arrow:'↻',
        target:_seFilled(required,pres.repFloor),
        reason:first.quality==='form_pain'
          ?'Your first working set lost clean technique. The next workout starts easier so every rep stays controlled.'
          :'Your first working set came in under '+pres.repFloor+' reps at a hard effort. The next workout starts easier so you can own the full range.',
        confidence:calibration.confidence,estimated:calibration.confidence.level==='estimated',
        calibrated:true,painFlag:first.quality==='form_pain',coachReview:first.quality==='form_pain',
        assisted:pres.assisted
      });
    }
    if(calibration&&calibration.outcome==='increase'){
      // A same-day change only becomes next session's baseline once a later
      // programmed working set reaches the floor at a genuinely harder setting.
      // When the equipment ladder is unknown, the athlete's entered load is the
      // rung — the engine never fabricates one.
      var adjusted=working.slice(1).filter(function(row){
        if(!row.hasLoad)return false;
        return _seIsHarder(pres,row.load,first.load);
      });
      var confirmed=adjusted.filter(function(row){
        return row.counts&&row.reps>=pres.repFloor&&row.quality!=='form_pain';
      });
      var attemptedLoads=adjusted.map(function(row){return row.load;});
      var attemptedLoad=attemptedLoads.length?(pres.assisted?Math.min.apply(null,attemptedLoads):Math.max.apply(null,attemptedLoads)):calibration.targetLoad;
      if(adjusted.length&&!confirmed.length){
        return _seDecision({
          decision:'change_unconfirmed',tone:'yellow',
          status:'Consolidating '+_seLoadValue(pres,attemptedLoad),
          action:_seConsolidateAction(pres,first.load,attemptedLoad),
          weightKg:first.load,arrow:'↻',
          target:_seFilled(required,pres.repFloor),
          reason:'You moved '+_seLoadLabel(pres,attemptedLoad)+' today, and it did not confirm at '+pres.repFloor+' clean reps yet, so '+_seLoadLabel(pres,first.load)+' stays the baseline. Repeat that cleanly and the heavier setting is yours.',
          workingToward:{loadKg:attemptedLoad},
          confidence:strengthConfidence('confirmed','last confirmed load'),
          calibrated:true,assisted:pres.assisted
        });
      }
      var confirmedLoads=confirmed.map(function(row){return row.load;});
      var applied=confirmedLoads.length>0;
      var nextStart=applied?(pres.assisted?Math.min.apply(null,confirmedLoads):Math.max.apply(null,confirmedLoads)):calibration.targetLoad;
      if(!applied&&completed.length>=required){
        var exactNext=nextStart!=null&&calibration.confidence&&calibration.confidence.level!=='estimated';
        return _seDecision({
          decision:'increase_load',status:'Ready to Increase',tone:'green',
          action:exactNext
            ?_seActionText(pres,'harder',nextStart)
            :(pres.assisted?'Use the next lower assistance setting':'Increase to the next available weight'),
          weightKg:exactNext?nextStart:null,arrow:pres.assisted?'↘':'↗',
          target:_seFilled(required,pres.repMode==='exact'?pres.exactReps:pres.repFloor),
          reason:'The recorded effort was easier than prescribed. Increase by the smallest available step and restart at the bottom of the programmed rep range.',
          confidence:exactNext?calibration.confidence:strengthConfidence('low','equipment increment unknown'),
          estimated:false,calibrated:true,assisted:pres.assisted
        });
      }
      if(nextStart==null){
        return _seDecision({
          decision:'change_provisional',status:'Ready to Increase',tone:'green',
          action:pres.assisted?'Use the next lower assistance setting':'Increase to the next available weight',
          weightKg:null,arrow:pres.assisted?'↘':'↗',
          target:_seFilled(required,pres.repMode==='exact'?pres.exactReps:pres.repFloor),
          reason:'The load was easier than the prescribed effort. Increase it by the smallest available step and restart at the bottom of the programmed rep range.',
          confidence:strengthConfidence('low','equipment increment unknown'),
          estimated:false,calibrated:true,assisted:pres.assisted
        });
      }
      return _seDecision({
        decision:applied?'load_confirmed':'change_provisional',
        status:'Load Calibrated',tone:'green',
        action:_seActionText(pres,'start',nextStart),weightKg:nextStart,arrow:pres.assisted?'↘':'↗',
        target:_seFilled(required,pres.repFloor),
        reason:applied
          ?'Your first set showed the starting load was too easy, and a later working set confirmed the change at '+_seLoadLabel(pres,nextStart)+'.'
          :'Your first set showed the starting load was too easy. Begin there next workout and confirm it with a full working set.',
        confidence:applied?strengthConfidence('confirmed','confirmed by a later set'):strengthConfidence('estimated','not yet confirmed'),
        estimated:!applied,calibrated:true,assisted:pres.assisted
      });
    }
  }

  // 5. A too-easy signal from any completed working set overrides ordinary rep
  //    progression. The range still gates safety: an under-floor set cannot use
  //    an easy button as a licence to add load.
  var easyRow=completed.filter(function(row){
    var evidence=strengthEffortEvidence(pres,row);
    return row.quality==='too_easy'||evidence.band==='easy';
  })[0]||null;
  if(easyRow&&completed.every(function(row){return row.reps>=pres.repFloor;})){
    var easyLoad=easyRow.load!=null?easyRow.load:load;
    var easyHarder=strengthHarderRung(pres,easyLoad,ladder);
    var knownEasyLoad=easyHarder.load!=null&&easyHarder.exact;
    return _seDecision({
      decision:'increase_load',status:'Ready to Increase',tone:'green',
      action:knownEasyLoad
        ?_seActionText(pres,'harder',easyHarder.load)
        :(pres.assisted?'Use the next lower assistance setting':'Increase to the next available weight'),
      weightKg:knownEasyLoad?easyHarder.load:null,arrow:pres.assisted?'↘':'↗',
      target:_seFilled(required,pres.repMode==='exact'?pres.exactReps:pres.repFloor),
      reason:'The recorded effort was easier than prescribed. Increase by the smallest available step and restart at the bottom of the programmed rep range.',
      confidence:knownEasyLoad?strengthLadderConfidence(ladder):strengthConfidence('low','equipment increment unknown'),
      estimated:false,assisted:pres.assisted
    });
  }

  // 6. Deliberate heavier load: recognise it when every required set holds the
  //    floor, and only note the attempt when it does not.
  var lastSession=_seLastComparable(pres,history,input.sliceWorking);
  if(load!=null&&lastSession&&lastSession.load!=null&&_seIsHarder(pres,load,lastSession.load)&&completed.length){
    var atFloor=completed.filter(function(row){return row.reps>=pres.repFloor;});
    var acceptable=completed.every(function(row){return strengthEffortAcceptable(strengthEffortEvidence(pres,row));});
    if(completed.length>=required&&atFloor.length>=required&&acceptable){
      return _seDecision({
        decision:'load_confirmed',status:'New Load Confirmed',tone:'green',
        action:_seActionText(pres,'hold',load),weightKg:load,arrow:'→',
        target:_seFilled(required,Math.min(pres.repCeiling,pres.repFloor+1)),
        reason:'You held '+_seLoadLabel(pres,load)+' for all '+required+' working sets at '+pres.repFloor+'+ reps. That is the new baseline — build the reps back up before it moves again.',
        confidence:strengthConfidence('confirmed','all working sets at the new load'),assisted:pres.assisted
      });
    }
    if(atFloor.length<completed.length){
      return _seDecision({
        decision:'change_unconfirmed',tone:'yellow',
        status:'Consolidating '+_seLoadValue(pres,load),
        action:_seConsolidateAction(pres,lastSession.load,load),
        weightKg:lastSession.load,arrow:'↻',
        target:_seFilled(required,pres.repFloor),
        reason:'You reached '+_seLoadLabel(pres,load)+' today. The later sets came in under '+pres.repFloor+' reps, so '+_seLoadLabel(pres,lastSession.load)+' is still the baseline — repeat that cleanly and the heavier load becomes yours.',
        workingToward:{loadKg:load},
        confidence:strengthConfidence('confirmed','last confirmed load'),assisted:pres.assisted
      });
    }
  }

  // 7. Every required working set at or above the ceiling -> one rung harder.
  var allAtCeiling=completed.length>=required&&completed.every(function(row){return row.reps>=pres.repCeiling;});
  var effortOk=completed.every(function(row){return strengthEffortAcceptable(strengthEffortEvidence(pres,row));});
  if(allAtCeiling&&effortOk&&load!=null){
    if(pres.loadMode==='bodyweight'){
      return _seDecision({
        decision:'increase_reps',status:'Ready to Increase',tone:'green',
        action:'Add reps beyond '+pres.repCeiling,weightKg:load,arrow:'↗',
        target:_seFilled(required,pres.repCeiling+1),
        reason:'Progression unlocked. Push past '+pres.repCeiling+' reps next session, or add load if you have it.',
        confidence:strengthConfidence('confirmed','all working sets at the ceiling'),assisted:false
      });
    }
    var harder=strengthHarderRung(pres,load,ladder);
    if(harder.load==null){
      return _seDecision({
        decision:'coach_review',status:'Ask Your Coach',tone:'blue',
        action:_seActionText(pres,'hold',load),weightKg:load,arrow:'→',
        target:_seFilled(required,pres.repCeiling),
        reason:'You have earned more resistance, but this exercise has no known increment to move to. Your coach can set the next step.',
        confidence:strengthConfidence('low','no known increment'),coachReview:true,assisted:pres.assisted
      });
    }
    if(pres.assisted&&harder.atBoundary){
      return _seDecision({
        decision:'increase_load',status:'Ready to Progress',tone:'green',
        action:'Try bodyweight',weightKg:0,arrow:'↘',
        target:_seFilled(required,pres.repFloor),
        reason:'Progression unlocked. You are down to zero assistance — next session is a bodyweight attempt.',
        confidence:strengthLadderConfidence(ladder),assisted:true
      });
    }
    return _seDecision({
      decision:'increase_load',tone:'green',
      status:pres.assisted?'Ready to Progress':'Ready to Increase',
      action:_seActionText(pres,'harder',harder.load,roles.ramped),
      weightKg:harder.load,arrow:pres.assisted?'↘':'↗',
      target:_seFilled(required,pres.repMode==='exact'?pres.exactReps:pres.repFloor),
      reason:'Progression unlocked. You earned '+(pres.assisted?'less assistance':'the jump')+' next session.'+(harder.exact?'':' Round to the next setting your equipment actually has.'),
      confidence:strengthLadderConfidence(ladder),estimated:!harder.exact,
      ramped:roles.ramped,
      perSet:roles.ramped?_sePerSet(pres,roles,ladder,harder.load):null,
      assisted:pres.assisted
    });
  }

  // 8. Plateau, only with enough comparable evidence behind it.
  var plateau=_sePlateau(pres,history,load,ladder,input.sliceWorking);
  if(plateau)return plateau;

  // 9. Missed the floor on a completed session -> hold and rebuild.
  if(completed.length>=required&&completed.some(function(row){return row.reps<pres.repFloor;})){
    return _seDecision({
      decision:'hold_load',status:'Build The Reps',tone:'red',
      action:_seActionText(pres,'hold',load),weightKg:load,arrow:'→',
      target:_seFilled(required,pres.repFloor),
      reason:'A working set came in under '+pres.repFloor+' reps. Own this setting for every set before it moves.',
      confidence:strengthConfidence('confirmed','last completed session'),assisted:pres.assisted
    });
  }

  // 10. Session was not finished. Missing logs are never read as zero reps.
  if(completed.length<required){
    return _seDecision({
      decision:'incomplete',status:'Finish The Sets',tone:'blue',
      action:load!=null?_seActionText(pres,'hold',load):'Log every working set',
      weightKg:load,arrow:'→',
      target:_seFilled(required,Math.max(pres.repFloor,reps.length?Math.max.apply(null,reps):pres.repFloor)),
      reason:completed.length+' of '+required+' working sets were logged last time, so there is not enough to move the load on. Complete all '+required+' and it will.',
      confidence:strengthConfidence('low','incomplete session'),assisted:pres.assisted
    });
  }

  // 11. Exact-rep prescriptions never invent an extra rep.
  if(pres.repMode==='exact'||pres.progression.type==='exact_reps'){
    return _seDecision({
      decision:'hold_load',status:'Hold The Load',tone:'yellow',
      action:_seActionText(pres,'hold',load),weightKg:load,arrow:'→',
      target:_seFilled(required,pres.exactReps||pres.repFloor),
      reason:'Your coach wrote exactly '+(pres.exactReps||pres.repFloor)+' reps, so the reps stay put. Hit all '+required+' sets cleanly and the load moves next.',
      confidence:strengthConfidence('coach_set','exact rep prescription'),assisted:pres.assisted
    });
  }

  // 12. Double progression: one more total rep, never past the ceiling.
  var target=[];
  for(var k=0;k<required;k++){
    var basis=reps[k]!=null?reps[k]:(reps.length?reps[reps.length-1]:pres.repFloor);
    target.push(Math.min(pres.repCeiling,basis));
  }
  for(var m=0;m<target.length;m++){if(target[m]<pres.repCeiling){target[m]=target[m]+1;break;}}
  var totalReps=reps.reduce(function(a,b){return a+b;},0);
  return _seDecision({
    decision:'add_reps',status:'Beat Last Week',tone:'yellow',
    action:_seActionText(pres,'hold',load,roles.ramped),
    weightKg:load,arrow:'→',target:target,
    reason:'One extra clean rep before '+(pres.assisted?'reducing assistance.':'the load moves.')+' Last session was '+totalReps+' total reps across '+reps.length+' working sets.',
    confidence:strengthConfidence('confirmed','last completed session'),
    beatTotal:totalReps,ramped:roles.ramped,
    perSet:roles.ramped?_sePerSet(pres,roles,ladder):null,
    assisted:pres.assisted
  });
}
// Public entry point. Every decision carries the athlete's progression history
// and their high-water marks, so a card can show a step back in the context of
// what they have actually built rather than as a bare lower number.
function strengthProgressionDecision(input){
  input=input||{};
  var pres=input.prescription;
  var decision=_seDecide(input);
  var peak=strengthPeak(pres,input.history||[],input.sliceWorking,input.sets||[]);
  decision.peak=peak;
  decision.reached=peak.reached;
  decision.history=strengthProgressionHistory(pres,input.history||[],input.sliceWorking,STRENGTH_POLICY.historyPoints);
  // A recommendation below what they have already reached is a consolidation
  // step, never a demotion. Flag it so the card can say so out loud.
  decision.belowPeak=!!(peak.reached&&decision.weightKg!=null&&_seIsHarder(pres,peak.reached.loadKg,decision.weightKg));
  if(decision.belowPeak&&!decision.workingToward)decision.workingToward={loadKg:peak.reached.loadKg};
  return decision;
}
// "Repeat the load that is confirmed, to lock in the one you have reached."
function _seConsolidateAction(pres,repeatLoad,targetLoad){
  var repeat=_seLoadValue(pres,repeatLoad),target=_seLoadValue(pres,targetLoad);
  if(pres.assisted)return 'Repeat '+repeat+' assistance to lock in '+target;
  return 'Repeat '+repeat+' to lock in '+target;
}
function _seEffortLabel(pres){
  if(pres.targetRir<=0)return 'the effort your coach set';
  return 'about '+pres.targetRir+' clean rep'+(pres.targetRir===1?'':'s')+' in reserve';
}
// Ramped and top-set/back-off plans keep their shape: each role gets its own
// line rather than being flattened into the session's heaviest load.
function _sePerSet(pres,roles,ladder,newTop){
  if(!roles.ramped)return null;
  var top=newTop!=null?newTop:roles.top;
  var delta=(newTop!=null&&roles.top!=null)?_seRound(newTop-roles.top):0;
  var backoff=roles.backoff!=null?_seRound(roles.backoff+delta):null;
  var out=[];
  if(top!=null)out.push({role:'top',loadKg:top,reps:pres.repFloor,label:'Top set'});
  if(backoff!=null)out.push({role:'backoff',loadKg:backoff,reps:pres.repCeiling,label:'Back-off'});
  return out.length?out:null;
}
function _seIsHarder(pres,candidate,reference){
  return pres.assisted?candidate<reference-0.01:candidate>reference+0.01;
}
// A live weight entry is a progression input even before the athlete has typed
// reps. This small decision layer deliberately accepts weight-only rows, while
// saved-history decisions continue to require reps. It never mutates a set.
function strengthLiveLoadDecision(input){
  input=input||{};
  var pres=input.prescription;
  if(!pres||pres.repMode==='seconds'||pres.repMode==='distance'||pres.repMode==='other'||pres.loadMode==='bodyweight')return null;
  var current=strengthWorkingRows(input.sets||[]);
  var loaded=current.filter(function(row){return row.hasLoad;});
  if(!loaded.length)return null;
  // The last working row with a load is the setting the athlete is using now.
  // Using the session maximum would misread a deliberate same-session reduction
  // as though the earlier, heavier load were still active.
  var active=loaded[loaded.length-1];
  var candidate=active.load;
  var referenceRows=strengthCompletedRows(input.referenceSets||[]);
  var reference=_seSessionLoad(pres,referenceRows);
  if(reference==null){
    var earlier=loaded.filter(function(row){return row.index<active.index&&row.load!==candidate;});
    if(earlier.length)reference=earlier[earlier.length-1].load;
  }
  if(reference==null||candidate==null||!_seIsHarder(pres,candidate,reference))return null;

  var startWorkingIndex=0;
  for(var i=0;i<current.length;i++){
    if(current[i]===active){startWorkingIndex=i;break;}
  }
  for(var j=0;j<current.length;j++){
    if(current[j].hasLoad&&_seIsHarder(pres,current[j].load,reference)){
      startWorkingIndex=j;break;
    }
  }
  var relevant=current.slice(startWorkingIndex);
  var pain=relevant.filter(function(row){return row.quality==='form_pain';})[0]||null;
  var hard=relevant.filter(function(row){
    var evidence=strengthEffortEvidence(pres,row);
    return row.quality==='too_hard'||row.quality==='at_limit'||evidence.band==='hard';
  })[0]||null;
  var target=pres.repMode==='exact'?pres.exactReps:pres.repFloor;
  var effort='Maintain approximately '+pres.targetRir+' rep'+(pres.targetRir===1?'':'s')+' in reserve.';
  if(pain){
    return {
      decision:'live_technique_check',status:'Technique Check',tone:'red',loadChanged:true,
      previousLoad:reference,currentLoad:candidate,targetLoad:reference,repTarget:target,
      startWorkingIndex:startWorkingIndex,
      action:'Do not increase the load',
      message:'Technique or pain feedback overrides the load increase.',
      prompt:'Reduce the load or stop this exercise, and tell your coach.',
      reason:'A technique or pain warning was recorded after the load change, so progression is paused.',
      painFlag:true,coachReview:true
    };
  }
  if(hard&&hard.reps!=null&&hard.reps<pres.repFloor){
    return {
      decision:'live_reduce_load',status:'Reduce Load',tone:'red',loadChanged:true,
      previousLoad:reference,currentLoad:candidate,targetLoad:reference,repTarget:target,
      startWorkingIndex:startWorkingIndex,
      action:'Reduce the load',
      message:'The higher load fell below '+pres.repFloor+' reps at a hard effort.',
      prompt:'Reduce the load and regain '+pres.repFloor+' clean reps. '+effort,
      reason:'The new load is above the previous baseline, but it missed the bottom of the coach-programmed range at excessive effort.'
    };
  }
  if(hard){
    return {
      decision:'live_hold_load',status:'Hold The Load',tone:'red',loadChanged:true,
      previousLoad:reference,currentLoad:candidate,targetLoad:candidate,repTarget:target,
      startWorkingIndex:startWorkingIndex,
      action:'Do not increase again',
      message:'The higher load is harder than prescribed.',
      prompt:'Keep the load here or reduce it; do not add another increment.',
      reason:'Too-hard or failed-rep feedback prevents another load-increase recommendation.'
    };
  }
  return {
    decision:'live_load_increase',status:'Load Increased',tone:'green',loadChanged:true,
    previousLoad:reference,currentLoad:candidate,targetLoad:candidate,repTarget:target,
    startWorkingIndex:startWorkingIndex,
    action:'Aim for '+target+' clean reps',
    message:'Load increased',
    prompt:'Aim for '+target+' clean reps. '+effort,
    reason:'The entered load is higher than the previous confirmed working load. That is progression even when reps reset to the bottom of the programmed range.'
  };
}
// The most recent history entry that is genuinely comparable: same context, at
// least one working set with reps.
function _seLastComparable(pres,history,sliceWorking){
  var found=null;
  (history||[]).some(function(entry){
    if(!entry)return false;
    if(entry.context&&entry.context!==pres.contextKey)return false;
    var raw=Array.isArray(entry)?entry:(entry.sets||[]);
    var rows=typeof sliceWorking==='function'?sliceWorking(raw):raw;
    var norm=strengthCompletedRows(normaliseStrengthSets(rows,pres));
    if(!norm.length)return false;
    found={
      load:_seSessionLoad(pres,norm),
      reps:norm.map(function(row){return row.reps;}),
      complete:norm.length>=pres.workingSets,
      date:entry.date||null
    };
    return true;
  });
  return found;
}
// A plateau needs comparable, completed sessions at the same load with no rep
// progress AND evidence that the effort is already high. Three sessions sharing
// a load is not on its own a reason to deload.
function _sePlateau(pres,history,currentLoad,ladder,sliceWorking){
  var need=STRENGTH_POLICY.plateauSessions;
  var comparable=[];
  (history||[]).forEach(function(entry){
    if(comparable.length>=need)return;
    if(!entry)return;
    if(entry.context&&entry.context!==pres.contextKey)return;
    var raw=Array.isArray(entry)?entry:(entry.sets||[]);
    var rows=typeof sliceWorking==='function'?sliceWorking(raw):raw;
    var norm=normaliseStrengthSets(rows,pres);
    var done=strengthCompletedRows(norm);
    if(done.length<pres.workingSets)return;   // incomplete sessions are not evidence
    comparable.push({
      load:_seSessionLoad(pres,done),
      total:done.reduce(function(a,row){return a+row.reps;},0),
      topped:done.every(function(row){return row.reps>=pres.repCeiling;}),
      highEffort:done.some(function(row){
        var evidence=strengthEffortEvidence(pres,row);
        return evidence.band==='hard'||row.quality==='at_limit';
      })
    });
  });
  if(comparable.length<need)return null;
  var sameLoad=comparable.every(function(x){return x.load!=null&&x.load===comparable[0].load;});
  if(!sameLoad)return null;
  if(comparable.some(function(x){return x.topped;}))return null;
  // Reps still climbing is progress, not a plateau.
  if(comparable[0].total>comparable[need-1].total)return null;
  var recentlyChanged=currentLoad!=null&&comparable[0].load!=null&&currentLoad!==comparable[0].load;
  if(recentlyChanged)return null;
  var highEffort=comparable.filter(function(x){return x.highEffort;}).length;
  if(highEffort<STRENGTH_POLICY.plateauHighEffortSessions){
    return _seDecision({
      decision:'hold_load',status:'Hold And Log',tone:'yellow',
      action:_seActionText(pres,'hold',comparable[0].load),weightKg:comparable[0].load,arrow:'→',
      target:_seFilled(pres.workingSets,pres.repFloor),
      reason:'Three sessions at '+_seLoadLabel(pres,comparable[0].load)+' with no rep gain, but nothing says the effort is maxed. Rate the first set honestly next time so this can call it properly.',
      confidence:strengthConfidence('low','effort not recorded'),assisted:pres.assisted
    });
  }
  var easier=strengthEasierRung(pres,comparable[0].load,ladder);
  return _seDecision({
    decision:'reduce_load',status:'Back Off And Rebuild',tone:'red',
    action:easier.load!=null&&easier.load!==comparable[0].load
      ?_seActionText(pres,'easier',easier.load)
      :_seActionText(pres,'hold',comparable[0].load),
    weightKg:easier.load!=null?easier.load:comparable[0].load,arrow:'↻',
    target:_seFilled(pres.workingSets,pres.repFloor),
    reason:'Three comparable sessions at '+_seLoadLabel(pres,comparable[0].load)+' with no rep progress at a hard effort. Take one step back, sharpen the reps, then climb again — or ask your coach.',
    confidence:strengthLadderConfidence(ladder),coachReview:true,assisted:pres.assisted
  });
}

// ── progression history ──────────────────────────────────────────────────────
// The record an athlete needs to see when a recommendation steps back: what
// they have actually completed on this exercise, oldest to newest, plus the
// heaviest load they have genuinely reached. A consolidation step is one point
// on a rising line, not a demotion, and the card should be able to show that.
function _seSessionSummary(pres,rows){
  var done=strengthCompletedRows(rows);
  if(!done.length)return null;
  var load=_seSessionLoad(pres,done);
  return {
    loadKg:load,
    totalReps:done.reduce(function(a,row){return a+row.reps;},0),
    bestReps:done.reduce(function(a,row){return Math.max(a,row.reps);},0),
    sets:done.length,
    complete:done.length>=pres.workingSets,
    anyAtFloor:done.some(function(row){return row.reps>=pres.repFloor;}),
    allAtFloor:done.every(function(row){return row.reps>=pres.repFloor;})
  };
}
function strengthProgressionHistory(pres,history,sliceWorking,limit){
  var out=[];
  (history||[]).forEach(function(entry){
    if(!entry)return;
    if(entry.context&&entry.context!==pres.contextKey)return;
    var raw=Array.isArray(entry)?entry:(entry.sets||[]);
    var rowsIn=typeof sliceWorking==='function'?sliceWorking(raw):raw;
    var summary=_seSessionSummary(pres,normaliseStrengthSets(rowsIn,pres,'working'));
    if(!summary)return;
    summary.date=entry.date||null;
    out.push(summary);
  });
  // History arrives newest-first. A progress strip reads oldest to newest.
  out.reverse();
  if(limit&&out.length>limit)out=out.slice(out.length-limit);
  return out;
}
// Two high-water marks, because they answer different questions.
// `reached` is the heaviest load they have ever moved for a working set at the
// rep floor — a real achievement, even if the session was not consolidated.
// `confirmed` is the heaviest load where every required set held the floor —
// the baseline the engine will actually build from.
function strengthPeak(pres,history,sliceWorking,currentRows){
  var reached=null,confirmed=null;
  function consider(summary){
    if(!summary||summary.loadKg==null)return;
    if(summary.anyAtFloor&&(reached==null||_seIsHarder(pres,summary.loadKg,reached.loadKg))){
      reached={loadKg:summary.loadKg,reps:summary.bestReps,date:summary.date||null};
    }
    if(summary.complete&&summary.allAtFloor&&(confirmed==null||_seIsHarder(pres,summary.loadKg,confirmed.loadKg))){
      confirmed={loadKg:summary.loadKg,reps:summary.bestReps,date:summary.date||null};
    }
  }
  strengthProgressionHistory(pres,history,sliceWorking).forEach(consider);
  if(currentRows&&currentRows.length)consider(_seSessionSummary(pres,currentRows));
  return {reached:reached,confirmed:confirmed};
}

// ── over-performance, read live ──────────────────────────────────────────────
// A beaten per-set target is acknowledged the moment it happens, exactly, and
// separately from whether it unlocks anything.
function strengthTargetBeaten(pres,rows,targets){
  var working=strengthCompletedRows(rows);
  var best=null;
  working.forEach(function(row,index){
    var target=(targets&&targets[index]!=null)?targets[index]:pres.repCeiling;
    if(target==null)return;
    var by=row.reps-target;
    if(by>0&&(best==null||by>best.by))best={setIndex:index,by:by,reps:row.reps,target:target};
  });
  if(!best)return null;
  return {
    setIndex:best.setIndex,by:best.by,reps:best.reps,target:best.target,
    label:'Target beaten by '+best.by+' rep'+(best.by===1?'':'s')
  };
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={
    STRENGTH_POLICY:STRENGTH_POLICY,
    strengthPolicy:strengthPolicy,
    normaliseStrengthPrescription:normaliseStrengthPrescription,
    normaliseStrengthSets:normaliseStrengthSets,
    strengthWorkingRows:strengthWorkingRows,
    strengthCompletedRows:strengthCompletedRows,
    strengthEffortEvidence:strengthEffortEvidence,
    strengthLadder:strengthLadder,
    strengthHarderRung:strengthHarderRung,
    strengthEasierRung:strengthEasierRung,
    strengthCalibrationDecision:strengthCalibrationDecision,
    strengthProgressionDecision:strengthProgressionDecision,
    strengthLiveLoadDecision:strengthLiveLoadDecision,
    strengthTargetBeaten:strengthTargetBeaten,
    strengthProgressionHistory:strengthProgressionHistory,
    strengthPeak:strengthPeak,
    strengthQualityCode:strengthQualityCode
  };
}
