// 하네스 바닥 시험 — 사람 데이터 · 앱 순수 함수 불러오기(loader) · 하루 시뮬레이터 결정론 · L1 계산 호출. LLM 호출 없음.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { geoState, participantTimes } from './bridge.ts';
import { simulateTruth } from './day.ts';
import { planAppt } from './l1.ts';
import { loadPersonas, PERSONA_IDS, worldDay } from './persona.ts';
import type { AppAppt } from './types.ts';

describe('데이터', () => {
  it('p01~p08 dev 8명, 7일씩', () => {
    const ps = loadPersonas();
    assert.equal(ps.length, 8);
    assert.deepEqual(ps.map((p) => p.id), [...PERSONA_IDS]);
    for (const p of ps) for (let d = 0; d < 7; d++) assert.ok(worldDay(p, d).date);
  });
  it('시험용 p09~p12는 거부', () => {
    assert.throws(() => loadPersonas(['p09']), /호출 금지/);
  });
});

describe('앱 순수 함수 불러오기', () => {
  it('L2 판정 함수가 Node에서 뜬다', () => {
    assert.equal(typeof geoState.interpretSignals, 'function');
    const at = Date.parse('2026-10-05T10:30:00+09:00');
    assert.deepEqual(participantTimes.judgeArrival(at + 6 * 60_000, at, 'LOCATION'), { isLate: true, lateMinutes: 6 });
    assert.deepEqual(participantTimes.judgeArrival(at + 3 * 60_000, at, 'LOCATION'), { isLate: null, lateMinutes: null }); // 보류 구간
  });
});

describe('하루 시뮬레이터', () => {
  it('같은 입력이면 같은 결과', () => {
    const p = loadPersonas(['p01'])[0];
    const w = worldDay(p, 0);
    assert.deepEqual(simulateTruth({ persona: p, world: w, plans: {} }), simulateTruth({ persona: p, world: w, plans: {} }));
  });
});

describe('L1 계산 호출', () => {
  it('약속 → 기상 · 출발 알람 (computePlan)', async () => {
    const p = loadPersonas(['p01'])[0];
    const w = worldDay(p, 0);
    const a = w.appts[0];
    const appt: AppAppt = {
      id: 'a1', worldId: a.id, title: a.title, date: a.date, time: a.time, at: a.at, dest: a.place, importance: 'NORMAL', importanceSource: 'DEFAULT',
      transport: a.transport, bufferMinutes: p.buffer_minutes, overrides: {}, items: [], plan: null, saved: false, savedVia: null,
    };
    const { summary } = await planAppt(appt, {
      now: new Date('2026-10-04T21:30:00+09:00'),
      profile: { bufferMinutes: 15, defaultTransport: 'TRANSIT', home: w.home },
      learned: { stats: { sampleCount: 0, p80: null }, lateCount4w: 0, travelSamples: [] },
      sameDayWake: false,
      kakaoMinutes: 58,
    });
    assert.ok(summary.wakeAt && summary.wakeAt < summary.departAt);
    assert.equal(summary.prepareSource, 'DEFAULT');
  });
});
