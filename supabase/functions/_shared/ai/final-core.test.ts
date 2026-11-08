// 대화 끝 정리 순수부(applyFinal → structured.v1) 시험 — 모델 · DB 없음. 손으로 짠 T2 출력(extract.v2 모양)을 넣고
// 공개 JSON에 무엇이 어떻게 남는지 · 무엇을 저장 대상으로 고르는지 봄
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RefsOut } from './context-core.ts';
import { applyFinal, finishStructured, isDuplicateTodo, type FinalPlan, type Structured } from './final-core.ts';
import { validate } from './schema.ts';
import { schemaOf } from './schemas/index.ts';
import { structuredProblems } from './structured.v1.ts';
import { emptyExtract } from './testing.ts';
import type { BehaviorReport, Card, Context, FinalExtract } from './types.ts';

const REVIEW = '2026-10-29';
const YESTERDAY = '2026-10-28';
const TOMORROW = '2026-10-30';

const b = (kind: BehaviorReport['kind'], over: Partial<BehaviorReport> = {}): BehaviorReport => ({
  kind, date: REVIEW, time: null, minutes: null, appointment_ref: null, appointment_title: null, reasons: [], source: 'stated', uncertain: null, ...over,
});

// 돌아볼 날 일정 둘(캡스톤 수업 10:00 · 팀플 회의 13:00) + 기상 알람 07:50
const ctx = {
  session: { record_date: REVIEW },
  today: {
    appointments: [
      { ref: 'a1', title: '캡스톤 수업', date: REVIEW, time: '10:00' },
      { ref: 'a2', title: '팀플 회의', date: REVIEW, time: '13:00' },
    ],
    alarms: [{ ref: 'al1', type: 'WAKE', date: REVIEW, time: '07:50', enabled: true }],
  },
} as unknown as Context;
const refs: RefsOut = {
  appointments: { a1: { appointment_id: 'ap-class', participant_id: 'pt-class' }, a2: { appointment_id: 'ap-team', participant_id: 'pt-team' } },
  alarms: {},
  facts: {},
};

const card = (id: string, title: string, status: Card['status'], appointmentId: string | null = null): Card => ({
  id, kind: 'APPT_NEW', status, first_of_day: false, highlight: false, summary: '',
  draft: { title, date: TOMORROW, time: '14:00', place: null, importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } },
  edit: null, digest: null, items: [], appointment_id: appointmentId, error: null,
});

const SESSION: Structured['session'] = {
  session_id: 's1', reference_date: REVIEW, session_type: 'night', input_modes: ['text'], started_at: '2026-10-29T22:00:00+09:00', ended_at: '2026-10-29T22:30:00+09:00',
  extracted_at: '2026-10-29T22:30:00+09:00', extractor: { prompt: 'T2@v3', schema: 'extract.v2' },
};
/** 저장 결과 없이 완성한 공개 JSON — 계약(structured.v1) 검사를 늘 통과해야 함 */
function publish(p: FinalPlan): Structured {
  const s = finishStructured(p, SESSION, [], p.todos.map(() => 'inserted'));
  assert.deepEqual(structuredProblems(s), []);
  return s;
}
const run = (x: Partial<FinalExtract>, cards: Card[] = []) => {
  const plan = applyFinal(emptyExtract(x), ctx, refs, cards);
  return { plan, s: publish(plan) };
};

describe('지각 · 기상 · 준비 — 서로 다른 지연을 구분', () => {
  it('"수업 10분 지각" · "8시 알람, 8시 15분 기상" · "준비 평소보다 20분 더" → 지각 · 기상 지연 · 준비 초과가 각각 다른 자리', () => {
    const { s, plan } = run({
      behavior: [b('LATE', { minutes: 10, appointment_title: '수업' }), b('ALARM_RING', { time: '08:00' }), b('WAKE', { time: '08:15' }), b('PREP_OVER', { minutes: 20 })],
    });
    assert.deepEqual(s.schedule_outcomes.map((o) => [o.appointment_id, o.appointment_title, o.link, o.is_late, o.late_minutes, o.status]), [['ap-class', '캡스톤 수업', 'linked', true, 10, 'recorded']]);
    assert.deepEqual(s.sleep_wake.map((w) => [w.date, w.alarm_rang_at, w.wake_at, w.wake_delay_minutes, w.wake_delay_basis, w.overslept]), [
      [REVIEW, '2026-10-29T08:00:00+09:00', '2026-10-29T08:15:00+09:00', 15, 'stated_alarm_time', true],
    ]);
    assert.deepEqual(s.behavior.filter((x) => x.kind === 'prep_over').map((x) => x.minutes), [20]);
    assert.equal(s.behavior.some((x) => x.kind === 'prep_duration'), false); // 전체 준비 시간은 지어내지 않음
    assert.deepEqual(plan.records, []); // 기상 · 준비 · 지각 진술은 표에 안 씀 (측정 칸 · 다른 담당 칸)
  });

  it('기상 지연의 기준을 남김: 말한 분 > 말한 알람 시각 > 그날 예약된 기상 알람(07:50) — 알람 시각을 모르면 계산하지 않음', () => {
    assert.deepEqual(run({ behavior: [b('WAKE', { minutes: 15 })] }).s.sleep_wake.map((w) => [w.wake_delay_minutes, w.wake_delay_basis, w.wake_at]), [[15, 'stated_minutes', null]]);
    assert.deepEqual(run({ behavior: [b('WAKE', { time: '08:15' })] }).s.sleep_wake.map((w) => [w.wake_delay_minutes, w.wake_delay_basis]), [[25, 'scheduled_wake_alarm']]);
    assert.deepEqual(run({ behavior: [b('WAKE', { time: '08:15', date: YESTERDAY })] }).s.sleep_wake.map((w) => [w.date, w.wake_delay_minutes, w.wake_delay_basis, w.overslept]), [[YESTERDAY, null, null, null]]);
    assert.deepEqual(run({ behavior: [b('WAKE', { reasons: ['OVERSLEPT'] })] }).s.sleep_wake.map((w) => [w.overslept, w.wake_delay_minutes]), [[true, null]]); // "늦잠 잤어"만
  });

  it('"오늘 10분 지각했어"(일정 이름 없음) → 임의로 잇지 않고 기록은 남김 (behavior · schedule_outcomes 둘 다, 확인 필요)', () => {
    const { s } = run({ behavior: [b('LATE', { minutes: 10 })] });
    assert.deepEqual(s.behavior.map((x) => [x.id, x.kind, x.minutes, x.status, x.issue, x.appointment]), [['b1', 'late', 10, 'needs_confirm', 'unlinked', { appointment_id: null, title: null, link: 'unlinked' }]]);
    assert.deepEqual(s.schedule_outcomes.map((o) => [o.date, o.appointment_id, o.is_late, o.late_minutes, o.status, o.behavior_refs]), [[REVIEW, null, true, 10, 'needs_confirm', ['b1']]]);
    assert.deepEqual(s.pending.map((p) => [p.section, p.ref, p.reason]), [['behavior', 'b1', 'unlinked']]);
  });

  it('여러 일정에 맞는 이름 · 없는 a# · 다른 날 일정은 잇지 않음, 이름 하나에만 맞으면 연결', () => {
    const { s } = run({
      behavior: [
        b('LATE', { minutes: 5, appointment_title: '회의' }), // 팀플 회의 하나
        b('LATE', { minutes: 7, appointment_ref: 'a9' }),
        b('LATE', { minutes: 3, appointment_title: '수업', date: YESTERDAY }),
      ],
    });
    assert.deepEqual(s.schedule_outcomes.map((o) => [o.date, o.appointment_id, o.appointment_title, o.link, o.late_minutes]), [
      [REVIEW, 'ap-team', '팀플 회의', 'linked', 5], [REVIEW, null, null, 'unlinked', 7], [YESTERDAY, null, '수업', 'unlinked', 3],
    ]);
  });

  it('출발 · 도착 진술은 JSON에만 (같은 일정 결과에 묶임), 제시간(0분)은 is_late false', () => {
    const { s, plan } = run({ behavior: [b('DEPART', { time: '09:20', appointment_ref: 'a1' }), b('ARRIVE', { time: '09:58', appointment_ref: 'a1' }), b('LATE', { minutes: 0, appointment_ref: 'a1' })] });
    assert.deepEqual(s.schedule_outcomes.map((o) => [o.appointment_id, o.is_late, o.late_minutes, o.departed_at, o.arrived_at, o.behavior_refs]), [
      ['ap-class', false, 0, '2026-10-29T09:20:00+09:00', '2026-10-29T09:58:00+09:00', ['b1', 'b2', 'b3']],
    ]);
    assert.deepEqual(plan.records, []);
  });

  it('미루기 횟수 · 준비 시작 · 전체 준비 시간은 behavior에 각자의 종류로', () => {
    const { s } = run({ behavior: [b('SNOOZE', { minutes: 3 }), b('PREP_START', { time: '08:30' }), b('PREP_DURATION', { minutes: 50 })] });
    assert.deepEqual(s.behavior.map((x) => [x.kind, x.time, x.minutes, x.at]), [['snooze', null, 3, null], ['prep_start', '08:30', null, '2026-10-29T08:30:00+09:00'], ['prep_duration', null, 50, null]]);
  });
});

describe('정정 · 엇갈림 · 날짜', () => {
  it('고친 말은 모델이 마지막 값 한 줄만 냄 → 그대로 기록 / 같은 날 같은 대상에 다른 값이 둘이면 엇갈린 진술로 둘 다 확인 필요', () => {
    assert.deepEqual(run({ behavior: [b('WAKE', { time: '08:20' })] }).s.sleep_wake[0].wake_at, '2026-10-29T08:20:00+09:00');
    const { s } = run({ behavior: [b('WAKE', { time: '08:10' }), b('WAKE', { time: '08:40' }), b('LATE', { minutes: 5, appointment_ref: 'a1' }), b('LATE', { minutes: 15, appointment_ref: 'a1' })] });
    assert.deepEqual(s.behavior.map((x) => x.issue), ['conflict', 'conflict', 'conflict', 'conflict']);
    assert.deepEqual(s.sleep_wake, []); // 엇갈린 값으로 보기를 만들지 않음
    assert.deepEqual(s.schedule_outcomes.map((o) => [o.late_minutes, o.status]), [[null, 'needs_confirm']]);
  });

  it('애매하다고 표시한 진술 · 날짜 모르는 진술은 지우지 않고 확인 필요', () => {
    const { s } = run({ behavior: [b('PREP_OVER', { minutes: 20, uncertain: '어제인지 오늘인지 섞여 말함' }), b('SNOOZE', { minutes: 2, date: null })] });
    assert.deepEqual(s.behavior.map((x) => [x.status, x.issue, x.note]), [['needs_confirm', 'uncertain', '어제인지 오늘인지 섞여 말함'], ['needs_confirm', 'no_date', null]]);
    assert.equal(s.pending.length, 2);
  });

  it('날짜가 다른 생활 기록: 어제 밤 23:30 취침은 오늘 아침 기록, 새벽 1:30도 오늘 기록, 그제 기상은 그제 기록 — 날짜별로 따로', () => {
    const { s, plan } = run({
      behavior: [b('SLEEP', { date: YESTERDAY, time: '23:30' }), b('WAKE', { time: '07:40' }), b('WAKE', { date: '2026-10-27', time: '09:00' })],
      daily_record: { sleep_time: '00:30', sleep_satisfaction: 2, condition_note: '조금 피곤함' },
    });
    assert.deepEqual(s.sleep_wake.map((w) => [w.date, w.sleep_at, w.wake_at, w.sleep_satisfaction, w.planned_sleep_at]), [
      ['2026-10-27', null, '2026-10-27T09:00:00+09:00', null, null],
      [REVIEW, '2026-10-28T23:30:00+09:00', '2026-10-29T07:40:00+09:00', 2, '2026-10-30T00:30:00+09:00'],
    ]);
    assert.deepEqual(plan.records, [{ record_date: REVIEW, values: { sleep_at: '2026-10-28T23:30:00+09:00', sleep_satisfaction: 2, condition_note: '조금 피곤함' } }]);
    assert.equal(run({ behavior: [b('SLEEP', { time: '01:30' })] }).s.sleep_wake[0].date, REVIEW);
  });

  it('짐작(inferred)한 취침은 JSON에만, 표에는 확인된 진술만', () => {
    const { s, plan } = run({ behavior: [b('SLEEP', { date: YESTERDAY, time: '23:00', source: 'inferred' })] });
    assert.equal(s.sleep_wake[0].source, 'inferred');
    assert.deepEqual(plan.records, []);
  });
});

describe('기분 · 습관 · 목표 · 알람 평가 · 돌아보기', () => {
  it('"발표를 잘 마쳐서 뿌듯했어. 그런데 너무 피곤해" → 활동 · 기분 · 원인, 피로 점수는 지어내지 않음(null)', () => {
    const { s } = run({
      day_review: { events: [{ text: '발표를 잘 마침', time: null, important: false, source: 'stated' }], memorable: '발표를 잘 마침' },
      mood_condition: { mood: ['good', 'tired'], valence: 1, fatigue: null, stress: null, causes: ['발표를 잘 마쳐서 뿌듯함'], source: 'stated' },
    });
    assert.deepEqual(s.day_review.events.map((e) => e.text), ['발표를 잘 마침']);
    assert.deepEqual([s.mood_condition.mood, s.mood_condition.fatigue, s.mood_condition.valence_source, s.mood_condition.causes], [['good', 'tired'], null, 'inferred', ['발표를 잘 마쳐서 뿌듯함']]);
  });

  it('습관: 반복이라고 말한 것(recurring)과 하루 일을 구분해 그대로 — 서버가 반복을 판정하지 않음', () => {
    const { s } = run({
      habit_signals: [
        { habit: 'phone_in_bed', note: '요즘 자기 전에 휴대폰을 오래 봄', date: null, recurring: true, source: 'stated' },
        { habit: 'snooze_repeat', note: '이번 주 알람 세 번 미룸', date: null, recurring: true, source: 'stated' },
        { habit: 'slow_prep', note: '오늘 준비가 늦어짐', date: REVIEW, recurring: false, source: 'stated' },
        { habit: 'other', note: '  ', date: null, recurring: false, source: 'stated' },
      ],
    });
    assert.deepEqual(s.habit_signals.map((h) => [h.habit, h.recurring, h.date]), [['phone_in_bed', true, null], ['snooze_repeat', true, null], ['slow_prep', false, REVIEW]]);
    assert.deepEqual(s.behavior, []); // 특정한 날이 아닌 미루기는 behavior에 없음
  });

  it('목표 · 원하는 루틴 저장, 이전 제안 답(suggestion_response)은 아직 늘 null', () => {
    const { s } = run({ goals_routine: { goals: [{ habit: 'late_bedtime', goal_text: '12시 전에 자기', source: 'stated' }], wanted_routine: '아침 20분 운동' } });
    assert.deepEqual(s.goals_routine, { goals: [{ habit: 'late_bedtime', goal_text: '12시 전에 자기', source: 'stated' }], wanted_routine: '아침 20분 운동', suggestion_response: null });
  });

  it('알람 평가: 효과 그대로 + DB 평가 값 대응(없으면 null) — 확인 필요 목록 · 저장 대상 아님', () => {
    const { s, plan } = run({
      alarm_feedback: [
        { effect: 'too_weak', alarm_type: 'WAKE', date: REVIEW, note: '소리가 작아서 못 들음', source: 'stated' },
        { effect: 'missed', alarm_type: 'WAKE', date: REVIEW, note: '소리가 작아서 못 들음', source: 'stated' },
        { effect: 'helpful', alarm_type: null, date: REVIEW, note: '괜찮았음', source: 'stated' },
        { effect: 'wrong_time', alarm_type: null, date: null, note: '너무 일찍 울림', source: 'stated' },
      ],
    });
    assert.deepEqual(s.alarm_feedback.map((f) => [f.effect, f.db_feedback_type]), [['too_weak', 'TOO_QUIET'], ['missed', null], ['helpful', 'GOOD'], ['wrong_time', null]]);
    assert.deepEqual([s.pending, plan.records], [[], []]);
  });

  it('위험 표시면 컨디션 · 돌아보기 글을 남기지 않음', () => {
    const { s, plan } = run({
      safety_flag: true,
      daily_record: { sleep_time: null, sleep_satisfaction: null, condition_note: '다 싫어' },
      day_review: { events: [{ text: '힘든 일', time: null, important: true, source: 'stated' }], memorable: '힘든 일' },
      mood_condition: { mood: ['sad'], valence: -2, fatigue: null, stress: null, causes: ['힘든 일'], source: 'stated' },
    });
    assert.deepEqual([s.day_review.events, s.day_review.memorable, s.mood_condition.causes, s.mood_condition.condition_note, s.other.safety_flag], [[], null, [], null, true]);
    assert.deepEqual(plan.records, []);
  });

  it('말하지 않은 정보는 만들지 않음 — 빈 출력이면 공개 JSON도 모두 비어 있음', () => {
    const { s, plan } = run({});
    assert.deepEqual([s.behavior, s.sleep_wake, s.schedule_outcomes, s.habit_signals, s.alarm_feedback, s.appointments, s.todos, s.pending, s.day_review.events], [[], [], [], [], [], [], [], [], []]);
    assert.deepEqual([s.mood_condition.mood, s.mood_condition.valence, s.mood_condition.fatigue, s.goals_routine.wanted_routine], [[], null, null, null]);
    assert.deepEqual([plan.todos, plan.records], [[], []]);
  });
});

describe('일정 · 할 일 (기존 카드 흐름과 같이)', () => {
  const appt = (title: string, over: Partial<FinalExtract['appointments'][number]> = {}) => ({
    ref: null, title, date: TOMORROW, time: '14:00', place: null, importance: null, transport: null, repeat: 'NONE' as const, save: 'UNCONFIRMED' as const, unclear: null, ...over,
  });
  const todo = (title: string, over: Partial<FinalExtract['todos'][number]> = {}) => ({ title, type: 'ITEM' as const, due_date: null, appointment_ref: null, appointment_title: null, ...over });

  it('"내일 2시 학교에서 팀플 회의, 노트북 챙겨야 해" → 일정(이름 · 날짜 · 시각 · 장소)과 준비물, 카드 저장이면 그 약속에 연결', () => {
    const { s, plan } = run(
      { appointments: [appt('팀플 회의', { place: '학교' })], todos: [todo('노트북', { appointment_title: '팀플 회의' })] },
      [card('c1', '팀플 회의', 'SAVED', 'ap-new')],
    );
    assert.deepEqual(s.appointments.map((a) => [a.title, a.date, a.time, a.place, a.status, a.card_id, a.appointment_id]), [['팀플 회의', TOMORROW, '14:00', '학교', 'saved', 'c1', 'ap-new']]);
    assert.deepEqual(plan.todos, [{ title: '노트북', todo_type: 'ITEM', due_date: null, appointment_id: 'ap-new' }]);
  });

  it('카드 거절 · 말로 거절 = declined, 날짜 모름 · 카드 없음 = needs_confirm / 거절한 일정의 준비물은 연결 없이 남김(D32 A) / 같은 대화 안 겹침은 duplicate', () => {
    const { s, plan } = run(
      {
        appointments: [appt('동아리'), appt('영화', { save: 'DECLINED' }), appt('산책', { date: null, time: null, unclear: "'산책'의 날짜를 모름" })],
        todos: [todo('회비', { appointment_title: '동아리' }), todo('발표 자료', { appointment_ref: 'a2', type: 'TASK' }), todo('우산', { due_date: TOMORROW }), todo('우산 챙기기', { due_date: TOMORROW })],
      },
      [card('c1', '동아리', 'REJECTED')],
    );
    assert.deepEqual(s.appointments.map((a) => a.status), ['declined', 'declined', 'needs_confirm']);
    assert.deepEqual(s.pending.map((p) => p.text), ["일정 확인 필요: 산책 ('산책'의 날짜를 모름)"]);
    assert.deepEqual(plan.todos.map((t) => [t.title, t.appointment_id]), [['회비', null], ['발표 자료', 'ap-team'], ['우산', null]]);
    assert.deepEqual(s.todos.map((t) => [t.title, t.stored]), [['회비', 'inserted'], ['발표 자료', 'inserted'], ['우산', 'inserted'], ['우산 챙기기', 'duplicate']]);
  });

  it('알람 변경 · 준비시간은 카드 없으면 확인 필요', () => {
    const { s } = run({
      alarm_changes: [{ target: 'u0', appointment_ref: 'a1', type: 'WAKE', date: TOMORROW, time: '07:00', intensity: null, enabled: null, save: 'CONFIRMED' }],
      prep_adjustment: { direction: 'MORE', minutes: 10 },
    });
    assert.deepEqual([s.alarm_changes[0].status, s.prep_adjustment?.status], ['needs_confirm', 'needs_confirm']);
  });

  it('isDuplicateTodo: 같은 키 + 같은 약속 / 약속 없으면 같은 날짜 또는 이 대화가 만든 것', () => {
    const t = { title: '우산 챙기기', todo_type: 'ITEM' as const, due_date: TOMORROW, appointment_id: null };
    assert.equal(isDuplicateTodo(t, [{ title: '우산', appointment_id: null, due_date: TOMORROW, source_session_id: 'old' }], 's1'), true);
    assert.equal(isDuplicateTodo(t, [{ title: '우산', appointment_id: null, due_date: '2026-11-02', source_session_id: 'old' }], 's1'), false);
    assert.equal(isDuplicateTodo(t, [{ title: '우산', appointment_id: null, due_date: null, source_session_id: 's1' }], 's1'), true);
    assert.equal(isDuplicateTodo({ ...t, appointment_id: 'ap-new' }, [{ title: '우산', appointment_id: 'ap-new', due_date: null, source_session_id: null }], 's1'), true);
  });
});

describe('계약 · 스키마', () => {
  it('보기(sleep_wake · schedule_outcomes)의 값은 가리키는 behavior 줄의 값과 같음 — 한 값이 두 자리에서 어긋나지 않음', () => {
    const { s } = run({ behavior: [b('SLEEP', { date: YESTERDAY, time: '23:30' }), b('WAKE', { time: '08:15' }), b('LATE', { minutes: 10, appointment_ref: 'a1', reasons: ['OVERSLEPT'] })] });
    const at = (id: string) => s.behavior.find((x) => x.id === id)!;
    for (const w of s.sleep_wake) {
      for (const id of w.behavior_refs) {
        const x = at(id);
        if (x.kind === 'sleep') assert.equal(w.sleep_at, x.at);
        if (x.kind === 'wake') assert.equal(w.wake_at, x.at);
      }
    }
    for (const o of s.schedule_outcomes) assert.deepEqual([o.late_minutes, o.causes], [at(o.behavior_refs[0]).minutes, at(o.behavior_refs[0]).reasons]);
    assert.deepEqual(s.schedule_outcomes[0].causes, ['overslept']);
  });

  it('structured.v1 검사: 틀린 모양은 걸림', () => {
    const { s } = run({ behavior: [b('LATE', { minutes: 10 })] });
    assert.notDeepEqual(structuredProblems({ ...s, schema_version: 'structured.v0' }), []);
    assert.notDeepEqual(structuredProblems({ ...s, behavior: [{ ...s.behavior[0], source: 'guess' }] }), []);
    assert.notDeepEqual(structuredProblems({ ...s, session: { ...s.session, input_modes: ['live'] } }), []);
  });

  it('extract.v2(모델 출력): 새 칸이 빠지거나 없는 종류 · 범위 밖 점수 · 출처면 실패, v1은 새 칸을 모름', () => {
    const sch = schemaOf('extract.v2');
    assert.deepEqual(validate(sch, emptyExtract()), { valid: true, errors: [] });
    const { behavior: _drop, ...noBehavior } = emptyExtract();
    assert.equal(validate(sch, noBehavior).valid, false);
    assert.equal(validate(sch, emptyExtract({ behavior: [b('NAP' as BehaviorReport['kind'])] })).valid, false);
    assert.equal(validate(sch, emptyExtract({ behavior: [b('LATE', { minutes: -5 })] })).valid, false);
    assert.equal(validate(sch, emptyExtract({ behavior: [b('LATE', { source: 'guess' as never })] })).valid, false);
    assert.equal(validate(sch, emptyExtract({ mood_condition: { mood: [], valence: null, fatigue: 9, stress: null, causes: [], source: 'stated' } })).valid, false);
    assert.equal(validate(schemaOf('extract.v1'), emptyExtract()).valid, false);
  });
});

describe('상대 날짜 — 기준일(돌아볼 날)과 사건 날짜가 다를 때 (모델이 날짜표의 오늘에서 센 date를 그대로 씀)', () => {
  // 11/5 밤 대화: 날짜표 '오늘' = 11/5, '어제' = 11/4
  const D5 = '2026-11-05';
  const D4 = '2026-11-04';
  const ctx5 = { session: { record_date: D5 }, today: { appointments: [{ ref: 'a1', title: '캡스톤 수업', date: D5, time: '09:00' }], alarms: [] } } as unknown as Context;
  const refs5: RefsOut = { appointments: { a1: { appointment_id: 'ap-c5', participant_id: 'pt-c5' } }, alarms: {}, facts: {} };
  const go = (behavior: BehaviorReport[]) => {
    const plan = applyFinal(emptyExtract({ behavior }), ctx5, refs5, []);
    return { plan, s: publish(plan) };
  };

  it('"오늘 새벽 1시 반에 잤어" → 11/5 01:30, 11/5 기록', () => {
    const { s, plan } = go([b('SLEEP', { date: D5, time: '01:30' })]);
    assert.deepEqual(s.sleep_wake.map((w) => [w.date, w.sleep_at]), [[D5, '2026-11-05T01:30:00+09:00']]);
    assert.deepEqual(plan.records.map((r) => [r.record_date, r.values.sleep_at]), [[D5, '2026-11-05T01:30:00+09:00']]);
  });

  it('"어제 새벽 1시 반에 잤어"(말 그대로) → 11/4 01:30, 11/4 기록 — 기준일 11/5로 옮기지 않음', () => {
    const { s, plan } = go([b('SLEEP', { date: D4, time: '01:30' })]);
    assert.deepEqual(s.behavior.map((x) => [x.date, x.at, x.status]), [[D4, '2026-11-04T01:30:00+09:00', 'recorded']]);
    assert.deepEqual(s.sleep_wake.map((w) => [w.date, w.sleep_at]), [[D4, '2026-11-04T01:30:00+09:00']]);
    assert.deepEqual(plan.records.map((r) => r.record_date), [D4]);
  });

  it('"어제 새벽 1시 반까지 유튜브 보다가 8시 10분에 일어났어" → 어젯밤일 수 있어 취침은 확인 필요(표에 안 씀), 오늘 기상만 기록', () => {
    const { s, plan } = go([b('SLEEP', { date: D4, time: '01:30', uncertain: "'어제 새벽'이 오늘 새벽(어젯밤)일 수 있음" }), b('WAKE', { date: D5, time: '08:10' })]);
    assert.deepEqual(s.behavior.map((x) => [x.kind, x.date, x.status, x.issue]), [['sleep', D4, 'needs_confirm', 'uncertain'], ['wake', D5, 'recorded', null]]);
    assert.deepEqual(s.sleep_wake.map((w) => [w.date, w.sleep_at, w.wake_at]), [[D5, null, '2026-11-05T08:10:00+09:00']]);
    assert.deepEqual(plan.records, []);
    assert.deepEqual(s.pending.map((p) => p.ref), ['b1']);
  });

  it('하루 전 사건 회고 "어제 수업에 10분 늦었어" → 11/4 지각으로 남고, 기준일(11/5) 수업에 잇지 않음', () => {
    const { s } = go([b('LATE', { date: D4, minutes: 10, appointment_title: '수업' })]);
    assert.deepEqual(s.schedule_outcomes.map((o) => [o.date, o.appointment_id, o.appointment_title, o.late_minutes, o.status]), [[D4, null, '수업', 10, 'needs_confirm']]);
  });
});
