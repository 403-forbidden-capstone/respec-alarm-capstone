// 기능 모드 일주일 시험 — 한 사람 하루 · 이틀(학습이 알람을 바꾸는지) · 위치 6종 · 보고서 · 질문 예산. 모델 호출 없음.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runAdjust } from './adjust-runs.ts';
import { learnedAt } from './app-state.ts';
import { budgetOf } from './coach.ts';
import { runChecks } from './checks.ts';
import { Ledger } from './ledger.ts';
import { planAppt } from './l1.ts';
import { isOversleeper, oversleepDay, oversleepDayNumber } from './day.ts';
import { PERSONA_IDS, SITUATIONS, loadPersonas, scheduledDays, situationOf, worldDay } from './persona.ts';
import { renderReport } from './report.ts';
import { runWeek } from './week.ts';
import type { AppAppt } from './types.ts';

describe('한 사람 하루', () => {
  it('p01 1일차: 밤 대화 카드 → 알람 → 진짜 하루 → 앱 기록, 모델 호출 0 · $0', async () => {
    const ledger = new Ledger();
    const w = await runWeek({ persona: 'p01', days: 1, ledger });
    assert.equal(w.days.length, 1);
    const d = w.days[0];
    assert.equal(d.seed, 'sim/p01/2026-10-05');
    assert.equal(d.world.situation, 'CAMPUS');
    assert.ok(d.night.cards.some((c) => c.status === 'SAVED'), '카드가 저장됨');
    assert.ok(d.truth.alarmWakeAt, '저장한 약속의 기상 알람이 진짜 하루의 알람이 됨');
    assert.ok(d.record.trips[0].recordedArrive, '앱이 도착을 위치로 잡음');
    const s = ledger.summary();
    assert.equal(s.spentUsd, 0);
    assert.equal(s.mode, 'FEATURE');
  });
  it('같은 씨앗 = 같은 결과', async () => {
    const a = await runWeek({ persona: 'p01', days: 1, ledger: new Ledger() });
    const b = await runWeek({ persona: 'p01', days: 1, ledger: new Ledger() });
    assert.deepEqual(a.days[0].record, b.days[0].record);
    assert.deepEqual(a.days[0].night, b.days[0].night);
  });
  it('일정 없는 날(주말 · 월요일 일정 없는 사람)도 안 깨짐', async () => {
    const w = await runWeek({ persona: 'p02', days: 1, ledger: new Ledger() }); // p02 월요일은 일정 없음
    assert.equal(w.days[0].record.trips.length, 0);
    assert.equal(w.days[0].night.cards.length, 0);
    assert.equal(w.days[0].truth.alarmWakeAt, null);
  });
});

describe('이틀: 학습이 알람을 바꾸는지', () => {
  it('1일차 기록(기상~출발)이 2일차 준비 시간 · 기상 알람에 반영됨', async () => {
    const w = await runWeek({ persona: 'p01', days: 2, ledger: new Ledger() });
    const rec1 = w.days[0].record;
    assert.ok(rec1.actualPrepareMinutes != null && rec1.actualPrepareMinutes >= 10, '1일차에 준비 실측이 기록됨');
    const d2 = w.days[1];
    const id = d2.world.appts[0].id;
    const plan2 = d2.plans[id];
    assert.ok(plan2, '2일차 첫 일정이 저장됨');
    assert.equal(plan2.prepareBasis.n, 1, '기록 1건이 통계에 들어감');
    assert.notEqual(plan2.prepareMinutes, w.app.onboardingPrepare, '준비 시간이 온보딩 첫 값에서 움직임');
    // 학습이 없었다면(기록 0건) 나왔을 알람과 다름
    const wa = d2.world.appts[0];
    const appt: AppAppt = { id: wa.id, worldId: wa.id, title: wa.title, date: wa.date, time: wa.time, at: wa.at, dest: wa.place, importance: wa.importance ?? 'NORMAL', importanceSource: 'SAID', transport: wa.transport, bufferMinutes: w.persona.buffer_minutes, overrides: {}, items: [], plan: null, saved: false, savedVia: null };
    const fresh = await planAppt(appt, {
      now: new Date(d2.night.now),
      profile: { bufferMinutes: w.persona.buffer_minutes, defaultTransport: w.persona.transport, home: d2.world.home, defaultPrepareMinutes: w.app.onboardingPrepare },
      learned: { stats: { sampleCount: 0, p80: null }, lateCount4w: 0, travelSamples: [] },
      sameDayWake: false,
      kakaoMinutes: Math.round(w.persona.flow!.travel.api_estimate_min * (wa.travelMinutes / w.persona.travel_minutes)),
    });
    assert.notEqual(plan2.wakeAt?.getTime(), fresh.summary.wakeAt?.getTime(), '배운 알람 ≠ 안 배운 알람');
  });
  it('대화로 고친 도착 시각이 앱 지각 판정을 바꿈 (CAMPUS 도착이 일렀던 날)', async () => {
    const w = await runWeek({ persona: 'p01', days: 2, ledger: new Ledger() });
    const t0 = w.days[0].obs.trips[0]; // 위치 도착 직후 (밤 대화 전)
    const t1 = w.app.records[0].trips[0]; // 정정 반영 뒤
    assert.equal(t0.isLate, false, '위치 도착은 건물보다 일러서 앱은 지각이 아니라고 봄');
    assert.ok(w.days[1].night.feedback.some((f) => f.kind === 'ARRIVE' && f.fix?.ok), 'p01(CORRECT)은 도착을 고침');
    assert.equal(t1.arriveSource, 'MANUAL');
    assert.equal(t1.isLate, true, '정정 뒤 앱 지각 판정이 진짜와 맞음');
  });
});

describe('위치 상황 6종이 한 주에 모두 나옴', () => {
  it('p01~p08 한 주 배정표에 6종 모두, 한 사람 하루 최대 1개', () => {
    const seen = new Set<string>();
    for (const id of PERSONA_IDS) {
      for (let d = 0; d < 7; d++) {
        const s = situationOf(id, d);
        if (s) seen.add(s);
        assert.equal(worldDay(loadPersonas([id])[0], d).situation, s, '하루에 상황은 하나');
      }
    }
    assert.deepEqual([...seen].sort(), [...SITUATIONS].sort());
  });
});

describe('늦잠 — 자격 인물 주 1회, 일정이 있는 날 중에서', () => {
  it('자격 인물(LATE · LATE_1_2)은 일주일에 정확히 하루, 그날 일정이 있음. 나머지는 0회', () => {
    for (const p of loadPersonas()) {
      const days = Array.from({ length: 7 }, (_, i) => worldDay(p, i));
      const hit = days.filter((w) => oversleepDay(p, w));
      if (isOversleeper(p) && scheduledDays(p).length > 0) {
        assert.equal(hit.length, 1, `${p.id} 늦잠은 주 1회`);
        assert.ok(hit[0].appts.some((a) => !a.synthetic), `${p.id} 늦잠 날에 일정이 있음`);
      } else {
        assert.equal(hit.length, 0, `${p.id} 대상 아님 · 일정 없음은 0회`);
      }
    }
    // p07: 옛 규칙(평일 중 해시)에선 일정 없는 날에 걸려 0회였던 사람
    assert.ok(loadPersonas(['p07']).every((p) => isOversleeper(p) && oversleepDayNumber(p) != null));
  });
  it('p07 7일: 진짜 하루에 늦잠(미루기 3 + 15분)이 한 번 걸림', async () => {
    const w = await runWeek({ persona: 'p07', days: 7, ledger: new Ledger() });
    const hit = w.days.filter((d) => d.truth.overslept > 0);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].truth.snoozes, 3);
    assert.ok(hit[0].world.appts.length > 0);
  });
});

describe('보고서', () => {
  it('사람 × 날짜 줄에 PR 코드 · 씨앗 · 상황, 기능 확인 표, 조정 표, 질문 예산', async () => {
    const ledger = new Ledger({ budgetUsd: 3 });
    const w = await runWeek({ persona: 'p01', days: 1, ledger });
    const checks = await runChecks({ days: 1 });
    const md = renderReport({
      command: 'node tools/sim-week/run.ts --personas p01 --days 1 --fake', codeLabel: 'main@abc1234', seed: 'sim', days: 1, weeks: [w],
      adjust: { p01: runAdjust(w.persona, w.days) }, checks, ledger: ledger.summary(), startedAt: '2026-10-30T00:00:00Z',
    });
    assert.match(md, /## 사람 × 날짜/);
    assert.match(md, /\| p01 \| 2026-10-05\(MON\) \| main@abc1234 \| sim\/p01\/2026-10-05 \| CAMPUS \|/);
    assert.match(md, /## 기능 확인 표/);
    assert.match(md, /7일 시험에서 확인/);
    assert.match(md, /## 위치 조정 표/);
    assert.match(md, /--budget 3\(표시만\)/);
    assert.match(md, /## 질문 예산/);
    assert.match(md, /## 버그 후보/);
    assert.equal((md.match(/^\| (?:[1-6]|5b) \|/gm) ?? []).length, 7, '기능 확인 표 6줄 + 5b');
  });
  it('위치 조정 표: 같은 하루에 값만 바꿔 한 줄씩 실행됨', async () => {
    const w = await runWeek({ persona: 'p01', days: 1, ledger: new Ledger() });
    const rows = runAdjust(w.persona, w.days);
    assert.equal(rows.length, 12);
    assert.ok(rows.every((r) => r.trips === 1));
    // 같은 진실이라 진짜 지각 수는 모든 줄에서 같음
    assert.equal(new Set(rows.map((r) => r.trulyLate)).size, 1);
  });
});

describe('질문 예산 (하루 1 · 주 3)', () => {
  const at = (day: number, h = 22) => `2026-10-${String(day).padStart(2, '0')}T${h}:00:00+09:00`;
  const q = (day: number) => ({ kind: 'PREP_CHECK', subject_key: `PREP_CHECK:${day}`, asked_at: at(day) });
  it('한도 안이면 위반 없음', () => {
    assert.deepEqual(budgetOf([q(5), q(6), q(7)], at(7), '2026-10-07').violations, []);
  });
  it('같은 날 2개 · 7일 4개는 버그 후보로 표시', () => {
    const sameDay = budgetOf([q(7), { ...q(7), subject_key: 'x' }], at(7), '2026-10-07');
    assert.equal(sameDay.sameDay, 2);
    assert.ok(sameDay.violations.some((v) => v.includes('하루 2개')));
    const week = budgetOf([q(4), q(5), q(6), q(7)], at(7), '2026-10-07');
    assert.equal(week.last7Days, 4);
    assert.ok(week.violations.some((v) => v.includes('7일 4개')));
  });
  it('서버 질문이 실제로 나오는 사람(p03 4일차)에서 예산을 지킴', async () => {
    const w = await runWeek({ persona: 'p03', days: 4, ledger: new Ledger() });
    const night = w.days[3].night;
    assert.equal(night.questionsAsked, 1);
    assert.equal(night.question?.kind, 'PREP_CHECK');
    assert.ok(night.cards.some((c) => c.kind === 'ALARM_EDIT'), '질문 답(준비가 더 걸림)이 알람 고침 카드가 됨');
    for (const d of w.days) assert.deepEqual(d.night.budget.violations, []);
    assert.ok(w.days.reduce((s, d) => s + d.night.questionsAsked, 0) <= 3);
  });
  it('학습 입력: 기록 · 지각 수가 이월됨', async () => {
    const w = await runWeek({ persona: 'p01', days: 1, ledger: new Ledger() });
    const learned = learnedAt(w.app, new Date('2026-10-05T22:00:00+09:00'));
    assert.equal(learned.stats.sampleCount, 1);
    assert.equal(learned.stats.p80, w.days[0].record.actualPrepareMinutes);
  });
});
