import assert from 'node:assert/strict';
import {test} from 'node:test';
import {choosePurePrepBasis, confirmedPurePrepHistory} from './pure-prep-basis.ts';
test('missing pure baseline remains unset',()=>{
 assert.equal(choosePurePrepBasis({}),null);
 assert.equal(choosePurePrepBasis({profileMinutes:null,historicalMinutes:[]}),null);
});
test('onboarding baseline used before 3 valid records',()=>{
 assert.deepEqual(choosePurePrepBasis({profileMinutes:30,historicalMinutes:[35,45]}),{source:'PROFILE',minutes:30});
});
test('history uses actual preparation intervals and requires three completed records',()=>{
 assert.deepEqual(choosePurePrepBasis({profileMinutes:30,historicalMinutes:[45,35,40]}),{source:'HISTORY',minutes:40,sampleCount:3});
 assert.deepEqual(choosePurePrepBasis({profileMinutes:30,historicalMinutes:[45,300,40]}),{source:'PROFILE',minutes:30});
});
test('explicit pure manual override wins over history and model',()=>{
 const p={profileMinutes:30,manualMinutes:55,historicalMinutes:[45,35,40],prediction:{minutes:50,model:'prep_start_ratio_v2',trainingTarget:'actual_start_depart'} as const,allowActualModel:true};
 assert.deepEqual(choosePurePrepBasis(p),{source:'MANUAL',minutes:55});
});
test('survey proxy never controls actual alarm baseline',()=>{
 const p={profileMinutes:30,historicalMinutes:[45,35,40],prediction:{minutes:50,model:'prep_start_ratio_v2',trainingTarget:'survey_start_cluster_proxy'} as const,allowActualModel:true};
 assert.equal(choosePurePrepBasis(p)?.source,'HISTORY');
});
test('actual model needs opt-in and valid history',()=>{
 const p={profileMinutes:30,historicalMinutes:[45,35,40],prediction:{minutes:50,model:'prep_start_ratio_v2',trainingTarget:'actual_start_depart'} as const};
 assert.equal(choosePurePrepBasis(p)?.source,'HISTORY');
 assert.deepEqual(choosePurePrepBasis({...p,allowActualModel:true}),{source:'MODEL',minutes:50,model:'prep_start_ratio_v2',sampleCount:3});
});
test('5-9m self-reports may be set, but short observed intervals are excluded from automatic history',()=>{
 assert.deepEqual(choosePurePrepBasis({profileMinutes:5,historicalMinutes:[5,8,35]}),{source:'PROFILE',minutes:5});
 const cutoff=new Date('2026-11-19T00:00:00Z');
 const good=(minutes:number,i:number)=>{
  const departed=new Date(Date.parse('2026-11-18T09:00:00Z')-i*3600000);
  return {prepare_started_at:new Date(departed.getTime()-minutes*60000).toISOString(),
    departed_at:departed.toISOString(),prepare_started_source:'PREPARE_ALARM',departed_source:'LOCATION'};
 };
 assert.deepEqual(confirmedPurePrepHistory([good(5,0),good(9,1),good(35,2)],cutoff),[35]);
 assert.deepEqual(confirmedPurePrepHistory([{...good(40,0),prepare_started_source:'ROUTINE_STEP'}],cutoff),[]);
});

test('bad numeric values ignored',()=>{
 assert.equal(choosePurePrepBasis({profileMinutes:0,historicalMinutes:[0,-1,300,Infinity]}),null);
});

test('preparation history excludes future data, alarm schedules, location-less departures and duplicates',()=>{
 const cutoff=new Date('2026-11-19T00:00:00Z');
 const good=(minutes:number,depart='2026-11-18T09:00:00Z')=>{
   const date=new Date(depart);
   return {prepare_started_at:new Date(date.getTime()-minutes*60000).toISOString(),departed_at:depart,
       prepare_started_source:'PREPARE_ALARM',departed_source:'LOCATION'};
 };
 const rows=[
   good(35),good(35),good(45,'2026-11-17T09:00:00Z'),
   good(55,'2026-11-20T09:00:00Z'),
   {...good(20,'2026-11-16T09:00:00Z'),departed_source:'MANUAL'},
   {...good(25,'2026-11-15T09:00:00Z'),prepare_started_source:'UNKNOWN'},
   good(241,'2026-11-14T09:00:00Z'),
 ];
 assert.deepEqual(confirmedPurePrepHistory(rows,cutoff),[35,45]);
 assert.deepEqual(confirmedPurePrepHistory(rows,cutoff,1),[35]);
});
