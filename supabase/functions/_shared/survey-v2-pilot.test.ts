import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SURVEY_V2_PILOT_BASELINE, buildSurveyV2PilotRequest,
  requestSurveyV2Pilot,
} from './survey-v2-pilot.ts';

const base = {
  appointmentAt: new Date('2026-11-26T01:00:00Z'),
  timezone: 'Asia/Seoul',
  verifiedAgeCode: '2',
  verifiedHolidayCode: null,
  validHistoryCount: 10,
  previousLocalDayMinutes: 30,
};

test('9 prior observations do not request survey model, 10 do', () => {
  assert.equal(buildSurveyV2PilotRequest({...base,validHistoryCount:9}),null);
  const req = buildSurveyV2PilotRequest(base);
  assert.equal(req?.history_count,10);
  assert.equal(req?.features.baseline_observed,30);
  assert.equal(req?.baseline_definition,SURVEY_V2_PILOT_BASELINE);
  assert.equal(buildSurveyV2PilotRequest({...base,validHistoryCount:31}),null);
});

test('survey model must use prior-day app proxy, never onboarding or recent average', () => {
  assert.equal(buildSurveyV2PilotRequest({...base,previousLocalDayMinutes:null}),null);
  assert.equal(buildSurveyV2PilotRequest({...base,previousLocalDayMinutes:9}),null);
  assert.equal(buildSurveyV2PilotRequest({...base,previousLocalDayMinutes:241}),null);
  assert.equal(buildSurveyV2PilotRequest({...base,verifiedAgeCode:'__MISSING__'}),null);
  assert.equal(buildSurveyV2PilotRequest({...base,previousLocalDayMinutes:40})?.features.baseline_observed,40);
});

test('matches survey proxy provenance and rejects sidecar labels from other models',async()=>{
  const req=buildSurveyV2PilotRequest(base)!;
  let count=0;
  const fake:typeof fetch=(async(_url:any,options:any)=>{
    count++;
    const q=JSON.parse(options.body);
    assert.equal(q.baseline_definition,SURVEY_V2_PILOT_BASELINE);
    assert.equal(q.features.baseline_observed,30);
    assert.equal(options.headers['x-api-key'],'research-test-only');
    return {ok:true,json:async()=>({
      model:'prep_start_ratio_v2',training_target:'survey_start_cluster_proxy',
      baseline_definition:SURVEY_V2_PILOT_BASELINE,prediction_type:'ratio',
      minutes:27,ratio:.9
    })};
  }) as any;
  const cfg={url:'https://model.example.org',token:'research-test-only'};
  const result=await requestSurveyV2Pilot(req,cfg,fake);
  assert.equal(result?.minutes,27);
  assert.equal(result?.training_target,'survey_start_cluster_proxy');
  assert.equal(count,1);
  assert.equal(await requestSurveyV2Pilot({...req,history_count:9},cfg,fake),null);
  assert.equal(await requestSurveyV2Pilot(req,{...cfg,url:'http://public.example.org'},fake),null);
  assert.equal(count,1);
  const other=(async()=>({ok:true,json:async()=>({
    model:'prep_start_ratio_v2',training_target:'actual_start_depart',
    baseline_definition:SURVEY_V2_PILOT_BASELINE,prediction_type:'ratio',
    minutes:27,ratio:.9
  })})) as any;
  assert.equal(await requestSurveyV2Pilot(req,cfg,other),null);
  const mismatch=(async()=>({ok:true,json:async()=>({
    model:'prep_start_ratio_v2',training_target:'survey_start_cluster_proxy',
    baseline_definition:'mean_last_30_valid_prep_alarm_location_v1',
    prediction_type:'ratio',minutes:27,ratio:.9
  })})) as any;
  assert.equal(await requestSurveyV2Pilot(req,cfg,mismatch),null);
  assert.equal(await requestSurveyV2Pilot(req,cfg,async()=>{throw Error('offline');}),null);
});
