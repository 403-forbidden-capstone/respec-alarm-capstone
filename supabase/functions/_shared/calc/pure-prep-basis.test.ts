import assert from 'node:assert/strict';
import {test} from 'node:test';
import {choosePurePrepBasis} from './pure-prep-basis.ts';
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
test('bad numeric values ignored',()=>{
 assert.equal(choosePurePrepBasis({profileMinutes:0,historicalMinutes:[0,-1,300,Infinity]}),null);
});
