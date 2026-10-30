// 기능 확인 표 · 실행기 · 장부 시험 — 모델 호출 없음
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { REPO } from './bridge.ts';
import { runChecks } from './checks.ts';
import { FakeLlm } from './fake-llm.ts';
import { BudgetExceeded, Ledger } from './ledger.ts';

describe('기능 확인 표 (학습루프_기초_1030.md 5절)', () => {
  it('1일치: 여러 날 필요한 2줄은 "7일 시험에서 확인", 나머지는 판정', async () => {
    const { rows } = await runChecks({ days: 1 });
    assert.equal(rows.find((r) => r.no === 2)?.ok, null);
    assert.equal(rows.find((r) => r.no === 1)?.ok, true);
    assert.equal(rows.find((r) => r.no === 4)?.ok, true);
    assert.equal(rows.find((r) => r.no === 5)?.ok, true);
    assert.equal(rows.find((r) => r.no === 6)?.ok, true);
  });
  it('기대와 다르면 정직하게 아니오 + 버그 후보 (3줄 깨우는 여유 · 5b 잠귀)', async () => {
    const { rows, bugs } = await runChecks({ days: 1 });
    assert.equal(rows.find((r) => r.no === 3)?.ok, false);
    assert.equal(rows.find((r) => r.no === 5.5)?.ok, false);
    assert.ok(bugs.some((b) => b.source === '표 3줄' && b.where.includes('plan-core.ts')));
    assert.ok(bugs.some((b) => b.source === '표 5b' && b.where.includes('plan-core.ts')));
  });
  it('7일 이상이면 2줄(매일 85분)도 계산: 회차마다 ±10분 안 · 기록 5건 뒤 "내 기록 기반 5건"', async () => {
    const { rows } = await runChecks({ days: 7 });
    const r2 = rows.find((r) => r.no === 2);
    assert.equal(r2?.ok, true, r2?.result);
    assert.match(r2?.result ?? '', /내 기록 기반 5건/);
  });
});

describe('실행기 · 장부', () => {
  it('--live 는 기능 모드만 지원한다는 오류로 거절', () => {
    const r = spawnSync(process.execPath, ['tools/sim-week/run.ts', '--live'], { cwd: REPO, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /기능 모드\(--fake\)만 지원/);
  });
  it('--days 는 1부터만', () => {
    const r = spawnSync(process.execPath, ['tools/sim-week/run.ts', '--days', '3..5'], { cwd: REPO, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /1일째부터만/);
  });
  it('기능 모드 장부는 0원, 돈이 생기면 버그로 던짐 / 실호출 자리는 상한을 넘으면 멈춤', () => {
    const feature = new Ledger({ budgetUsd: 3 });
    feature.record('x', 0);
    assert.equal(feature.summary().spentUsd, 0);
    assert.throws(() => feature.record('x', 0.01), /기능 모드에서 비용이 생김/);
    const live = new Ledger({ mode: 'LIVE', budgetUsd: 0.05 });
    live.record('a', 0.03);
    assert.throws(() => live.record('b', 0.03), BudgetExceeded);
  });
  it('가짜 모델은 호출을 세되 0원', () => {
    const ledger = new Ledger();
    const llm = new FakeLlm(ledger);
    const ex = llm.t2f({ fact_feedback: [{ fact_id: 'f1' }] });
    assert.equal(ex.appointments.length, 0);
    assert.equal(ex.safety_flag, false);
    assert.match(llm.t1({ applied: ['일정 저장'], pending: [], rejected: [], clarify: [] }), /저장됨: 일정 저장/);
    assert.equal(llm.calls, 2);
    assert.equal(ledger.summary().spentUsd, 0);
  });
});
