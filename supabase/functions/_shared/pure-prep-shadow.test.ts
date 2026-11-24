import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PURE_PREP_SHADOW_BASELINE_DEFINITION, PURE_PREP_SHADOW_MIN_HISTORY, buildPurePrepShadowRequest,
  eligibleForPurePrepShadow, personalizePurePrepShadow, requestPurePrepShadow, runPurePrepShadow,
} from './pure-prep-shadow.ts';

const at = new Date('2026-11-25T01:00:00Z');
const userId = '11111111-1111-4111-8111-111111111111';
const base = {
  appointmentAt: at, timezone: 'Asia/Seoul',
  verifiedAgeCode: '2', verifiedHolidayCode: null,
};
const history = Array.from({ length: 10 }, (_, i) => 25 + i);
test('10 complete past records, never 9, allow a v2 shadow request', () => {
  assert.equal(PURE_PREP_SHADOW_MIN_HISTORY, 10);
  assert.equal(buildPurePrepShadowRequest({ ...base, historyMinutes: history.slice(0, 9) }), null);
  const request = buildPurePrepShadowRequest({ ...base, historyMinutes: history });
  assert.equal(request?.model, 'prep_start_ratio_v2');
  assert.equal(request?.baseline_definition, PURE_PREP_SHADOW_BASELINE_DEFINITION);
  assert.equal(request?.history_count, 10);
  assert.equal(request?.features.baseline_observed, 29.5);
  assert.equal(request?.features['휴일종류코드'], '__MISSING__');
  assert.equal(buildPurePrepShadowRequest({ ...base, verifiedAgeCode: null, historyMinutes: history }), null);
});
test('historical outliers do not qualify as valid history', () => {
  assert.equal(buildPurePrepShadowRequest({ ...base, historyMinutes: [...history.slice(0, 9), 500] }), null);
});
test('disabled, other user, nonconsented, group, legacy, and manual cases are fail-closed', () => {
  const eligible = {
    enabled: true, allowedUserIds: userId, userId,
    profileConsentedAt: '2026-11-22T00:00:00Z', personalAppointment: true,
    purePlan: true, manualOverride: false,
  };
  assert.equal(eligibleForPurePrepShadow(eligible), true);
  for (const override of [
    { enabled: false }, { allowedUserIds: '' },
    { userId: '22222222-2222-4222-8222-222222222222' },
    { profileConsentedAt: null }, { personalAppointment: false },
    { purePlan: false }, { manualOverride: true },
  ]) assert.equal(eligibleForPurePrepShadow({ ...eligible, ...override }), false);
});
test('shadow response checks model identity, versioned target, safety range, and no auth leaks', async () => {
  const request = buildPurePrepShadowRequest({ ...base, historyMinutes: history })!;
  let calls = 0;
  const fake = async (_url: any, options: any) => {
    calls++;
    assert.equal(options.headers['x-api-key'], 'test-token-not-for-production');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.history_count, 10);
    assert.equal(body.baseline_definition, PURE_PREP_SHADOW_BASELINE_DEFINITION);
    return {
      ok: true,
      json: async () => ({
        model: 'prep_start_ratio_v2', prediction_type: 'ratio',
        training_target: 'survey_start_cluster_proxy', baseline_definition: PURE_PREP_SHADOW_BASELINE_DEFINITION, minutes: 30, ratio: 30/29.5,
      }),
    };
  };
  const cfg = { url: 'https://model.example.org', token: 'test-token-not-for-production' };
  assert.equal(await requestPurePrepShadow({ ...request, history_count: 9 }, cfg, fake as any), null);
  assert.equal(calls, 0);
  assert.equal(await requestPurePrepShadow(request, cfg, fake as any), null);
  assert.equal(calls, 1); // Survey proxy is rejected even if a model lies about the baseline definition.
  assert.equal(await requestPurePrepShadow(request, { ...cfg, url: 'http://model.example.org' }, fake as any), null);
  assert.equal(calls, 1);
  assert.equal(await requestPurePrepShadow({ ...request, baseline_definition: 'previous_day_survey_diary' as any }, cfg, fake as any), null);
  assert.equal(calls, 1);
  const actual = async () => ({ ok: true, json: async () => ({
    model: 'prep_start_ratio_v2', prediction_type: 'ratio',
    training_target: 'actual_start_depart', baseline_definition: PURE_PREP_SHADOW_BASELINE_DEFINITION, minutes: 32, ratio: 32/29.5,
  }) });
  assert.equal((await requestPurePrepShadow(request, cfg, actual as any))?.training_target, 'actual_start_depart');
  const dismissProxy=async()=>({ok:true,json:async()=>({
    model:'prep_start_ratio_v2',prediction_type:'ratio',
    training_target:'alarm_dismiss_location_proxy',baseline_definition:PURE_PREP_SHADOW_BASELINE_DEFINITION,minutes:29.5,ratio:1,
  })});
  // A trained dismissal-to-location model is still not actual preparation ground truth.
  assert.equal(await requestPurePrepShadow(request,cfg,dismissProxy as any),null);
  assert.deepEqual(await requestPurePrepShadow(request,{...cfg,allowDismissProxy:true},dismissProxy as any),{
    model:'prep_start_ratio_v2',baseline_definition:PURE_PREP_SHADOW_BASELINE_DEFINITION,
    minutes:30,ratio:1,training_target:'alarm_dismiss_location_proxy',
  });
  const incompatible=async()=>({ok:true,json:async()=>({
    model:'prep_start_ratio_v2',prediction_type:'ratio',training_target:'actual_start_depart',
    baseline_definition:'previous_day_survey_diary',minutes:29.5,ratio:1,
  })});
  assert.equal(await requestPurePrepShadow(request,cfg,incompatible as any),null);
  assert.equal(await requestPurePrepShadow(request, cfg, async () => { throw Error('offline'); }), null);
});

test('onboarding edit changes personalized shadow prediction without breaking v2 manifest',()=>{
  const history = Array.from({length:10},(_,i)=>25+i);
  const historyMean=history.reduce((a,b)=>a+b,0)/history.length;
  const oldResult=personalizePurePrepShadow(32,historyMean,30,history);
  const editedResult=personalizePurePrepShadow(32,historyMean,45,history);
  assert.equal(oldResult.personalizedBaseline,30);
  assert.equal(editedResult.personalizedBaseline,37);
  assert.equal(oldResult.predictedMinutes,33);
  assert.equal(editedResult.predictedMinutes,40);
  assert.equal(personalizePurePrepShadow(28,historyMean,null,history).personalizedBaseline,30);
});

test('enabled demo preview with zero verified sessions never calls model or privileged profile lookup', async () => {
  const original = (globalThis as any).Deno;
  const env: Record<string,string> = {
    PURE_PREP_SHADOW_ENABLED:'1',
    PURE_PREP_SHADOW_ALLOWED_USER_IDS:userId,
    // No model URL and no model API token should ever be needed below threshold.
  };
  (globalThis as any).Deno={env:{get:(k:string)=>env[k]}};
  let queried = 0;
  const query:any = {
    select:(_s:string)=>query,
    eq:(_k:string,_v:string)=>query,
    not:(_k:string,_op:string,_v:null)=>query,
    lt:(_k:string,_v:string)=>query,
    order:(_k:string,_o:any)=>query,
    limit:async (_n:number)=>({data:[],error:null}),
  };
  const fakeDb:any = {from:(table:string)=>{assert.equal(table,'appointment_participants');queried++;return query;}};
  try {
    const result=await runPurePrepShadow({
      userId,db:fakeDb,
      profile:{ml_profile_consented_at:'2026-11-20T00:00:00Z'},
      now:new Date('2026-11-23T00:00:00Z'),appointmentAt:at,timezone:'Asia/Seoul',
      personalAppointment:true,purePlan:true,manualOverride:false,
    });
    assert.deepEqual(result,{status:'INSUFFICIENT_HISTORY',valid_records:0,required_records:10});
    assert.equal(queried,1);
  } finally {
    if(original===undefined) delete (globalThis as any).Deno;
    else (globalThis as any).Deno=original;
  }
});

test('survey pilot rejects multi-UUID allowlists before querying any user data', async () => {
  const original = (globalThis as any).Deno;
  const env: Record<string,string> = {
    PURE_PREP_MODEL_LIVE_ENABLED: '0',
    PURE_PREP_SURVEY_V2_PILOT_ENABLED: '1',
    PURE_PREP_SURVEY_V2_PILOT_ALLOW_ALARM: '1',
    PURE_PREP_SURVEY_V2_PILOT_ALLOWED_USER_IDS:
      userId + ',22222222-2222-4222-8222-222222222222',
  };
  (globalThis as any).Deno={env:{get:(k:string)=>env[k]}};
  const db:any={from:()=>{throw Error('should not reach the DB')}};
  try {
    const result=await runPurePrepShadow({
      userId, db,
      profile:{ml_profile_consented_at:'2026-11-20T00:00:00Z'},
      now:new Date('2026-11-25T00:00:00Z'),
      appointmentAt:new Date('2026-11-26T00:00:00Z'),
      timezone:'Asia/Seoul',personalAppointment:true,
      purePlan:true,manualOverride:false,mode:'live',
    });
    assert.equal(result,null);
  } finally {
    if(original===undefined) delete (globalThis as any).Deno;
    else (globalThis as any).Deno=original;
  }
});
