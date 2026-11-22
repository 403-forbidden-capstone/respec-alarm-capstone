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
  GEMINI_FALLBACK_FILE,
  GEMINI_FALLBACK_TEXT,
  GEMINI_STAGE,
  noExclaim,
  speakable,
  TTS_MODEL,
  lateRisk,
  levelAt,
  levelsToPrepare,
  needsGemini,
  pickAppointments,
  resolveVoice,
  slackMinutes,
  speechLevel,
  startLevelOf,
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
  assert.deepEqual([p.voice, p.tone, p.escalate], ['Sulafat', 'GENTLE', true]);
  assert.deepEqual(p.manual, { voice: true, tone: true });
  assert.equal(resolveVoice('HIGH', {}).voice, 'Kore');
  assert.deepEqual(cleanPrefs({ voice: 'Nope', tone: 'LOUD', coachMax: 9, hack: 1, personal: false }), {}); // personal(어제 대화 끄기)은 없어진 칸
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

test('경계: 위험 구분은 표시용, 0분 이하만 URGENT(Gemini 4단계)', () => {
  const at = (slack: number) => lateRisk(slackMinutes(depart(), kst(10) - (40 + slack) * MIN));
  assert.deepEqual([31, 30, 16, 15, 6, 5, 0, -3].map(at), ['SAFE', 'CAUTION', 'CAUTION', 'DANGER', 'DANGER', 'IMMINENT', 'URGENT', 'URGENT']);
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
test('말소리 → 시작 단계: 약(CALM) 1 · 중(NEUTRAL) 2 · 강(DIRECT) 3, 모르는 값은 DB 기본값처럼 2', () => {
  assert.deepEqual(['CALM', 'NEUTRAL', 'DIRECT', null, undefined, 'X'].map(startLevelOf), [1, 2, 3, 2, 2, 2]);
});

test('미루기 단계 상승: 약 1→2→3→3 · 중 2→3→3→3 · 강 3→3→3→3 — 미루기만으로는 4가 안 됨', () => {
  for (const [tone, want] of [['CALM', [1, 2, 3, 3]], ['NEUTRAL', [2, 3, 3, 3]], ['DIRECT', [3, 3, 3, 3]]] as const) {
    const rule = urgencyRule(wake(), startLevelOf(tone));
    const early = kst(6); // 여유 넉넉함
    assert.deepEqual([0, 1, 2, 3].map((n) => levelAt(rule, n, early)), want, tone);
    assert.equal(levelAt(rule, 9, early), 3, tone);
  }
  assert.deepEqual([0, 1, 2, 3, 9].map((n) => speechLevel(n, 'SAFE', 4)), [1, 2, 3, 3, 3]); // 시작 단계 없음(예전 브리핑) = 1
});

test('여유 5분 이하는 더 이상 3단계로 올리지 않음 — 시작 단계 그대로', () => {
  const fiveMinutes = kst(10) - (90 + 5) * MIN;
  assert.equal(lateRisk(slackMinutes(wake(), fiveMinutes)), 'IMMINENT');
  assert.equal(speechLevel(0, 'IMMINENT', 4, 1), 1);
  for (const start of [1, 2, 3] as const) assert.equal(levelAt(urgencyRule(wake(), start), 0, fiveMinutes), start);
  assert.equal('dangerAtMs' in urgencyRule(wake(), 2), false);
});

test('여유 0분 이하면 말소리 · 미루기와 관계없이 4 (버퍼 없이 약속 − 지금 − 준비 − 이동)', () => {
  const zeroMinutes = kst(10) - 90 * MIN;
  assert.equal(urgentAtMs(wake()), zeroMinutes);
  for (const start of [1, 2, 3] as const) {
    const rule = urgencyRule(wake(), start);
    assert.equal(levelAt(rule, 0, zeroMinutes - 1), start, `직전 ${start}`);
    for (const snooze of [0, 1, 2, 5]) assert.equal(levelAt(rule, snooze, zeroMinutes), 4, `${start} · ${snooze}`);
  }
});

test('계산 자료(약속 · 준비 · 이동)가 없으면 4단계 없음', () => {
  for (const s of [wake({ travelMinutes: null }), wake({ prepMinutes: null }), wake({ appointmentAtMs: null })]) {
    const rule = urgencyRule(s, 3);
    assert.equal(rule.urgentAtMs, null);
    assert.equal(levelAt(rule, 5, kst(23)), 3);
  }
});

test('예전 상한 값 호환 — 4를 넘지 않고 상한 아래로', () => {
  assert.equal(speechLevel(0, 'URGENT', 3), 3);
  assert.equal(speechLevel(3, 'URGENT', 1), 1);
  assert.equal(urgencyRule(wake()).maxLevel, 4); // 긴급 음성을 사용자 설정으로 끄지 못함
});

test('미리 계산한 긴급 시각(urgentAtMs) 비교 = 지각 위험 계산 그대로 (네이티브가 쓰는 식) — 30초 간격으로 모두 같음', () => {
  for (const s of [wake(), depart(), wake({ prepMinutes: 0, travelMinutes: 7 })]) {
    for (const start of [1, 2, 3] as const) {
      const rule = urgencyRule(s, start);
      for (let t = kst(7); t <= kst(10, 5); t += 30_000) {
        for (const snooze of [0, 1, 2, 3]) {
          assert.equal(levelAt(rule, snooze, t), speechLevel(snooze, lateRisk(slackMinutes(s, t)), 4, start), `${s.kind} ${start} ${new Date(t).toISOString()} ${snooze}`);
        }
      }
    }
  }
});

test('TS · Kotlin 같은 표 (spec/urgency-cases.json — 네이티브는 SpeechUrgencyTest가 같은 표로 확인)', () => {
  const cases = JSON.parse(readFileSync(new URL('../../../mobile/modules/alarm-core/spec/urgency-cases.json', import.meta.url), 'utf8')) as {
    name: string; snoozeCount: number; nowMs: number; urgentAtMs: number | null; maxLevel: 1 | 2 | 3 | 4; startLevel: 1 | 2 | 3; expected: number;
  }[];
  assert.ok(cases.length >= 20);
  for (const c of cases) assert.equal(levelAt({ urgentAtMs: c.urgentAtMs, maxLevel: c.maxLevel, startLevel: c.startLevel }, c.snoozeCount, c.nowMs), c.expected, c.name);
});

// --- 엔진 · Gemini 필요 판단 ---
test('엔진: 1 · 2단계 Android TTS, 3 · 4단계는 Gemini 음성이 있을 때만 (없으면 Android로 전체)', () => {
  assert.deepEqual(([1, 2] as const).map((l) => engineFor(l, true)), ['ANDROID', 'ANDROID']);
  assert.deepEqual(([3, 4] as const).map((l) => engineFor(l, true)), ['GEMINI', 'GEMINI']);
  assert.deepEqual(([3, 4] as const).map((l) => engineFor(l, false)), ['ANDROID', 'ANDROID']);
  // 말소리 중이면 첫 울림 2단계 Android, 강이면 첫 울림부터 3단계 Gemini 엄마
  assert.equal(engineFor(levelAt(urgencyRule(wake(), 2), 0, kst(7)), true), 'ANDROID');
  assert.equal(engineFor(levelAt(urgencyRule(wake(), 3), 0, kst(7)), true), 'GEMINI');
});

test('3단계(엄마) Gacrux · 4단계(긴급) Kore — 목소리 · 지시문이 서로 다르고 확정 지시문 그대로', () => {
  assert.equal(TTS_MODEL, 'gemini-3.8-flash-tts');
  assert.equal(GEMINI_STAGE[3].voice, 'Gacrux');
  assert.equal(GEMINI_STAGE[4].voice, 'Kore');
  assert.ok(GEMINI_STAGE[3].style.startsWith('Perform in natural Korean as a furious, extremely worried Korean mother'));
  assert.match(GEMINI_STAGE[3].style, /Deliver the command "지금 당장 일어나" with the strongest, most explosive shout/);
  assert.equal(
    GEMINI_STAGE[4].style,
    'panicked, desperate shouting at the top of the voice; very fast, every phrase strongly stressed, breathless urgent intonation (forceful but never insulting)',
  );
  // 앱에 든 예비 파일 — 기존 파일명 그대로 단계에 배정
  assert.deepEqual(GEMINI_FALLBACK_FILE, { 3: 'gemini_stage4_fallback.wav', 4: 'gemini_urgent_sample.wav' });
  assert.equal(speakable(GEMINI_FALLBACK_TEXT[4]), '야! 지금 안 일어나면 진짜 늦어! 지금 당장 일어나!');
});

test('미루기 3번이어도 여유 40분이면 긴급 아님 → 3단계(Gemini 엄마)이지 4단계 아님', () => {
  const s = wake();
  const now = kst(10) - (90 + 40) * MIN;
  const rule = urgencyRule(s, 1);
  assert.equal(levelAt(rule, 3, now), 3);
  assert.equal(engineFor(levelAt(rule, 3, now), true), 'GEMINI');
  assert.equal(needsGemini(rule, 'WAKE', kst(6)), true); // 알람이 해제 전까지 계속 울릴 수 있어 여유 0분 시각을 미리 준비
});

test('3단계 Gemini: 기상은 미루기만으로 오므로 늘 준비, 출발(미루기 없음)은 말소리 강일 때만', () => {
  const unknown = urgencyRule(wake({ travelMinutes: null }), 1);
  assert.equal(needsGemini(unknown, 'WAKE', kst(6), 3), true); // 지각 위험을 몰라도 미루기 2번이면 3단계
  assert.equal(needsGemini(unknown, 'WAKE', kst(6), 4), false);
  assert.equal(needsGemini(urgencyRule(depart(), 2), 'DEPARTURE', kst(9, 15), 3), false); // 여유 5분이어도 이제 3단계 아님
  assert.equal(needsGemini(urgencyRule(depart(), 3), 'DEPARTURE', kst(9, 5), 3), true);
  assert.equal(needsGemini({ ...urgencyRule(depart(), 3), maxLevel: 2 }, 'DEPARTURE', kst(9, 20), 3), false);
});

test('Gemini는 이 알람이 울리는 동안 실제로 긴급이 될 수 있을 때만 미리 만듦', () => {
  const rule = urgencyRule(wake(), 2); // 긴급 시각 = 10시 − 90분 = 8:30
  assert.equal(needsGemini(rule, 'WAKE', kst(7, 30)), true); // 미루다 보면 긴급
  assert.equal(needsGemini(rule, 'WAKE', kst(7, 20)), true);
  const d = urgencyRule(depart(), 2); // 긴급 시각 9:20
  assert.equal(needsGemini(d, 'DEPARTURE', kst(9, 10)), false); // 출발 알람 9:10 — 여유 10분이지 긴급 아님
  assert.equal(needsGemini(d, 'DEPARTURE', kst(9, 20)), true);
  assert.equal(needsGemini({ ...d, maxLevel: 3 }, 'DEPARTURE', kst(9, 20)), false); // 상한 3 → Gemini 안 씀
  assert.equal(needsGemini(urgencyRule(wake({ travelMinutes: null }), 3), 'WAKE', kst(9)), false); // UNKNOWN
});

test('Android TTS: 1 · 2단계 높낮이 1.0 · 속도 1.0 고정 (말투에 더하지 않음), 목소리 번호는 늘 0 (설정 미리 듣기와 같게)', () => {
  for (const imp of ['LOW', 'NORMAL', 'HIGH'] as const) {
    assert.deepEqual([androidVoice(resolveVoice(imp), 1).pitch, androidVoice(resolveVoice(imp), 1).rate], [1.0, 1.0], imp);
    assert.deepEqual([androidVoice(resolveVoice(imp), 2).pitch, androidVoice(resolveVoice(imp), 2).rate], [1.0, 1.0], imp);
  }
  // 중요도 · 예전에 고른 목소리(따뜻한 · 밝은 · 단호한)와 상관없이 같은 목소리
  for (const imp of ['LOW', 'NORMAL', 'HIGH'] as const) assert.equal(androidVoice(resolveVoice(imp), 1).voiceIndex, 0, imp);
  assert.equal(androidVoice(resolveVoice('HIGH', { voice: 'Kore' }), 2).voiceIndex, 0);
});

// --- 전날 다짐 ---
const session = (over: Partial<StructuredLike> = {}): StructuredLike => ({ schema_version: 'structured.v1', session: { reference_date: '2026-11-10' }, other: { safety_flag: false }, ...over });

test('전날 "늦잠 자서 지각 · 일찍 일어나고 싶어" → 다짐 · 반성, 없거나 짐작이면 null', () => {
  const s = session({
    goals_routine: { goals: [{ habit: 'irregular_wake', goal_text: '일찍 일어나기', source: 'stated' }] },
    schedule_outcomes: [{ is_late: true, causes: ['overslept'], source: 'stated' }],
  });
  assert.deepEqual(wakeMemo([s], '2026-11-10'), { wakeEarly: true, overslept: true, lateByOversleep: true, snoozeRepeat: false, goals: ['일찍 일어나기'] });
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
  const memo = { wakeEarly: true, overslept: false, lateByOversleep: false, snoozeRepeat: false, goals: [] };
  assert.equal(
    briefingText(1, input({ memo, appointments: pickAppointments([appt('과제', 19), appt('팀플 회의', 15), appt('저녁 약속', 17)]) })),
    '좋은 아침이야. 오늘은 오후 3시 팀플 회의, 오후 5시 저녁 약속, 오후 7시 과제 순서로 일정이 있어. 어제 오늘부터는 일찍 일어나겠다고 했잖아. 슬슬 일어나서 준비해 보자.',
  );
  const t = briefingText(1, input({ appointments: [appt('수업', 10)], todos: [{ title: '노트북', type: 'ITEM' }, { title: '과제 제출', type: 'TASK' }] }));
  assert.equal((t.match(/(오전|오후) \d+시/g) ?? []).length, 1);
});

test('기상 일정은 개수 제한 없이 전부 시간순 (max를 주면 가장 가까운 일정 + 중요한 일정 우선)', () => {
  const list = [appt('E', 20), appt('D', 18, 'HIGH'), appt('A', 9), appt('C', 14), appt('B', 11)];
  assert.deepEqual(pickAppointments(list).map((a) => a.title), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(pickAppointments(list, 3).map((a) => a.title), ['A', 'B', 'D']);
});

test('기상 템플릿: 모든 단계에 오늘 전체 일정 · 준비물 전부 · 다짐 전부, 1 · 2단계는 느낌표 없음', () => {
  const full = input({
    memo: { wakeEarly: true, overslept: true, lateByOversleep: true, snoozeRepeat: true, goals: ['알람 미루지 않고 바로 일어나기', '운동하기'] },
    appointments: [appt('팀플 발표', 10, 'HIGH'), appt('전공 수업', 14), appt('헬스장', 18), appt('스터디', 20)],
    todos: ['노트북', '발표 자료', '운동복', '충전기'].map((title) => ({ title, type: 'ITEM' as const })),
  });
  const texts = ([1, 2, 3, 4] as const).map((l) => briefingText(l, full));
  for (const t of texts) {
    for (const w of ['오전 10시 팀플 발표', '오후 2시 전공 수업', '오후 6시 헬스장', '오후 8시 스터디', '노트북', '발표 자료', '운동복', '충전기', '알람 미루지 않고 바로 일어나기', '운동하기']) assert.ok(t.includes(w), `${w} 없음: ${t}`);
  }
  assert.doesNotMatch(texts[0] + texts[1], /[!！]/);
  assert.match(texts[2] + texts[3], /!/); // 3 · 4단계는 Gemini TTS용이라 느낌표를 둠
  assert.equal(new Set(texts).size, 4);
});

test('noExclaim: 반각 · 전각 · 연속 느낌표를 마침표 · 공백으로, ?!는 ?로, 숫자 · 따옴표는 그대로', () => {
  assert.equal(noExclaim('야!!!!너 일어나!'), '야. 너 일어나.');
  assert.equal(noExclaim('해?! 빨리!'), '해? 빨리.');
  assert.equal(noExclaim('일어나！！ 빨리!'), '일어나. 빨리.');
  assert.equal(noExclaim('1.5배!'), '1.5배.');
  assert.equal(noExclaim('"운동!" 하자'), '"운동." 하자');
  assert.equal(noExclaim('좋은 아침이야.'), '좋은 아침이야.');
});

test('기상 2 · 3단계는 "미뤘다" · "늦는다"를 단정하지 않음, 4단계(실제 긴급)만 "늦어"', () => {
  for (const level of [1, 2, 3] as const) assert.doesNotMatch(briefingText(level, input({ appointments: [appt('수업', 10)] })), /늦어|늦는다|미뤘/);
  const t = briefingText(4, input({ memo: { wakeEarly: true, overslept: true, lateByOversleep: true, snoozeRepeat: false, goals: [] }, appointments: [appt('팀플 회의', 15), appt('저녁 약속', 17), appt('과제', 19)] }));
  assert.ok(t.startsWith('야! 너 안 일어나?! 지금 안 일어나면 진짜 늦어!'));
  assert.match(t, /너 어제 일찍 일어나고 싶다며/);
  assert.match(t, /지금 당장 일어나! 빨리 일어나라고!$/);
  assert.match(t, /과제/); // 긴급에서도 오늘 일정은 전부
});

test('3단계 대사: 지각을 단정하지 않음 (스누즈로도 와서)', () => {
  const t = briefingText(3, input({ appointments: [appt('팀플 회의', 10)], departAtMs: kst(9, 10) }));
  assert.equal(t, '야! 이제 진짜 일어나야 돼! 오늘은 오전 10시 팀플 회의 일정이 있어. 오전 9시 10분에는 나가야 해! 얼른 일어나서 준비해!');
  assert.doesNotMatch(t, /늦|딱 맞게/);
  assert.equal(briefingText(2, input({ appointments: [appt('팀플 회의', 10)] })), '이제 정말 일어나야 해. 오늘은 오전 10시 팀플 회의 일정이 있어. 이제 그만 자고 지금 준비를 시작하자.');
});

test('느낌표 · 물음표 반복 정리 — 모든 단계 · 종류 문장, 사용자가 적은 제목 · 준비물까지 (글자는 그대로)', () => {
  assert.equal(speakable('회의!!!! 진짜??? 뭐?!?!?! 좋아!'), '회의! 진짜? 뭐?! 좋아!');
  const loud = input({
    memo: { wakeEarly: true, overslept: true, lateByOversleep: true, snoozeRepeat: false, goals: ['운동!!!'] },
    appointments: [appt('면접!!!!', 10, 'HIGH')],
    todos: [{ title: '이력서???', type: 'ITEM' }],
    departAtMs: kst(9),
  });
  for (const kind of ['WAKE', 'DEPARTURE'] as const) {
    for (const level of [1, 2, 3, 4] as const) {
      const t = briefingText(level, { ...loud, kind });
      assert.doesNotMatch(t, /[!?]{3,}|!!|\?\?/, `${kind} ${level}: ${t}`);
      assert.match(t, /면접/);
    }
  }
});

test('출발 브리핑: 그 일정 시각 + 등록된 준비물 + 출발 촉구 (전날 대화 · 다른 일정은 안 넣음)', () => {
  const d = (level: 1 | 4, todos: BriefingInput['todos'] = [{ title: '노트북', type: 'ITEM' }, { title: '충전기', type: 'ITEM' }]) =>
    briefingText(level, input({ kind: 'DEPARTURE', appointments: [appt('면접', 10, 'HIGH')], todos, memo: { wakeEarly: true, overslept: false, lateByOversleep: false, snoozeRepeat: false, goals: [] } }));
  assert.equal(d(1), '오전 10시 면접 갈 시간이야. 챙길 것: 노트북, 충전기. 이제 출발하자.'); // 1 · 2단계는 Android TTS라 느낌표 없음
  assert.equal(d(4), '야! 지금 당장 나가! 이러다 면접 늦는다고! 노트북, 충전기 챙기고 바로 출발해!');
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

test('캐시 열쇠: 3 · 4단계는 그 단계의 모델 · 목소리 · 지시 · 대사로 — 하나라도 바뀌면 다른 열쇠', () => {
  const rule: UrgencyRule = { urgentAtMs: null, maxLevel: 4 };
  const clips = briefingClips(rule, { voice: 'Kore', tone: 'FIRM' }, input({ appointments: [appt('회의', 15)] }));
  for (const level of [3, 4] as const) {
    const c = clips.find((x) => x.level === level)!;
    const g = GEMINI_STAGE[level];
    assert.equal(c.hash, clipHash({ text: c.text, voice: g.voice, style: g.style, model: TTS_MODEL }));
    assert.notEqual(c.hash, clipHash({ text: c.text, voice: 'Zephyr', style: g.style, model: TTS_MODEL })); // 목소리 바뀜
    assert.notEqual(c.hash, clipHash({ text: c.text, voice: g.voice, style: `${g.style} `, model: TTS_MODEL })); // 지시 바뀜
    assert.notEqual(c.hash, clipHash({ text: c.text, voice: g.voice, style: g.style, model: 'gemini-3.8-flash-lite-tts' })); // 모델 바뀜
  }
  assert.equal(new Set(clips.map((c) => c.hash)).size, 4);
  // 사용자 Android 목소리 선택은 3 · 4단계 Gemini 열쇠에 영향 없음
  const other = briefingClips(rule, { voice: 'Sulafat', tone: 'GENTLE' }, input({ appointments: [appt('회의', 15)] }));
  assert.deepEqual(other.filter((c) => c.level >= 3).map((c) => c.hash), clips.filter((c) => c.level >= 3).map((c) => c.hash));
});
