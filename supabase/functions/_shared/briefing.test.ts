// 알람 음성 브리핑 순수 함수 — 중요도 기본값 · 수동 설정 · 지각 위험 · 단계 · 엔진 · Gemini 필요 판단 · 브리핑 문장 · 캐시 열쇠
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  androidVoice,
  briefingClips,
  briefingText,
  cleanPrefs,
  clipHash,
  engineFor,
  lateRisk,
  levelAt,
  levelsToPrepare,
  needsGemini,
  pickAppointments,
  resolveVoice,
  slackMinutes,
  speechLevel,
  urgencyRule,
  urgentAtMs,
  wakeMemo,
  type BriefAppointment,
  type BriefingInput,
  type SlackInput,
  type StructuredLike,
  type UrgencyRule,
} from './briefing.ts';
import { resolveIntensity, vibrationOf } from './calc/intensity.ts';

const TZ = 'Asia/Seoul';
// 2026-11-11 한국 시각 h시 m분
const kst = (h: number, m = 0) => Date.UTC(2026, 10, 11, h - 9, m);
const MIN = 60_000;

// --- 중요도 · 수동 설정 ---
test('중요도 약 · 중간 · 중요 → 목소리 · 말투 기본값, 긴급 상한 기본 4', () => {
  assert.deepEqual([resolveVoice('LOW').voice, resolveVoice('LOW').tone], ['Sulafat', 'GENTLE']);
  assert.deepEqual([resolveVoice('NORMAL').voice, resolveVoice('NORMAL').tone], ['Zephyr', 'NORMAL']);
  assert.deepEqual([resolveVoice('HIGH').voice, resolveVoice('HIGH').tone], ['Kore', 'FIRM']);
  assert.equal(resolveVoice('LOW').coachMax, 4);
});

test('사용자 수동 설정 > 기본값, 칸을 지우면 기본값 · 모르는 값은 버림', () => {
  const p = resolveVoice('HIGH', { voice: 'Sulafat', tone: 'GENTLE', escalate: false });
  assert.deepEqual([p.voice, p.tone, p.escalate], ['Sulafat', 'GENTLE', false]);
  assert.deepEqual(p.manual, { voice: true, tone: true });
  assert.equal(resolveVoice('HIGH', {}).voice, 'Kore');
  assert.deepEqual(cleanPrefs({ voice: 'Nope', tone: 'LOUD', coachMax: 9, hack: 1, personal: false }), { personal: false });
});

test('배경음 · 진동 · 볼륨은 기존 알람 축 그대로 (D69) — 중요도 HIGH여도 사용자가 끈 진동은 꺼짐', () => {
  const r = resolveIntensity('HIGH', 5, { vibration: 0 });
  assert.equal(r.fields.vibration, 'NONE');
  assert.equal(vibrationOf(r.fields.vibration, r.fields.intensity), 'NONE');
  assert.equal(resolveIntensity('LOW', 0).fields.intensity, 'NORMAL'); // LOW도 기본 세기 보통 (D69)
  assert.equal('vibration' in resolveVoice('HIGH'), false);
});

// --- 지각 위험 ---
const wake = (over: Partial<SlackInput> = {}): SlackInput => ({ kind: 'WAKE', appointmentAtMs: kst(10), prepMinutes: 50, travelMinutes: 40, ...over });
const depart = (over: Partial<SlackInput> = {}): SlackInput => ({ kind: 'DEPARTURE', appointmentAtMs: kst(10), prepMinutes: 50, travelMinutes: 40, ...over });

test('기상 여유 = 약속 − 지금 − 준비 − 이동, 출발 여유 = 약속 − 지금 − 이동 (기존 departSlack 재사용)', () => {
  assert.equal(slackMinutes(wake(), kst(8)), 120 - 50 - 40);
  assert.equal(slackMinutes(depart(), kst(9)), 60 - 40);
});

test('경계: 30 초과 여유 · 15 초과 주의 · 5 초과 위험 · 5 이하 긴급', () => {
  const at = (slack: number) => lateRisk(slackMinutes(depart(), kst(10) - (40 + slack) * MIN));
  assert.deepEqual([31, 30, 16, 15, 6, 5, 0, -3].map(at), ['SAFE', 'CAUTION', 'CAUTION', 'DANGER', 'DANGER', 'URGENT', 'URGENT', 'URGENT']);
});

test('준비 · 이동을 모르면 UNKNOWN (단정하지 않음), 이미 출발했으면 DONE', () => {
  assert.equal(lateRisk(slackMinutes(wake({ prepMinutes: null }), kst(9, 50))), 'UNKNOWN');
  assert.equal(lateRisk(slackMinutes(wake({ travelMinutes: null }), kst(9, 50))), 'UNKNOWN');
  assert.equal(lateRisk(slackMinutes(depart({ prepMinutes: null }), kst(9, 50))), 'URGENT'); // 출발은 준비가 필요 없음
  assert.equal(lateRisk(slackMinutes(wake({ appointmentAtMs: null }), kst(8))), 'UNKNOWN');
  assert.equal(lateRisk(0, true), 'DONE');
  assert.equal(urgentAtMs(wake({ prepMinutes: null })), null);
});

// --- 단계 ---
test('처음 1 · 미루기 1번 2 · 2번 이상 3 — 미루기만으로는 4가 안 됨', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map((n) => speechLevel(n, 'SAFE', 4)), [1, 2, 3, 3, 3]);
  assert.deepEqual([0, 3].map((n) => speechLevel(n, 'UNKNOWN', 4)), [1, 3]);
  assert.equal(speechLevel(3, 'DANGER', 4), 3);
});

test('실제 긴급이면 미루기 없이도 4 · LOW와 HIGH 모두 여유 5분 이하면 긴급', () => {
  assert.equal(speechLevel(0, 'URGENT', 4), 4);
  for (const importance of ['LOW', 'HIGH'] as const) {
    const rule = urgencyRule(wake(), resolveVoice(importance));
    const now = kst(10) - (90 + 5) * MIN; // 여유 정확히 5분
    assert.equal(lateRisk(slackMinutes(wake(), now)), 'URGENT');
    assert.equal(levelAt(rule, 0, now), 4, importance);
  }
});

test('사용자 상한 · 자동 강화 끔을 넘지 않음', () => {
  assert.equal(speechLevel(0, 'URGENT', 3), 3);
  assert.equal(speechLevel(3, 'URGENT', 1), 1);
  assert.equal(urgencyRule(wake(), { coachMax: 4, escalate: false }).maxLevel, 1);
});

test('미리 계산한 긴급 시각(urgentAtMs) 비교 = 지각 위험 계산 그대로 (네이티브가 쓰는 식) — 1분 · 30초 간격으로 모두 같음', () => {
  for (const s of [wake(), depart(), wake({ prepMinutes: 0, travelMinutes: 7 })]) {
    const rule = { urgentAtMs: urgentAtMs(s), maxLevel: 4 as const };
    for (let t = kst(7); t <= kst(10, 5); t += 30_000) {
      for (const snooze of [0, 1, 2, 3]) {
        assert.equal(levelAt(rule, snooze, t), speechLevel(snooze, lateRisk(slackMinutes(s, t)), 4), `${s.kind} ${new Date(t).toISOString()} ${snooze}`);
      }
    }
  }
});

test('TS · Kotlin 같은 표 (spec/urgency-cases.json — 네이티브는 SpeechUrgencyTest가 같은 표로 확인)', () => {
  const cases = JSON.parse(readFileSync(new URL('../../../mobile/modules/alarm-core/spec/urgency-cases.json', import.meta.url), 'utf8')) as {
    name: string; snoozeCount: number; nowMs: number; urgentAtMs: number | null; maxLevel: 1 | 2 | 3 | 4; expected: number;
  }[];
  assert.ok(cases.length >= 10);
  for (const c of cases) assert.equal(levelAt({ urgentAtMs: c.urgentAtMs, maxLevel: c.maxLevel }, c.snoozeCount, c.nowMs), c.expected, c.name);
});

// --- 엔진 · Gemini 필요 판단 ---
test('엔진: 1~3단계 Android TTS, 4단계는 Gemini 음성이 있을 때만 (없으면 Android로 전체)', () => {
  assert.deepEqual(([1, 2, 3] as const).map((l) => engineFor(l, true)), ['ANDROID', 'ANDROID', 'ANDROID']);
  assert.equal(engineFor(4, true), 'GEMINI');
  assert.equal(engineFor(4, false), 'ANDROID');
  // 중요도 HIGH라도 긴급이 아니면 Android
  assert.equal(engineFor(levelAt(urgencyRule(wake(), resolveVoice('HIGH')), 2, kst(7)), true), 'ANDROID');
});

test('스누즈 3번이어도 여유 40분이면 긴급 아님 → Gemini 미사용 · 미리 만들지도 않음', () => {
  const s = wake();
  const now = kst(10) - (90 + 40) * MIN;
  const rule = urgencyRule(s, resolveVoice('LOW'));
  assert.equal(levelAt(rule, 3, now), 3);
  assert.equal(engineFor(levelAt(rule, 3, now), true), 'ANDROID');
  assert.equal(needsGemini(rule, 'WAKE', kst(6)), false); // 6시 알람 · 긴급 시각 8:24 — 미루기 창(60분) 밖
});

test('Gemini는 이 알람이 울리는 동안 실제로 긴급이 될 수 있을 때만 미리 만듦', () => {
  const rule = urgencyRule(wake(), resolveVoice('LOW')); // 긴급 시각 = 10시 − 95.5분 = 8:24:30
  assert.equal(needsGemini(rule, 'WAKE', kst(7, 30)), true); // 미루다 보면 긴급
  assert.equal(needsGemini(rule, 'WAKE', kst(7, 20)), false);
  const d = urgencyRule(depart(), resolveVoice('LOW')); // 긴급 시각 9:14:30
  assert.equal(needsGemini(d, 'DEPARTURE', kst(9, 10)), false); // 출발 알람 9:10 — 여유 10분(위험)이지 긴급 아님
  assert.equal(needsGemini(d, 'DEPARTURE', kst(9, 15)), true);
  assert.equal(needsGemini({ ...d, maxLevel: 3 }, 'DEPARTURE', kst(9, 15)), false); // 상한 3 → Gemini 안 씀
  assert.equal(needsGemini(urgencyRule(wake({ travelMinutes: null }), resolveVoice('LOW')), 'WAKE', kst(9)), false); // UNKNOWN
});

test('Android TTS: 중요도(말투) · 단계마다 높낮이 · 속도 · 목소리가 달라짐', () => {
  const low = androidVoice(resolveVoice('LOW'), 1);
  const high = androidVoice(resolveVoice('HIGH'), 1);
  assert.ok(low.rate < high.rate && low.pitch < high.pitch);
  assert.notEqual(low.voiceIndex, high.voiceIndex);
  const rates = ([1, 2, 3, 4] as const).map((l) => androidVoice(resolveVoice('NORMAL'), l).rate);
  assert.deepEqual(rates, [...rates].sort((a, b) => a - b));
  assert.equal(new Set(rates).size, 4);
});

// --- 전날 다짐 ---
const session = (over: Partial<StructuredLike> = {}): StructuredLike => ({ schema_version: 'structured.v1', session: { reference_date: '2026-11-10' }, other: { safety_flag: false }, ...over });

test('전날 "늦잠 자서 지각 · 일찍 일어나고 싶어" → 다짐 · 반성, 없거나 짐작이면 null', () => {
  const s = session({
    goals_routine: { goals: [{ habit: 'irregular_wake', goal_text: '일찍 일어나기', source: 'stated' }] },
    schedule_outcomes: [{ is_late: true, causes: ['overslept'], source: 'stated' }],
  });
  assert.deepEqual(wakeMemo([s], '2026-11-10'), { wakeEarly: true, overslept: true, lateByOversleep: true, goals: [] });
  assert.equal(wakeMemo([], '2026-11-10'), null);
  assert.equal(wakeMemo([session({ goals_routine: { goals: [{ habit: 'irregular_wake', goal_text: '일찍', source: 'inferred' }] } })], '2026-11-10'), null);
  assert.equal(wakeMemo([{ ...s, other: { safety_flag: true } }], '2026-11-10'), null);
});

// --- 브리핑 문장 ---
const appt = (title: string, h: number, importance: BriefAppointment['importance'] = 'NORMAL'): BriefAppointment => ({ title, atMs: kst(h), importance });
const input = (over: Partial<BriefingInput> = {}): BriefingInput => ({ kind: 'WAKE', memo: null, appointments: [], todos: [], departAtMs: null, timeZone: TZ, ...over });

test('기상 브리핑: 다짐 + 오늘 일정 시간순 (0 · 1 · 여러 개), 할 일에 시각을 안 붙임', () => {
  assert.match(briefingText(1, input()), /오늘은 등록된 일정이 없어\./);
  assert.match(briefingText(1, input({ appointments: [appt('팀플 회의', 15)] })), /오늘은 오후 3시 팀플 회의 일정이 있어\./);
  const memo = { wakeEarly: true, overslept: false, lateByOversleep: false, goals: [] };
  assert.equal(
    briefingText(1, input({ memo, appointments: pickAppointments([appt('과제', 19), appt('팀플 회의', 15), appt('저녁 약속', 17)]) })),
    '좋은 아침이야~ 어제 오늘부터는 일찍 일어나겠다고 했잖아. 오늘은 오후 3시 팀플 회의, 오후 5시 저녁 약속, 오후 7시 과제 순서로 일정이 있어. 슬슬 일어나서 준비해 볼까?',
  );
  const t = briefingText(1, input({ appointments: [appt('수업', 10)], todos: [{ title: '노트북', type: 'ITEM' }, { title: '과제 제출', type: 'TASK' }] }));
  assert.equal((t.match(/(오전|오후) \d+시/g) ?? []).length, 1);
});

test('많으면 가장 가까운 일정 + 중요한 일정 우선', () => {
  assert.deepEqual(pickAppointments([appt('E', 20), appt('D', 18, 'HIGH'), appt('A', 9), appt('C', 14), appt('B', 11)]).map((a) => a.title), ['A', 'B', 'D']);
});

test('기상 2 · 3단계는 "미뤘다" · "늦는다"를 단정하지 않음, 4단계(실제 긴급)만 "늦어"', () => {
  for (const level of [1, 2, 3] as const) assert.doesNotMatch(briefingText(level, input({ appointments: [appt('수업', 10)] })), /늦어|늦는다|미뤘/);
  const t = briefingText(4, input({ memo: { wakeEarly: true, overslept: true, lateByOversleep: true, goals: [] }, appointments: [appt('팀플 회의', 15), appt('저녁 약속', 17), appt('과제', 19)] }));
  assert.ok(t.startsWith('야!!!!!!!!!! 지금 안 일어나면 진짜 늦어!!!!'));
  assert.match(t, /너 어제 일찍 일어나고 싶다며/);
  assert.doesNotMatch(t, /과제/); // 긴급은 핵심 일정 2개만
});

test('출발 브리핑: 그 일정 시각 + 등록된 준비물 + 출발 촉구 (전날 대화 · 다른 일정은 안 넣음)', () => {
  const d = (level: 1 | 4, todos: BriefingInput['todos'] = [{ title: '노트북', type: 'ITEM' }, { title: '충전기', type: 'ITEM' }]) =>
    briefingText(level, input({ kind: 'DEPARTURE', appointments: [appt('면접', 10, 'HIGH')], todos, memo: { wakeEarly: true, overslept: false, lateByOversleep: false, goals: [] } }));
  assert.equal(d(1), '오전 10시 면접 갈 시간이야. 챙길 것: 노트북, 충전기. 이제 출발하자!');
  assert.equal(d(4), '야!!!!!!!! 지금 당장 나가!!!! 이러다 면접 늦는다고!!!! 노트북, 충전기 챙기고 바로 출발해!!!!!!!');
  assert.doesNotMatch(d(1, []), /챙길 것/); // 준비물이 없으면 안 만듦
  assert.doesNotMatch(d(1), /어제/);
});

// --- 캐시 열쇠 ---
test('단계 · 열쇠: 상한까지 문장, 일정이 바뀌면 열쇠가 바뀜', () => {
  const rule: UrgencyRule = { urgentAtMs: null, maxLevel: 4 };
  const prof = { voice: 'Kore', tone: 'FIRM' as const };
  const a = briefingClips(rule, prof, input({ appointments: [appt('회의', 15)] }));
  const b = briefingClips(rule, prof, input({ appointments: [appt('회의', 16)] }));
  assert.deepEqual(a.map((c) => c.level), [1, 2, 3, 4]);
  assert.ok(a.every((c, i) => c.hash !== b[i].hash));
  assert.deepEqual(levelsToPrepare({ urgentAtMs: null, maxLevel: 2 }), [1, 2]);
  assert.match(clipHash({ text: 'x', voice: 'v', style: 's', model: 'm' }), /^[0-9a-f]{16}$/);
});
