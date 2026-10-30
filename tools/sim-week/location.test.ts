// 위치 신호 → L2 판정 시험 (LLM 없음). 알람은 L1 계산 결과를 그대로 씀.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { simulateTruth } from './day.ts';
import { planAppt } from './l1.ts';
import { DEFAULT_GEO, observeDay } from './location.ts';
import { loadPersonas, worldDay } from './persona.ts';
import type { AppAppt, PlanSummary } from './types.ts';

async function run(personaId: string, dayIndex: number, params = DEFAULT_GEO) {
  const p = loadPersonas([personaId])[0];
  const world = worldDay(p, dayIndex);
  const plans: Record<string, PlanSummary | undefined> = {};
  for (const a of world.appts) {
    const appt: AppAppt = {
      id: a.id, worldId: a.id, title: a.title, date: a.date, time: a.time, at: a.at, dest: a.place, importance: a.importance ?? 'NORMAL', importanceSource: 'DEFAULT',
      transport: a.transport, bufferMinutes: p.buffer_minutes, overrides: {}, items: [], plan: null, saved: true, savedVia: null,
    };
    const day = new Date(a.at.getTime() - 24 * 3600_000);
    plans[a.id] = (await planAppt(appt, {
      now: new Date(day.getTime() - 3 * 3600_000), profile: { bufferMinutes: p.buffer_minutes, defaultTransport: p.transport, home: world.home },
      learned: { stats: { sampleCount: 0, p80: null }, lateCount4w: 0, travelSamples: [] }, sameDayWake: plans[world.appts[0].id] != null && a !== world.appts[0], kakaoMinutes: p.flow?.travel.api_estimate_min ?? null,
    })).summary;
  }
  const truth = simulateTruth({ persona: p, world, plans });
  return { world, truth, obs: observeDay({ persona: p, world, truth, plans, params }) };
}

describe('위치 상황', () => {
  it('깔끔한 날(p01 금 SUBWAY_DUP 아님 → 수): 출발 · 도착이 잡힘', async () => {
    const { obs } = await run('p01', 3);
    assert.ok(obs.trips[0].recordedDepart);
  });
  it('편의점 7분(p01 수): 집 이탈이 출발로 남지 않거나 지워짐', async () => {
    const { world, obs } = await run('p01', 2, { ...DEFAULT_GEO, homeRadiusM: 150 });
    assert.equal(world.situation, 'CONVENIENCE');
    const t = obs.trips[0];
    // 편의점 왕복 때문에 첫 이탈이 출발로 확정됐다면 RETRACT 가 있어야 함
    assert.ok(t.signals.some((s) => s.label.startsWith('CONVENIENCE')), '반경 150m에서는 편의점 왕복도 신호가 생김');
    assert.ok(!t.misjudge.includes('DEPART_FALSE'));
  });
  it('500m 안 약속(p04 수 NEAR): 도착 감지 꺼짐 → 도착 원탭 필요', async () => {
    const { world, obs } = await run('p04', 2);
    assert.equal(world.situation, 'NEAR');
    const near = obs.trips.find((t) => t.near);
    assert.ok(near);
    assert.ok(near.oneTap.includes('ARRIVE_MISSING'));
  });
  it('같은 씨앗 · 값만 바꿔도 진실은 같고 기록만 달라짐', async () => {
    const a = await run('p01', 0);
    const b = await run('p01', 0, { ...DEFAULT_GEO, homeRadiusM: 300 });
    assert.deepEqual(a.truth, b.truth);
  });
});
