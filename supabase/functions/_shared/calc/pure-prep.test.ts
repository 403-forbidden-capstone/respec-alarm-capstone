import assert from 'node:assert/strict';
import { test } from 'node:test';
import { purePrepAlarmChain, purePrepChainInput } from './pure-prep.ts';

const kst = (minutes: number) => new Date(Date.UTC(2026,10,19) + (minutes - 9*60)*60_000);
const times = (input: Parameters<typeof purePrepAlarmChain>[0]) =>
  Object.fromEntries(purePrepAlarmChain(input).map(x=>[x.kind, x.at.toISOString()]));

test('pure 35m prep; departure 09:20, prepare 08:45, wake 08:25; no 20-minute double count',()=>{
  const x = {at:kst(600),travelMinutes:30,bufferMinutes:10,purePrepMinutes:35,withWake:true};
  const t=times(x);
  assert.equal(t.DEPARTURE,kst(560).toISOString());
  assert.equal(t.PREPARE,kst(525).toISOString());
  assert.equal(t.WAKE,kst(505).toISOString());
  assert.equal(purePrepChainInput(x).prepareMinutes,55);
});
test('breakfast 30m before pure preparation changes wake, not preparation',()=>{
  const x={at:kst(600),travelMinutes:30,bufferMinutes:10,purePrepMinutes:35,prePrepTaskMinutes:30,withWake:true};
  const t=times(x);
  assert.equal(t.PREPARE,kst(525).toISOString());
  assert.equal(t.WAKE,kst(475).toISOString());
});
test('extra 15m pure preparation pulls prepare and wake back without changing departure',()=>{
  const x={at:kst(600),travelMinutes:30,bufferMinutes:10,purePrepMinutes:50,withWake:true};
  const t=times(x);
  assert.equal(t.DEPARTURE,kst(560).toISOString());
  assert.equal(t.PREPARE,kst(510).toISOString());
  assert.equal(t.WAKE,kst(490).toISOString());
});
test('later appointment without wake still has pure preparation duration',()=>{
  const t=times({at:kst(1020),travelMinutes:20,bufferMinutes:5,purePrepMinutes:35,withWake:false});
  assert.equal(t.WAKE,undefined);
  assert.equal(t.DEPARTURE,kst(995).toISOString());
  assert.equal(t.PREPARE,kst(960).toISOString());
});
test('manual preparation time wins and carries auto as provenance',()=>{
  const x={at:kst(600),travelMinutes:30,bufferMinutes:10,purePrepMinutes:35,withWake:true,manualTimes:{PREPARE:kst(520)}};
  const chain=purePrepAlarmChain(x);
  assert.equal(chain.find(x=>x.kind==='PREPARE')?.at.toISOString(),kst(520).toISOString());
  assert.equal(chain.find(x=>x.kind==='PREPARE')?.auto?.toISOString(),kst(525).toISOString());
});
test('invalid or missing pure preparation baseline cannot silently become whole wake interval',()=>{
  for(const n of [0,-1,241,NaN,Infinity]){
    assert.throws(()=>purePrepAlarmChain({at:kst(600),travelMinutes:30,bufferMinutes:10,purePrepMinutes:n,withWake:true}));
  }
});
