// 기상 AI 음성 브리핑 순수 함수 — 중요도 기본값 · 수동 설정 우선 · 긴급도 · 전날 다짐 · 일정 브리핑 · 캐시 열쇠
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  briefingClips,
  briefingText,
  cleanPrefs,
  clipHash,
  levelsToPrepare,
  pickAppointments,
  resolveVoice,
  speechStyle,
  urgencyLevel,
  urgencyRule,
  wakeMemo,
  TONES,
  URGENCY_STYLE,
  type BriefAppointment,
  type BriefingInput,
  type StructuredLike,
  type UrgencyRule,
} from './briefing.ts';
import { resolveIntensity, vibrationOf } from './calc/intensity.ts';

const TZ = 'Asia/Seoul';
// 2026-11-11 한국 시각 h시 m분
const kst = (h: number, m = 0) => Date.UTC(2026, 10, 11, h - 9, m);

// --- 1 · 10. 중요도별 기본값 · 목소리 ---
test('중요도 약 · 중간 · 중요 → 목소리 · 말투 기본값', () => {
  assert.deepEqual([resolveVoice('LOW').voice, resolveVoice('LOW').tone], ['Sulafat', 'GENTLE']);
  assert.deepEqual([resolveVoice('NORMAL').voice, resolveVoice('NORMAL').tone], ['Zephyr', 'NORMAL']);
  assert.deepEqual([resolveVoice('HIGH').voice, resolveVoice('HIGH').tone], ['Kore', 'FIRM']);
  const d = resolveVoice('HIGH');
  assert.equal(d.enabled, true);
  assert.equal(d.escalate, true);
  assert.equal(d.personal, true);
  assert.equal(d.coachMax, 3); // 소리치기(4)는 사용자가 허용해야
  assert.deepEqual(d.manual, { voice: false, tone: false });
});

test('중요도별 말투 지시: 약은 느리고 차분, 중요는 빠르고 강함', () => {
  assert.match(speechStyle(1, resolveVoice('LOW').tone), /slow and calm/);
  assert.match(speechStyle(1, resolveVoice('NORMAL').tone), /clear/);
  assert.match(speechStyle(1, resolveVoice('HIGH').tone), /fast pace with forceful/);
});

// --- 2. 수동 설정 우선 · 기본값으로 되돌리기 ---
test('사용자 수동 설정 > 중요도 기본값, 칸을 지우면 기본값', () => {
  const p = resolveVoice('HIGH', { voice: 'Sulafat', tone: 'GENTLE', escalate: false });
  assert.equal(p.voice, 'Sulafat');
  assert.equal(p.tone, 'GENTLE');
  assert.equal(p.escalate, false);
  assert.deepEqual(p.manual, { voice: true, tone: true });
  assert.equal(resolveVoice('HIGH', {}).voice, 'Kore'); // 되돌림 = 칸 없음
});

test('cleanPrefs: 모르는 목소리 · 단계 · 칸은 버림 (DB 값을 믿지 않음)', () => {
  assert.deepEqual(cleanPrefs({ voice: 'Nope', tone: 'LOUD', coachMax: 9, hack: 1, personal: false }), { personal: false });
  assert.deepEqual(cleanPrefs(null), {});
  assert.deepEqual(cleanPrefs('x'), {});
  assert.deepEqual(cleanPrefs({ voice: 'Kore', coachMax: 4, enabled: false }), { voice: 'Kore', coachMax: 4, enabled: false });
});

// --- 3. 진동 OFF 유지 (기존 알람 축 — 음성 브리핑이 바꾸지 않음) ---
test('중요(HIGH)여도 사용자가 진동을 끄면(약 단계 = NONE) 진동 없음', () => {
  const r = resolveIntensity('HIGH', 5, { vibration: 0 });
  assert.equal(r.fields.intensity, 'STRONG');
  assert.equal(r.fields.vibration, 'NONE');
  assert.equal(vibrationOf(r.fields.vibration, r.fields.intensity), 'NONE');
  // 음성 프로필에는 진동 · 볼륨 칸 자체가 없음 — 긴급도가 올라가도 진동을 켤 수 없음
  assert.equal('vibration' in resolveVoice('HIGH', { coachMax: 4 }), false);
});

// --- 4 · 5. 긴급도 ---
const rule = (over: Partial<UrgencyRule> = {}): UrgencyRule => ({ prepMinutes: 40, lateBump: false, allow4: true, maxLevel: 4, ...over });
const NOW = kst(7);
const departIn = (minutes: number) => NOW + minutes * 60_000;

test('여유 충분 · 안 미룸 → 1단계 (중요한 일정이라도 처음부터 안 소리침)', () => {
  assert.equal(urgencyLevel(rule(), 0, NOW, departIn(40 + 60)), 1);
  assert.equal(urgencyLevel(rule(), 0, NOW, null), 1);
});

test('미루기 횟수가 늘면 단계가 오름 (여유는 충분)', () => {
  const r = rule();
  const depart = departIn(40 + 90);
  assert.deepEqual([0, 1, 2, 3].map((n) => urgencyLevel(r, n, NOW, depart)), [1, 1, 2, 2]);
  // 지각이 잦으면 한 번만 미뤄도 2단계
  assert.equal(urgencyLevel(rule({ lateBump: true }), 1, NOW, depart), 2);
});

test('실제 지각 위험(여유 = 출발까지 − 준비)이 줄면 단계가 오름', () => {
  const r = rule();
  assert.equal(urgencyLevel(r, 0, NOW, departIn(40 + 25)), 1);
  assert.equal(urgencyLevel(r, 0, NOW, departIn(40 + 15)), 2);
  assert.equal(urgencyLevel(r, 0, NOW, departIn(40 + 5)), 3);
  assert.equal(urgencyLevel(r, 0, NOW, departIn(10)), 3); // 시간 모자라도 안 미뤘으면 소리치지 않음
});

test('4단계 = 중요 + 미루기 2번 이상 + 여유 5분 미만일 때만', () => {
  assert.equal(urgencyLevel(rule(), 2, NOW, departIn(40 + 3)), 4);
  assert.equal(urgencyLevel(rule(), 1, NOW, departIn(40 + 3)), 3); // 한 번만 미룸
  assert.equal(urgencyLevel(rule(), 2, NOW, departIn(40 + 8)), 3); // 여유 8분
  assert.equal(urgencyLevel(rule({ allow4: false }), 3, NOW, departIn(0)), 3); // 중요 아님 · 허용 안 함
});

test('사용자가 허용한 범위만: 상한 · 자동 강화 끔', () => {
  assert.equal(urgencyLevel(rule({ maxLevel: 2 }), 3, NOW, departIn(0)), 2);
  assert.equal(urgencyLevel(rule({ maxLevel: 1 }), 3, NOW, departIn(0)), 1);
});

test('urgencyRule: 4단계는 HIGH + 상한 4 + 자동 강화일 때만, 끄면 상한 1', () => {
  const p = (coachMax: 1 | 2 | 3 | 4, escalate = true) => ({ coachMax, escalate });
  assert.equal(urgencyRule({ importance: 'HIGH', prepMinutes: 30, lateCount4w: 0, profile: p(4) }).allow4, true);
  assert.equal(urgencyRule({ importance: 'NORMAL', prepMinutes: 30, lateCount4w: 0, profile: p(4) }).allow4, false);
  assert.equal(urgencyRule({ importance: 'HIGH', prepMinutes: 30, lateCount4w: 0, profile: p(3) }).allow4, false);
  const off = urgencyRule({ importance: 'HIGH', prepMinutes: null, lateCount4w: 3, profile: p(4, false) });
  assert.deepEqual(off, { prepMinutes: 0, lateBump: true, allow4: false, maxLevel: 1 });
  assert.deepEqual(levelsToPrepare(off), [1]);
  assert.deepEqual(levelsToPrepare(rule()), [1, 2, 3, 4]);
  assert.deepEqual(levelsToPrepare(rule({ allow4: false })), [1, 2, 3]);
});

// --- 11. 긴급도별 발화 지침 ---
test('2~4단계는 말투 대신 긴급도 지시 (4단계 = 다급하게 소리침 · 매우 빠름 · 강한 강세)', () => {
  assert.equal(speechStyle(1, 'FIRM'), TONES.FIRM.style);
  assert.equal(speechStyle(2, 'GENTLE'), URGENCY_STYLE[2]);
  assert.match(speechStyle(3, 'GENTLE'), /urgent/);
  assert.match(speechStyle(4, 'GENTLE'), /panicked/);
  assert.match(speechStyle(4, 'GENTLE'), /shouting/);
  assert.match(speechStyle(4, 'GENTLE'), /very fast/);
  assert.match(speechStyle(4, 'GENTLE'), /strongly stressed/);
});

// --- 6 · 9. 전날 다짐 ---
const session = (over: Partial<StructuredLike> = {}): StructuredLike => ({
  schema_version: 'structured.v1',
  session: { reference_date: '2026-11-10' },
  goals_routine: { goals: [] },
  habit_signals: [],
  sleep_wake: [],
  schedule_outcomes: [],
  other: { safety_flag: false },
  ...over,
});

test('전날 "늦잠 자서 지각 · 내일 일찍 일어나고 싶어" → 다짐 · 반성', () => {
  const s = session({
    goals_routine: { goals: [{ habit: 'irregular_wake', goal_text: '일찍 일어나기', source: 'stated' }] },
    schedule_outcomes: [{ is_late: true, causes: ['overslept'], source: 'stated' }],
  });
  assert.deepEqual(wakeMemo([s], '2026-11-10'), { wakeEarly: true, overslept: true, lateByOversleep: true, goals: [] });
});

test('대화 없음 · 다른 날 · 짐작(inferred) · 위험 판정 대화는 안 씀 → null (기본 멘트)', () => {
  assert.equal(wakeMemo([], '2026-11-10'), null);
  const inferred = session({ goals_routine: { goals: [{ habit: 'irregular_wake', goal_text: '일찍', source: 'inferred' }] } });
  assert.equal(wakeMemo([inferred], '2026-11-10'), null);
  const told = session({ goals_routine: { goals: [{ habit: 'irregular_wake', goal_text: '일찍', source: 'stated' }] } });
  assert.equal(wakeMemo([told], '2026-11-09'), null);
  assert.equal(wakeMemo([{ ...told, other: { safety_flag: true } }], '2026-11-10'), null);
});

test('늦잠 이야기가 없으면 지각 반성 문장을 만들지 않음', () => {
  const s = session({ goals_routine: { goals: [{ habit: 'skip_breakfast', goal_text: '아침 먹기', source: 'confirmed' }] } });
  const memo = wakeMemo([s], '2026-11-10');
  assert.deepEqual(memo, { wakeEarly: false, overslept: false, lateByOversleep: false, goals: ['아침 먹기'] });
  for (const level of [1, 2, 3, 4] as const) {
    const t = briefingText(level, { ...input([]), memo });
    assert.doesNotMatch(t, /지각/);
    assert.doesNotMatch(t, /일찍 일어나/);
  }
});

// --- 7 · 8 · 9. 오늘 일정 ---
const appt = (title: string, h: number, importance: BriefAppointment['importance'] = 'NORMAL'): BriefAppointment => ({ title, atMs: kst(h), importance });
const input = (appointments: BriefAppointment[], over: Partial<BriefingInput> = {}): BriefingInput => ({
  memo: null,
  appointments,
  todos: [],
  departAtMs: null,
  timeZone: TZ,
  ...over,
});

test('일정 0개 · 1개 · 여러 개', () => {
  assert.match(briefingText(1, input([])), /오늘은 등록된 일정이 없어\./);
  assert.match(briefingText(1, input([appt('팀플 회의', 15)])), /오늘은 오후 3시 팀플 회의 일정이 있어\./);
  const many = pickAppointments([appt('과제', 19), appt('팀플 회의', 15), appt('저녁 약속', 17)]);
  assert.match(briefingText(1, input(many)), /오후 3시 팀플 회의, 오후 5시 저녁 약속, 오후 7시 과제 순서로 일정이 있어/);
});

test('시간순 정렬 · 많으면 가장 가까운 일정 + 중요한 일정 우선', () => {
  const picked = pickAppointments([appt('E', 20), appt('D', 18, 'HIGH'), appt('A', 9), appt('C', 14), appt('B', 11)]);
  assert.deepEqual(picked.map((a) => a.title), ['A', 'B', 'D']); // A 가장 가까움, D 중요, B 다음 가까움
  assert.deepEqual(pickAppointments([appt('x', 10), appt(' ', 9)]).map((a) => a.title), ['x']); // 빈 제목 안 씀
});

test('없는 일정 · 시각을 만들지 않음: 할 일에는 시각을 안 붙이고, DB 일정 제목만 나옴', () => {
  const t = briefingText(1, input([appt('팀플 회의', 15)], { todos: [{ title: '노트북', type: 'ITEM' }, { title: '과제 제출', type: 'TASK' }] }));
  assert.match(t, /챙길 것: 노트북\./);
  assert.match(t, /오늘 할 일: 과제 제출\./);
  assert.doesNotMatch(t, /(오전|오후) \d+시[^.]*과제 제출/);
  assert.equal((t.match(/(오전|오후) \d+시/g) ?? []).length, 1);
});

test('기본 브리핑 예시 모양 (1단계)', () => {
  const memo = { wakeEarly: true, overslept: false, lateByOversleep: false, goals: [] };
  const t = briefingText(1, input(pickAppointments([appt('팀플 회의', 15), appt('저녁 약속', 17), appt('과제', 19)]), { memo }));
  assert.equal(
    t,
    '좋은 아침이야~ 어제 오늘부터는 일찍 일어나겠다고 했잖아. 오늘은 오후 3시 팀플 회의, 오후 5시 저녁 약속, 오후 7시 과제 순서로 일정이 있어. 슬슬 일어나서 준비해 볼까?',
  );
});

test('긴급 브리핑(4단계): 기상 촉구가 먼저, 핵심 일정은 2개만 짧게', () => {
  const memo = { wakeEarly: true, overslept: true, lateByOversleep: true, goals: [] };
  const t = briefingText(4, input(pickAppointments([appt('팀플 회의', 15), appt('저녁 약속', 17), appt('과제', 19)]), { memo }));
  assert.ok(t.startsWith('야!!!!!!!!!! 너 어제 일찍 일어나고 싶다며!!!!!!!'));
  assert.match(t, /또 지각할 거야\?!\?!/);
  assert.match(t, /오늘 오후 3시 팀플 회의, 오후 5시 저녁 약속 있잖아!!!!/);
  assert.doesNotMatch(t, /과제/);
  assert.ok(t.endsWith('지금 당장 일어나!!!!!!!'));
});

test('출발 시각은 고정 시각으로만 (남은 분 같은 움직이는 수는 음성에 안 넣음)', () => {
  const t1 = briefingText(1, input([appt('수업', 10)], { departAtMs: kst(8, 40) }));
  assert.match(t1, /오전 8시 40분에는 나가야 하니까/);
  for (const level of [1, 2, 3, 4] as const) assert.doesNotMatch(briefingText(level, input([appt('수업', 10)], { departAtMs: kst(8, 40) })), /\d+분 남/);
});

// --- 12. 캐시 열쇠 ---
test('캐시 열쇠: 같은 내용이면 같고, 일정 · 목소리 · 지시가 바뀌면 다름', () => {
  const base = { text: '좋은 아침', voice: 'Kore', style: 's', model: 'm' };
  assert.equal(clipHash(base), clipHash({ ...base }));
  assert.match(clipHash(base), /^[0-9a-f]{16}$/);
  assert.notEqual(clipHash(base), clipHash({ ...base, text: '좋은 아침!' }));
  assert.notEqual(clipHash(base), clipHash({ ...base, voice: 'Puck' }));
  assert.notEqual(clipHash(base), clipHash({ ...base, style: 't' }));

  const r = rule();
  const prof = { voice: 'Kore', tone: 'FIRM' as const };
  const a = briefingClips(r, prof, input([appt('회의', 15)]));
  const b = briefingClips(r, prof, input([appt('회의', 16)])); // 일정 시각이 바뀜 → 모든 단계 새로
  assert.deepEqual(a.map((c) => c.level), [1, 2, 3, 4]);
  assert.ok(a.every((c, i) => c.hash !== b[i].hash));
  assert.equal(new Set(a.map((c) => c.style)).size, 4); // 단계마다 실제 발화 지시가 다름
});
