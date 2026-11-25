// voice-session · voice-turn 흐름 시험 (L4 PR 4, 설계 메모 8절 "녹화 시험 한 바퀴") — 가짜 DB(fake-db) + 가짜 Claude(지점별 미리 정한 출력, 받은 화면 글을 남김).
// 모델 호출 · 키 읽기 없음. 녹화 출력은 testdata/s3-dev-014.json(실험실 개발용 대화 모양, 손으로 짠 줄은 _recorded: false) — 품질이 아니라 흐름 시험.
// 한 바퀴: ① 시드 → ② 세션(템플릿) → ③ 새 약속 카드(NEEDS_ESTIMATE · APP_TASKS) → ④ results(확인 필요 · CONFIRM) → ⑤ "응"(강조 · 가드 다시) → ⑥ 저장 → ⑦ 도착 정정
// 그 밖: rev 충돌 · 재시도 · 상한 · 키 없음 · T1 실패 · 자정 · 위기 · 질문 예산 · ai_calls · 남의 세션
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { HttpError } from '../errors.ts';
import { FakeDb } from '../fake-db.ts';
import type { Db } from '../supabase.ts';
import { fakeClaude, upstreamError, type FakeScript } from './fake-claude.ts';
import { POINTS } from '../prompts/index.ts';
import { handleVoiceTurn, type VoiceDeps, type VoiceTurnOut } from './turn.ts';
import { handleVoiceSession, type VoiceSessionOut } from './voice-session.ts';
import type { ServerState } from './session.ts';
import { LIMIT_TURN_TEXT, MAX_USER_TURNS } from './opening.ts';

const DATA = JSON.parse(readFileSync(new URL('./testdata/s3-dev-014.json', import.meta.url), 'utf8')) as {
  T2F: Record<string, Record<string, unknown>>;
  T1: Record<string, Record<string, unknown>>;
  results: Record<string, unknown>;
};
// 녹화 메모 칸(_로 시작)은 모델 출력이 아니므로 뗌
const clean = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
const t2f = (k: string) => clean(DATA.T2F[k]);
const t1 = (k: string) => clean(DATA.T1[k]);

const ME = 'u-me';
const OTHER = 'u-other';
const NOW = new Date('2026-10-29T20:30:00+09:00');
const cid = (() => {
  let n = 0;
  return () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
})();

// ───────── 시드: 10/29 기상 08:12 폰 사용 · 07:45 위치 출발(앞 출발) · 08:40 위치 출발 · 10:00 수업 도착 10:07 위치(지각 아님) ─────────
function seed(now: Date = NOW): FakeDb {
  const db = new FakeDb();
  db.now = now;
  db.rows('profiles').push({ user_id: ME, nickname: '지민', timezone: 'Asia/Seoul' });
  db.rows('daily_records').push({ record_id: 'r1', user_id: ME, record_date: '2026-10-29', wake_confirmed_at: '2026-10-29T08:12:00+09:00' });
  db.rows('alarm_events').push({ event_id: 1, alarm_id: 'al-wake', user_id: ME, event_type: 'WAKE_CONFIRMED', event_at: '2026-10-29T08:12:00+09:00', input_source: 'USAGE' });
  db.rows('appointments').push({
    appointment_id: 'ap-class', creator_id: ME, title: '캡스톤 수업', appointment_at: '2026-10-29T10:00:00+09:00', dest_name: '공학관', importance: 'NORMAL', recurrence_rule: null,
  });
  db.rows('appointment_participants').push({
    participant_id: 'pt-class', appointment_id: 'ap-class', user_id: ME, transport_type: 'SUBWAY', est_travel_minutes: 30,
    departed_at: '2026-10-29T08:40:00+09:00', departed_source: 'LOCATION', arrived_at: '2026-10-29T10:07:00+09:00', arrived_source: 'LOCATION', is_late: false, late_minutes: null,
  });
  db.rows('alarms').push({ alarm_id: 'al-dep', user_id: ME, participant_id: 'pt-class', routine_id: null, alarm_type: 'DEPARTURE', scheduled_at: '2026-10-29T08:00:00+09:00', intensity: 'NORMAL', is_enabled: true, time_source: 'AUTO' });
  db.rows('alarm_events').push(
    { event_id: 2, alarm_id: 'al-dep', user_id: ME, event_type: 'ACKNOWLEDGED', event_at: '2026-10-29T07:45:00+09:00', input_source: 'LOCATION' },
    { event_id: 3, alarm_id: 'al-dep', user_id: ME, event_type: 'ACKNOWLEDGED', event_at: '2026-10-29T08:40:00+09:00', input_source: 'LOCATION' },
  );
  return db;
}

function depsOf(db: FakeDb, script: FakeScript | null, extra: Partial<VoiceDeps> = {}) {
  const claude = script === null ? null : fakeClaude(script);
  let t = 0;
  const deps: VoiceDeps = {
    userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: claude?.client ?? null, model: 'claude-haiku-5-5',
    // 이 파일의 녹화 대본은 T2F ∥ T1 미리(동시) 순서로 짜여 있음 — 기본(차례로) 흐름은 voice.quota.test.ts
    now: () => NOW, clock: () => (t += 40), sleep: async () => {}, parallelPreview: true, ...extra,
  };
  return { deps, claude };
}

const stateOf = (db: FakeDb, sessionId: string): ServerState => (db.rows('conversation_sessions').find((s) => s.session_id === sessionId) as { server_state: ServerState }).server_state;
const turnsOf = (db: FakeDb, sessionId: string) => (db.rows('conversation_sessions').find((s) => s.session_id === sessionId) as { turns: { role: string; text: string; source?: string; guard?: string[] }[] }).turns;

async function failure(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof HttpError, `HttpError여야 하는데 ${String(e)}`);
    return e;
  }
  assert.fail('오류가 나야 함');
}

const text = (sessionId: string, rev: number, t: string, id = cid()) => ({ session_id: sessionId, rev, client_turn_id: id, text: t });

// ───────── 한 바퀴 ─────────

test('녹화 한 바퀴: 첫 마디 템플릿 → 새 약속 카드 → 계산 결과 → 응(강조) → 저장 → 도착 정정', async () => {
  const db = seed();
  const script: FakeScript = {
    T2F: [t2f('new_appt'), t2f('yes'), t2f('arrive_fix')],
    T1: [
      t1('preview'), // ③ 미리 부른 T1 — 앱 일이 있어 버림
      t1('propose'), // ④ results 뒤 T1
      t1('preview'), t1('claims_saved'), t1('ask_card'), // ⑤ 미리 · 첫 답("저장했어요" → 가드가 지움) · 다시
      t1('saved'), // ⑥ 카드 저장 뒤
      t1('preview'), t1('arrive_fixed'), // ⑦ 미리 · results 뒤
    ],
  };
  const { deps, claude } = depsOf(db, script);

  // ① ② 세션 — 템플릿 첫 마디, LLM 0번 · ai_calls 0줄
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  assert.equal(s.resumed, false);
  assert.equal(s.rev, 1);
  assert.equal(s.turn_seq, 0);
  assert.deepEqual(s.day, { review: '2026-10-29', morning: '2026-10-30' });
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, 'ai');
  const hello = s.messages[0].text;
  assert.match(hello, /오전 7시 45분에 잠깐 나갔다 들어왔고/); // 앞 출발
  assert.match(hello, /오전 8시 40분에 출발해서/); // 출발
  assert.match(hello, /오전 10시 7분에 도착했어요/); // 도착
  assert.doesNotMatch(hello, /일어났/); // 기상 기록은 안 읽음 (헤드 10/30 — 대화로 기상을 고칠 길이 생기면)
  assert.match(hello, /틀린 게 있으면 말해 주세요\.$/);
  assert.doesNotMatch(hello, /지각/); // 지각 말 없음
  assert.deepEqual(s.limits, { turns_left: MAX_USER_TURNS, sessions_left_today: 4, reached: null });
  assert.equal(db.rows('ai_calls').length, 0);
  assert.equal(claude!.order.length, 0);
  const sid = s.session_id as string;
  const st0 = stateOf(db, sid);
  assert.deepEqual(st0.confirm, ['f1', 'f3', 'f4']); // 앞 출발 · 출발 · 도착 (기상은 안 읽음, 앞 출발이 도착을 밀어내지 않음)
  assert.deepEqual(st0.ctx.today.facts.map((f) => [f.id, f.kind, f.time]), [['f1', 'DEPART', '07:45'], ['f2', 'WAKE', '08:12'], ['f3', 'DEPART', '08:40'], ['f4', 'ARRIVE', '10:07']]);
  assert.equal(st0.ctx.today.facts.some((f) => f.kind === 'LATE'), false);

  // 같은 날 다시 열면 그대로(resume) — 하루 대화 수에 안 셈
  const again = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true });
  assert.equal(again.resumed, true);
  assert.equal(again.session_id, sid);
  assert.equal(again.limits.sessions_left_today, 4);

  // ③ 새 약속 — 카드 c1 NEEDS_ESTIMATE, 앱 일 → APP_TASKS, 답 없음
  const id1 = cid();
  const r1 = (await handleVoiceTurn(deps, text(sid, 1, '내일 10시 강남역에서 캡스톤 발표 있어', id1))) as VoiceTurnOut;
  assert.equal(r1.next, 'APP_TASKS');
  assert.equal(r1.reply, null);
  assert.equal(r1.rev, 2);
  assert.equal(r1.turn_seq, 1);
  assert.equal(r1.cards.length, 1);
  assert.deepEqual([r1.cards[0].id, r1.cards[0].kind, r1.cards[0].status, r1.cards[0].first_of_day], ['c1', 'APPT_NEW', 'NEEDS_ESTIMATE', true]);
  assert.equal(r1.cards[0].summary, '10/30(금) 10:00 캡스톤 발표 · 강남역');
  assert.equal(r1.cards[0].draft?.importance, 'HIGH'); // 서버 키워드 사전(발표)
  assert.deepEqual(r1.fixes, []);
  // 받은 화면: 확인할 기록 줄은 T1 화면에만, T2F는 기본 화면
  assert.match(claude!.seen.T1[0], /확인할 기록\(서버가 고름\): f1 · f3 · f4/);
  assert.match(claude!.seen.T1[0], /사용자 말 1 뒤:\n- 바뀐 것 없음/);
  assert.doesNotMatch(claude!.seen.T2F[0], /확인할 기록/);
  assert.match(claude!.seen.T2F[0], /서버 처리 결과 없음/);
  assert.match(claude!.seen.T2F[0], /지민 1: 내일 10시 강남역에서 캡스톤 발표 있어/);
  assert.equal(turnsOf(db, sid).length, 2); // 첫 마디 + 사용자 말 (답은 아직)

  // ④ results — 확인 필요 줄 · CONFIRM c1
  const r2 = await handleVoiceTurn(deps, { session_id: sid, rev: r1.rev, client_turn_id: id1, results: { cards: [{ id: 'c1', status: 'READY', estimate: DATA.results.wake_0740, error: null }], fixes: [] } });
  assert.equal(r2.next, 'USER');
  assert.equal(r2.reply?.text, '발표라 오전 7시 40분에 강하게 깨우는 알람으로 저장할까요?');
  assert.deepEqual(r2.reply?.acts, [{ type: 'CONFIRM', ref: 'c1' }]);
  assert.equal(r2.cards[0].status, 'READY');
  assert.equal(r2.rev, 3);
  assert.match(claude!.seen.T1[1], /- 확인 필요 \[c1\] 일정: 10\/30\(금\) 오전 10시 캡스톤 발표 · 강남역 · 중요도 매우 중요 · 알람 기상 오전 7시 40분 강하게 · 카드의 \[저장\]으로 저장/);

  // ⑤ 말 "응" — 카드 강조만, 녹화 답 "저장했어요"는 가드가 지우고 T1을 다시
  const r3 = await handleVoiceTurn(deps, text(sid, r2.rev, '응'));
  assert.equal(r3.cards[0].highlight, true);
  assert.equal(r3.cards[0].status, 'READY'); // 저장 아님
  assert.equal(r3.reply?.text, '알겠어요. 카드의 저장 버튼을 눌러 주세요.');
  assert.equal(db.rows('appointments').length, 1); // 서버는 약속을 저장하지 않음 (시드의 수업 하나뿐)
  const aiLine = turnsOf(db, sid).filter((t) => t.role === 'ai').at(-1) as { source?: string; guard?: string[] };
  assert.equal(aiLine.source, 't1_regen');
  assert.ok(aiLine.guard?.includes('regen'));
  assert.match(claude!.seen.T1.at(-1) as string, /- 확인 필요 \[c1\]/); // 확인 필요 줄을 다시 보여 줌

  // ⑥ 카드 [저장] — 저장됨 + 새 알람, alarm_relay_missing 없음
  const apptId = '11111111-1111-4111-8111-111111111111';
  const r4 = await handleVoiceTurn(deps, {
    session_id: sid, rev: r3.rev, client_turn_id: cid(),
    card_action: { id: 'c1', action: 'SAVED', appointment_id: apptId, alarms: [{ kind: 'WAKE', at: '2026-10-30T07:40:00+09:00', enabled: true, level: 2 }, { kind: 'PREPARE', at: '2026-10-30T07:50:00+09:00', enabled: true, level: 2 }] },
  });
  assert.equal(r4.cards[0].status, 'SAVED');
  assert.equal(r4.reply?.text, '저장했어요. 내일 오전 7시 40분에 강하게 깨울게요.');
  const seenSaved = claude!.seen.T1.at(-1) as string;
  assert.match(seenSaved, /- 저장됨: 일정 저장: /);
  assert.match(seenSaved, /- 새 알람: \[al\d+\] 기상 .*오전 7시 40분.*강하게/);
  assert.match(seenSaved, /- 저장됨: 그 밖의 알람\(준비\)도 같이 맞춤/);
  const savedLine = db.rows('conversation_sessions')[0].turns as { guard?: string[]; flags?: string[] }[];
  assert.ok(!savedLine.at(-1)?.flags?.includes('alarm_relay_missing'));
  assert.equal(stateOf(db, sid).refs.appointments['a3']?.appointment_id ?? stateOf(db, sid).refs.appointments['a2']?.appointment_id, apptId); // 앱이 알려 준 id가 별칭 풀이표에

  // ⑦ "도착은 10시 20분이었어" — 정정 x1 → results ok → "도착 시각 10:20으로 정정"
  const id7 = cid();
  const r5 = await handleVoiceTurn(deps, text(sid, r4.rev, '도착은 10시 20분이었어', id7));
  assert.equal(r5.next, 'APP_TASKS');
  assert.equal(r5.reply, null);
  assert.deepEqual(r5.fixes, [{ id: 'x1', fact: 'f4', kind: 'ARRIVE', participant_id: 'pt-class', action: 'CORRECT', to: '2026-10-29T10:20:00+09:00' }]);
  assert.equal(r5.cards.length, 1); // 카드는 세션의 전체 목록(저장된 c1 포함)
  const r6 = await handleVoiceTurn(deps, { session_id: sid, rev: r5.rev, client_turn_id: id7, results: { cards: [], fixes: [{ id: 'x1', ok: true, error: null }] } });
  assert.equal(r6.reply?.text, '도착 시각을 10시 20분으로 고쳤어요.');
  assert.match(claude!.seen.T1.at(-1) as string, /- 저장됨: 도착 시각 오전 10시 20분으로 정정/);
  assert.equal(r6.limits.turns_left, MAX_USER_TURNS - 3); // 사용자 말 3개

  // ai_calls — 지점 · 토큰 · 지연이 남음, 일반 사용자라 io는 NULL
  const calls = db.rows('ai_calls');
  assert.equal(calls.length, claude!.order.length);
  assert.deepEqual(new Set(calls.map((c) => c.point)), new Set(['T1', 'T2F']));
  for (const c of calls) {
    assert.equal(c.user_id, ME);
    assert.equal(c.session_id, sid);
    assert.equal(c.ok, true);
    assert.ok((c.input_tokens as number) > 0 && (c.output_tokens as number) > 0, '토큰');
    assert.ok((c.latency_ms as number) > 0, '지연');
    assert.equal(c.io, null);
    assert.equal(c.prompt_version, c.point === 'T1' ? 'v1.6' : 'v2-e');
  }
  const flagged = calls.filter((c) => (c.flags as string[]).length > 0);
  assert.ok(flagged.some((c) => (c.flags as string[]).includes('claims_saved_without_event')), '가드에 걸린 호출의 flags');
  assert.equal(claude!.left('T1'), 0);
  assert.equal(claude!.left('T2F'), 0);
});

// ───────── 같은 일정 연속 변경 ─────────

test('대화에서 만든 일정을 연달아 바꿈: 모델 화면(T2F · T1)이 방금 바꾼 값을 보고, 바꿀 때마다 새 변경 카드(변경 전 = 마지막 저장 값) · 같은 일정 id 유지', async () => {
  const db = new FakeDb();
  db.now = NOW;
  db.rows('profiles').push({ user_id: ME, nickname: '지민', timezone: 'Asia/Seoul' });
  const appt = (ref: string | null, time: string) => ({
    appointments: [{ ref, title: '캡스톤 회의', date: '2026-10-30', time, place: null, importance: null, transport: null, repeat: null, save: 'UNCONFIRMED', unclear: null }],
    alarm_changes: [], fact_feedback: [], prep_adjustment: null, safety_flag: false,
  });
  const ok = { reply: '네.', acts: [], end: false };
  const { deps, claude } = depsOf(db, { T2F: [appt(null, '10:30'), appt('a1', '13:00'), appt('a1', '14:00'), appt('a1', '15:00')], T1: Array(8).fill(ok) }, { parallelPreview: false });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const apptId = '22222222-2222-4222-8222-222222222222';
  const save = (rev: number, id: string, wake: string) =>
    handleVoiceTurn(deps, { session_id: sid, rev, client_turn_id: cid(), card_action: { id, action: 'SAVED', appointment_id: apptId, alarms: [{ kind: 'WAKE', at: `2026-10-30T${wake}:00+09:00`, enabled: true, level: 1 }] } });

  // 1) 새 일정 → 계산 → 저장 (a1)
  const id1 = cid();
  let r = await handleVoiceTurn(deps, text(sid, s.rev, '내일 캡스톤 회의 10시 반에 있어', id1));
  r = await handleVoiceTurn(deps, { session_id: sid, rev: r.rev, client_turn_id: id1, results: { cards: [{ id: 'c1', status: 'READY', estimate: { alarms: [{ kind: 'WAKE', at: '2026-10-30T08:00:00+09:00', enabled: true }], level: 1, with_wake: true } }], fixes: [] } });
  r = await save(r.rev, 'c1', '08:00');
  assert.match(claude!.seen.T2F[0] as string, /### 내일 일정\n내일 일정 없음/);

  // 2) ~ 4) 같은 일정을 세 번 바꿈 — 횟수 제한 없음
  const steps = [['오후 1시', '10:30', '13:00', '10:30'], ['오후 2시', '13:00', '14:00', '11:00'], ['오후 3시', '14:00', '15:00', '12:00']] as const;
  for (const [i, [say, from, to, wake]] of steps.entries()) {
    r = await handleVoiceTurn(deps, text(sid, r.rev, `방금 만든 캡스톤 회의 시간을 ${say}로 바꿔줘`));
    // T2F는 세션 시작 스냅숏이 아니라 대화의 지금 일정(마지막 저장 값 · 같은 별칭)을 봄
    const screen = claude!.seen.T2F[i + 1] as string;
    assert.match(screen, new RegExp(`\\[a1\\] 10-30\\(금\\) ${from} 캡스톤 회의`), screen);
    const open = r.cards.filter((c) => c.status === 'READY');
    assert.equal(open.length, 1, `${say}: 변경 카드가 하나 생겨야 함`);
    const card = open[0] as (typeof r.cards)[number];
    assert.deepEqual([card.id, card.kind], [`c${i + 2}`, 'APPT_OPEN']);
    assert.deepEqual(card.edit, { appointment_id: apptId, changes: { time: to }, before: { title: '캡스톤 회의', time: from } });
    assert.notEqual(r.reply?.text, '네, 알겠어요.');
    r = await save(r.rev, card.id, wake);
    const st = stateOf(db, sid);
    assert.deepEqual(st.core.appointments.map((a) => [a.ref, a.time]), [['a1', to]], '새 일정 없이 같은 일정만 바뀜');
    assert.deepEqual(st.core.alarms.filter((a) => a.type === 'WAKE').map((a) => [a.appointment_ref, a.time]), [['a1', wake]], '알람도 같은 일정에 다시 맞춤');
    assert.equal(st.refs.appointments['a1']?.appointment_id, apptId);
    // 저장 뒤 T1도 바뀐 값을 봄
    assert.match(claude!.seen.T1.at(-1) as string, new RegExp(`\\[a1\\][^\\n]*캡스톤 회의`));
  }
  assert.equal(claude!.left('T2F'), 0);
});

test('바꿔 달라는데 바뀐 게 없음: 답은 "네, 알겠어요." · "바꿨어요"가 아니라 서버가 되묻거나(값 모름) 지금 설정을 알림(이미 그 값)', async () => {
  const db = new FakeDb();
  db.now = NOW;
  db.rows('profiles').push({ user_id: ME, nickname: '지민', timezone: 'Asia/Seoul' });
  const none = { appointments: [], alarm_changes: [], fact_feedback: [], prep_adjustment: null, safety_flag: false };
  const appt = (time: string) => ({ ...none, appointments: [{ ref: null, title: '캡스톤 회의', date: '2026-10-30', time, place: null, importance: null, transport: null, repeat: null, save: 'UNCONFIRMED', unclear: null }] });
  const say = (reply: string) => ({ reply, acts: [], end: false });
  const { deps } = depsOf(db, { T2F: [appt('10:30'), none, appt('10:30')], T1: [say('네.'), say('네.'), say('네, 바꿨어요.'), say('네, 바꿨어요.'), say('네, 알겠어요.')] }, { parallelPreview: false });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const id1 = cid();
  let r = await handleVoiceTurn(deps, text(sid, s.rev, '내일 캡스톤 회의 10시 반에 있어', id1));
  r = await handleVoiceTurn(deps, { session_id: sid, rev: r.rev, client_turn_id: id1, results: { cards: [{ id: 'c1', status: 'READY', estimate: { alarms: [{ kind: 'WAKE', at: '2026-10-30T08:00:00+09:00', enabled: true }], level: 1, with_wake: true } }], fixes: [] } });
  r = await handleVoiceTurn(deps, { session_id: sid, rev: r.rev, client_turn_id: cid(), card_action: { id: 'c1', action: 'SAVED', appointment_id: '33333333-3333-4333-8333-333333333333', alarms: [] } });

  // 추출이 변경을 못 뽑음 — T1의 "바꿨어요"(처리 결과 없음)는 지우고 서버가 지금 값과 함께 되물음
  r = await handleVoiceTurn(deps, text(sid, r.rev, '방금 만든 캡스톤 회의 시간 바꿔줘'));
  assert.equal(r.reply?.text, "지금 '캡스톤 회의' 일정은 10/30(금) 오전 10시 30분이에요. 언제로 바꿀까요?");
  assert.deepEqual(r.cards.filter((c) => c.status === 'READY'), []);

  // 이미 그 값 — 카드 없이 지금 설정
  r = await handleVoiceTurn(deps, text(sid, r.rev, '캡스톤 회의 10시 반으로 바꿔줘'));
  assert.equal(r.reply?.text, "'캡스톤 회의' 일정은 이미 10/30(금) 오전 10시 30분으로 되어 있어요.");
  assert.deepEqual(r.cards.filter((c) => c.status === 'READY'), []);
  assert.deepEqual(stateOf(db, sid).core.appointments.map((a) => [a.ref, a.time]), [['a1', '10:30']]);
});

// ───────── rev 충돌 · 재시도 ─────────

test('rev가 다르면 CONFLICT, 같은 client_turn_id는 저장한 답을 그대로 (말이 두 번 쌓이지 않음 · 모델 안 부름)', async () => {
  const db = seed();
  const { deps, claude } = depsOf(db, { T2F: [t2f('empty')], T1: [t1('chat')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;

  const stale = await failure(handleVoiceTurn(deps, text(sid, 99, '안녕')));
  assert.equal(stale.code, 'CONFLICT');
  assert.equal(turnsOf(db, sid).length, 1);

  const id = cid();
  const first = await handleVoiceTurn(deps, text(sid, 1, '오늘 하루 괜찮았어', id));
  assert.equal(first.reply?.text, '좋은 하루였다니 다행이에요. 푹 주무시고 내일 발표도 잘 준비해요.');
  assert.equal(first.rev, 2);
  const calls = claude!.order.length;
  const retry = await handleVoiceTurn(deps, text(sid, 1, '오늘 하루 괜찮았어', id)); // 같은 id · 같은 (옛) rev
  assert.deepEqual(retry, first);
  assert.equal(claude!.order.length, calls); // 모델을 또 부르지 않음
  assert.equal(turnsOf(db, sid).filter((t) => t.role === 'user').length, 1);

  // 먼저 도착한 요청이 rev를 올리면 같은 rev로 온 다른 요청은 CONFLICT
  const loser = await failure(handleVoiceTurn(deps, text(sid, 1, '또 다른 말')));
  assert.equal(loser.code, 'CONFLICT');
});

test('T1 실패 → LLM_UNAVAILABLE(details: cards · fixes), 상태는 남고 같은 client_turn_id 재시도는 T1만 다시', async () => {
  const db = seed();
  const boom = new Error('boom');
  const { deps, claude } = depsOf(db, { T2F: [t2f('new_appt')], T1: [boom, boom, t1('propose')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  // 말 → 앱 일 → results (T1 미리는 실패해도 앱 일 턴에선 안 씀)
  const id = cid();
  const r1 = await handleVoiceTurn(deps, text(sid, 1, '내일 10시 강남역에서 캡스톤 발표 있어', id));
  assert.equal(r1.next, 'APP_TASKS');
  const body = { session_id: sid, rev: r1.rev, client_turn_id: id, results: { cards: [{ id: 'c1', status: 'READY', estimate: DATA.results.wake_0740, error: null }], fixes: [] } };
  const e = await failure(handleVoiceTurn(deps, body)); // T1 실패
  assert.equal(e.code, 'LLM_UNAVAILABLE');
  const details = e.details as { cards: { id: string; status: string }[]; fixes: unknown[]; code: string };
  assert.deepEqual(details.cards.map((c) => [c.id, c.status]), [['c1', 'READY']]);
  assert.equal(details.code, 'UPSTREAM');
  assert.doesNotMatch(JSON.stringify(e.details), /boom/); // 공급자 원문은 응답에 없음
  assert.equal(stateOf(db, sid).cards[0].status, 'READY'); // 상태는 남음
  assert.equal(turnsOf(db, sid).filter((t) => t.role === 'ai').length, 1); // 답은 없음
  const failed = db.rows('ai_calls').filter((c) => c.ok === false);
  assert.ok(failed.length >= 1 && failed.every((c) => c.error_code === 'UPSTREAM'));

  // 같은 요청(같은 rev · 같은 client_turn_id) 다시 → T1만
  const before = claude!.order.length;
  const ok = await handleVoiceTurn(deps, body);
  assert.equal(ok.reply?.text, '발표라 오전 7시 40분에 강하게 깨우는 알람으로 저장할까요?');
  assert.deepEqual(claude!.order.slice(before), ['T1']); // T2F는 안 부름
  assert.equal(stateOf(db, sid).owed, null);
  assert.equal(turnsOf(db, sid).filter((t) => t.role === 'user').length, 1);
  // 또 보내도 저장한 답
  assert.deepEqual(await handleVoiceTurn(deps, body), ok);
});

// ───────── 상한 ─────────

test('상한(100)을 넘는 말은 모델을 안 부르고 대화 길이 템플릿 + limits.reached TURN, 하루 6번째 세션은 session_id null + DAY', async () => {
  const db = seed();
  const script: FakeScript = { T2F: Array.from({ length: MAX_USER_TURNS }, () => t2f('empty')), T1: Array.from({ length: MAX_USER_TURNS }, () => t1('chat')) };
  const { deps, claude } = depsOf(db, script);
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  let rev = 1;
  let last: VoiceTurnOut | null = null;
  for (let i = 1; i <= MAX_USER_TURNS; i++) {
    last = await handleVoiceTurn(deps, text(sid, rev, `말 ${i}`));
    rev = last.rev;
  }
  assert.equal(last?.limits.turns_left, 0);
  assert.equal(last?.limits.reached, 'TURN'); // 마지막(100번째) 답에서 이미 알림
  // 긴 대화도 T1 · T2F에는 최근 줄만 (입력 토큰 · 비용이 대화 길이에 따라 끝없이 늘지 않게) — 번호는 대화 전체 기준
  for (const point of ['T1', 'T2F'] as const) {
    const screen = claude!.seen[point].at(-1) ?? '';
    assert.match(screen, /\(앞 대화 \d+줄 생략\)/);
    assert.match(screen, new RegExp(`${MAX_USER_TURNS}: 말 ${MAX_USER_TURNS}$`, 'm'));
    assert.doesNotMatch(screen, /: 말 1$/m);
  }
  const calls = claude!.order.length;
  const over = await handleVoiceTurn(deps, text(sid, rev, '백한 번째'));
  assert.equal(over.reply?.text, LIMIT_TURN_TEXT);
  assert.match(LIMIT_TURN_TEXT, /대화가 길어져서.*내일 새 대화/); // 대화 길이 제한 — 하루 · 분당 제한과 다른 글
  assert.equal(over.limits.reached, 'TURN');
  assert.equal(over.rev, rev); // 저장하지 않음
  assert.equal(claude!.order.length, calls);
  assert.equal(turnsOf(db, sid).filter((t) => t.role === 'user').length, MAX_USER_TURNS);

  // 하루 5대화: 이미 4개를 끝냈다고 보고 5번째(= 이 세션)까지, 6번째는 막힘
  for (let i = 0; i < 3; i++) db.rows('conversation_sessions').push({ session_id: `old-${i}`, user_id: ME, session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', started_at: '2026-10-29T09:00:00+09:00', ended_at: '2026-10-29T09:10:00+09:00', turns: [], server_state: {} });
  const fifth = db.rows('conversation_sessions').find((r) => r.session_id === sid) as { ended_at: string | null };
  fifth.ended_at = '2026-10-29T20:40:00+09:00'; // 이어 받지 않게 끝냄
  const sixthTry = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' }); // 이게 5번째 (4개 뒤)
  assert.ok(sixthTry.session_id !== null);
  assert.equal(sixthTry.limits.sessions_left_today, 0);
  (db.rows('conversation_sessions').find((r) => r.session_id === sixthTry.session_id) as { ended_at: string | null }).ended_at = '2026-10-29T20:50:00+09:00';
  const blocked = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.equal(blocked.session_id, null);
  assert.deepEqual(blocked.limits, { turns_left: 0, sessions_left_today: 0, reached: 'DAY' });
  assert.equal(db.rows('conversation_sessions').length, 5);
});

test('하루 AI 호출 300 넘으면 새 세션을 안 만들고 DAY (앱이 세션 줄을 지워도 못 줄임)', async () => {
  const db = seed();
  for (let i = 0; i < 300; i++) db.rows('ai_calls').push({ call_id: `c${i}`, user_id: ME, point: 'T1', created_at: '2026-10-29T10:00:00+09:00' });
  const { deps } = depsOf(db, null);
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.equal(s.session_id, null);
  assert.equal(s.limits.reached, 'DAY');
});

// ───────── 키 없음 ─────────

test('키가 없으면 voice-session은 세션 + 템플릿 첫 마디, voice-turn은 NOT_CONFIGURED (말을 쌓지 않음)', async () => {
  const db = seed();
  const { deps } = depsOf(db, null);
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.ok(s.session_id);
  assert.match(s.messages[0].text, /틀린 게 있으면 말해 주세요/);
  const e = await failure(handleVoiceTurn(deps, text(s.session_id as string, 1, '안녕')));
  assert.equal(e.code, 'NOT_CONFIGURED');
  assert.equal(e.status, 503);
  assert.equal(turnsOf(db, s.session_id as string).length, 1);
  assert.equal(db.rows('ai_calls').length, 0);
});

// ───────── 자정 세션 ─────────

test('00:30에 연 대화: 오늘 기상 기록이 없으면 전날 밤 — 오늘 = 10/29, 내일 = 10/30', async () => {
  const now = new Date('2026-10-30T00:30:00+09:00');
  const db = seed(now);
  const { deps } = depsOf(db, null, { now: () => now });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.deepEqual(s.day, { review: '2026-10-29', morning: '2026-10-30' });
  assert.match(s.messages[0].text, /오전 10시 7분에 도착했어요/); // 어제(대화의 오늘) 기록
  const st = stateOf(db, s.session_id as string);
  assert.equal(st.ctx.dates.today, '2026-10-29');
  assert.equal(st.ctx.dates.tomorrow, '2026-10-30');
  assert.equal(st.ctx.session.now, '2026-10-30T00:30:00+09:00');

  // 같은 밤에 이어 받음 — 달력은 10/30이지만 같은 대화 기준일
  const same = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.equal(same.resumed, true);
  assert.equal(same.session_id, s.session_id);
});

test('기상 기록과 상관없음: 00:30에 오늘 기상 기록이 있어도 기준일은 전날(10/29), 04:00부터 10/30', async () => {
  const now = new Date('2026-10-30T00:30:00+09:00');
  const db = seed(now);
  db.rows('daily_records').push({ record_id: 'r2', user_id: ME, record_date: '2026-10-30', wake_confirmed_at: '2026-10-30T00:10:00+09:00' });
  const { deps } = depsOf(db, null, { now: () => now });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.deepEqual(s.day, { review: '2026-10-29', morning: '2026-10-30' });
  const at4 = new Date('2026-10-30T04:00:00+09:00');
  const s4 = await handleVoiceSession(depsOf(db, null, { now: () => at4 }).deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.deepEqual(s4.day, { review: '2026-10-30', morning: '2026-10-31' });
});

// ───────── 위기 턴 ─────────

test('위기 턴: 위기 안내 필요 줄 → 109 문장은 통과, 앱 일은 다음 턴으로 미룸(next USER)', async () => {
  const db = seed();
  const { deps, claude } = depsOf(db, { T2F: [t2f('crisis')], T1: [t1('preview'), t1('crisis')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const r = await handleVoiceTurn(deps, text(sid, 1, '다 의미 없는 것 같아'));
  assert.equal(r.next, 'USER');
  assert.match(r.reply?.text ?? '', /109/);
  assert.match(claude!.seen.T1[1], /- 위기 안내 필요: /);
  const line = turnsOf(db, sid).at(-1) as { guard?: string[]; flags?: string[] };
  assert.ok(!line.flags?.includes('hotline_without_risk'));
  assert.equal(stateOf(db, sid).core.crisisNotified, true);
});

test('위기 (헤드 10/30 B안): 위기 말이 두 턴 이어지면 두 턴 다 위기 안내 줄 + 109 통과', async () => {
  const db = seed();
  const { deps, claude } = depsOf(db, { T2F: [t2f('crisis'), t2f('crisis')], T1: [t1('preview'), t1('crisis'), t1('preview'), t1('crisis')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const r1 = await handleVoiceTurn(deps, text(sid, 1, '다 의미 없는 것 같아'));
  const r2 = await handleVoiceTurn(deps, text(sid, r1.rev, '계속 사라지고 싶어'));
  assert.match(r1.reply?.text ?? '', /109/);
  assert.match(r2.reply?.text ?? '', /109/, '둘째 위기 턴의 109도 되풀이로 안 지움');
  // 둘째 턴 T1 화면: 이번 턴은 위기 안내 필요, 앞 턴은 이미 함
  const last = claude!.seen.T1.at(-1) as string;
  assert.match(last, /사용자 말 1 뒤:\n- 위기 안내: 이미 함/);
  assert.match(last, /사용자 말 2 뒤:\n- 위기 안내 필요: /);
  const lines = turnsOf(db, sid).filter((t) => t.role === 'ai') as { source?: string; guard?: string[]; flags?: string[] }[];
  assert.ok(lines.slice(1).every((l) => l.source === 't1' && !(l.flags ?? []).includes('hotline_repeat')));
});

test('위기 (헤드 10/30 B안): 위기 말 한 번 뒤 평범한 말에는 109를 되풀이하지 않음 (가드가 지움)', async () => {
  const db = seed();
  const { deps } = depsOf(db, { T2F: [t2f('crisis'), t2f('empty')], T1: [t1('preview'), t1('crisis'), t1('crisis_repeat')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const r1 = await handleVoiceTurn(deps, text(sid, 1, '다 의미 없는 것 같아'));
  assert.match(r1.reply?.text ?? '', /109/);
  const r2 = await handleVoiceTurn(deps, text(sid, r1.rev, '아니야 그냥 피곤해서'));
  assert.equal(r2.reply?.text, '푹 쉬어요. 많이 힘드셨겠어요.'); // 109 문장만 지워짐
  const line = turnsOf(db, sid).at(-1) as { guard?: string[]; flags?: string[] };
  assert.ok(line.flags?.includes('hotline_repeat'));
  assert.ok(line.guard?.includes('drop_sentence'));
});

test("위기 (헤드 10/30): T2F 실패 턴은 위험 판단 '모름' — 이미 안내한 대화에서도 모델이 낸 109 문장을 안 지움", async () => {
  const db = seed();
  const { deps } = depsOf(db, { T2F: [t2f('crisis'), upstreamError(), upstreamError()], T1: [t1('preview'), t1('crisis'), t1('crisis_repeat')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const r1 = await handleVoiceTurn(deps, text(sid, 1, '다 의미 없는 것 같아'));
  assert.match(r1.reply?.text ?? '', /109/);
  const r2 = await handleVoiceTurn(deps, text(sid, r1.rev, '아무것도 하기 싫어')); // 이 턴 T2F 실패
  assert.equal(r2.reply?.text, '푹 쉬어요. 많이 힘드셨겠어요. 힘들 땐 109(자살예방 상담전화)에 언제든 전화할 수 있어요.'); // 109 문장이 남음
  const line = turnsOf(db, sid).at(-1) as { source?: string; guard?: string[]; flags?: string[] };
  assert.equal(line.source, 't1');
  assert.ok(!(line.flags ?? []).includes('hotline_repeat'));
  assert.ok(!(line.guard ?? []).includes('drop_sentence'));
  // 모름은 위기 안내 줄이 아님 — 이벤트에 표시만 남음
  const ev2 = stateOf(db, sid).events.find((e) => e.after_turn === 2);
  assert.equal(ev2?.risk_unknown, true);
  assert.notEqual(ev2?.crisis, true);
});

test("위기 (헤드 10/30): T2F 실패 턴에 모델 답에 109가 없으면 서버가 109를 새로 붙이지 않음", async () => {
  const db = seed();
  const { deps } = depsOf(db, { T2F: [upstreamError(), upstreamError()], T1: [t1('chat')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const r = await handleVoiceTurn(deps, text(sid, 1, '오늘 하루 괜찮았어'));
  assert.equal(r.reply?.text, '좋은 하루였다니 다행이에요. 푹 주무시고 내일 발표도 잘 준비해요.');
  assert.doesNotMatch(r.reply?.text ?? '', /109/);
  const line = turnsOf(db, sid).at(-1) as { guard?: string[]; flags?: string[] };
  assert.deepEqual(line.guard ?? [], []);
  assert.deepEqual(line.flags ?? [], []);
});

// ───────── 질문 예산 ─────────

function seedTomorrow(db: FakeDb) {
  db.rows('appointments').push({ appointment_id: 'ap-t', creator_id: ME, title: '캡스톤 발표', appointment_at: '2026-10-30T10:00:00+09:00', dest_name: '강남역', importance: 'HIGH', recurrence_rule: null });
  db.rows('appointment_participants').push({ participant_id: 'pt-t', appointment_id: 'ap-t', user_id: ME, transport_type: 'SUBWAY', est_travel_minutes: 50, departed_at: null, departed_source: null, arrived_at: null, arrived_source: null, is_late: null, late_minutes: null });
  db.rows('alarms').push({ alarm_id: 'al-t', user_id: ME, participant_id: 'pt-t', routine_id: null, alarm_type: 'WAKE', scheduled_at: '2026-10-30T07:40:00+09:00', intensity: 'STRONG', is_enabled: true, time_source: 'AUTO' });
}
// 읽어 줄 기록이 없는 날(기상 기록만 확정 입력) — 서버 질문이 첫 마디가 됨
function seedNoAutoFacts(db: FakeDb) {
  db.tables.alarm_events = [];
  db.tables.appointment_participants = db.rows('appointment_participants').filter((p) => p.participant_id !== 'pt-class');
  db.tables.appointments = db.rows('appointments').filter((p) => p.appointment_id !== 'ap-class');
  db.rows('daily_records')[0].wake_confirmed_at = '2026-10-29T08:12:00+09:00';
  db.rows('alarm_events').push({ event_id: 9, alarm_id: 'al-wake', user_id: ME, event_type: 'WAKE_CONFIRMED', event_at: '2026-10-29T08:12:00+09:00', input_source: 'BUTTON' });
}

test('질문 예산: 기록이 없고 질문 조건이 맞으면 질문이 첫 마디 + user_questions 한 줄, 같은 날 둘째 대화는 질문 없음', async () => {
  const db = seed();
  seedNoAutoFacts(db);
  seedTomorrow(db);
  const { deps } = depsOf(db, null);
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.equal(s.messages[0].text, '내일 10:00 캡스톤 발표 준비가 평소보다 더 걸릴 것 같아요?');
  const q = db.rows('user_questions');
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].channel, q[0].kind, q[0].subject_key, q[0].session_id, q[0].user_id], ['CHAT', 'PREP_CHECK', 'PREP_CHECK:2026-10-30|캡스톤발표', s.session_id, ME]);
  assert.deepEqual(turnsOf(db, s.session_id as string)[0], { ...turnsOf(db, s.session_id as string)[0], source: 'template' });
  assert.deepEqual(stateOf(db, s.session_id as string).question?.asked_at, '2026-10-29T20:30:00+09:00');

  // 하루 1개 — 이 대화를 끝내고 다시 열면 질문 없음("오늘 하루는 어땠어요?")
  (db.rows('conversation_sessions')[0] as { ended_at: string | null }).ended_at = '2026-10-29T20:40:00+09:00';
  const second = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.match(second.messages[0].text, /오늘 하루는 어땠어요\?$/);
  assert.equal(db.rows('user_questions').length, 1);
});

test('질문 예산: 7일에 3개를 이미 물었으면 안 묻고, 같은 일정을 24시간 안에 다시 안 물음', async () => {
  const week = seed();
  seedNoAutoFacts(week);
  seedTomorrow(week);
  for (const [i, day] of ['2026-10-23', '2026-10-25', '2026-10-27'].entries()) {
    week.rows('user_questions').push({ question_id: `q${i}`, user_id: ME, channel: 'CHIP', kind: 'IMPORTANCE', subject_key: `IMPORTANCE:${i}`, asked_at: `${day}T21:00:00+09:00` });
  }
  const a = await handleVoiceSession(depsOf(week, null).deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.match(a.messages[0].text, /오늘 하루는 어땠어요\?$/);

  const same = seed();
  seedNoAutoFacts(same);
  seedTomorrow(same);
  same.rows('user_questions').push({ question_id: 'q9', user_id: ME, channel: 'CARD', kind: 'PREP_CHECK', subject_key: 'PREP_CHECK:2026-10-30|캡스톤발표', asked_at: '2026-10-28T22:00:00+09:00' }); // 22시간 전
  const b = await handleVoiceSession(depsOf(same, null).deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.match(b.messages[0].text, /오늘 하루는 어땠어요\?$/);
});

test('질문 예산의 하루 = 대화 기준일(같은 밤): 23:50에 물은 뒤 00:20 같은 밤 대화에서 또 못 묻고, 앞 기준일에 물은 것은 셈에 안 듦 (헤드 10/30)', async () => {
  const now = new Date('2026-10-30T00:20:00+09:00'); // 달력은 10/30이지만 아직 안 잔 밤 — 기준일 10/29
  const sameNight = seed(now);
  seedNoAutoFacts(sameNight);
  seedTomorrow(sameNight);
  sameNight.rows('user_questions').push({ question_id: 'q1', user_id: ME, channel: 'CHAT', kind: 'PREP_CHECK', subject_key: 'PREP_CHECK:other', asked_at: '2026-10-29T23:50:00+09:00' });
  const a = await handleVoiceSession(depsOf(sameNight, null, { now: () => now }).deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.deepEqual(a.day, { review: '2026-10-29', morning: '2026-10-30' });
  assert.match(a.messages[0].text, /오늘 하루는 어땠어요\?$/); // 같은 밤에 이미 물음

  const nextNight = seed(now);
  seedNoAutoFacts(nextNight);
  seedTomorrow(nextNight);
  nextNight.rows('user_questions').push({ question_id: 'q1', user_id: ME, channel: 'CHAT', kind: 'PREP_CHECK', subject_key: 'PREP_CHECK:other', asked_at: '2026-10-28T23:50:00+09:00' }); // 앞 기준일 (26시간 전)
  const b = await handleVoiceSession(depsOf(nextNight, null, { now: () => now }).deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.equal(b.messages[0].text, '내일 10:00 캡스톤 발표 준비가 평소보다 더 걸릴 것 같아요?');
});

test('서버 질문을 T1이 나중에 묻는 경우(읽어 줄 기록이 있는 날): 그때 user_questions 한 줄', async () => {
  const db = seed();
  seedTomorrow(db);
  const { deps } = depsOf(db, { T2F: [t2f('empty')], T1: [t1('server_q')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  assert.equal(db.rows('user_questions').length, 0); // 첫 마디는 요약이라 질문 아님
  assert.equal(stateOf(db, sid).ctx.question?.kind, 'PREP_CHECK');
  const r = await handleVoiceTurn(deps, text(sid, 1, '응 다 맞아'));
  assert.deepEqual(r.reply?.acts, [{ type: 'SERVER_Q', ref: 'q1' }]);
  assert.equal(db.rows('user_questions').length, 1);
  assert.equal(stateOf(db, sid).question?.asked_at, '2026-10-29T20:30:00+09:00');
});

// ───────── 장소 고르기 · 카드 거절 ─────────

test('장소 고르기 뒤 text 없이 새 client_turn_id로 results만 와도 받음, 카드 거절은 reply null · T1 안 부름', async () => {
  const db = seed();
  const { deps, claude } = depsOf(db, { T2F: [t2f('place_pending_appt')], T1: [t1('preview'), t1('place_ask'), t1('place_ready')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const id = cid();
  const r1 = await handleVoiceTurn(deps, text(sid, 1, '내일 저녁 6시 반에 학생회관에서 동아리 모임', id));
  assert.equal(r1.next, 'APP_TASKS');
  const r2 = await handleVoiceTurn(deps, { session_id: sid, rev: r1.rev, client_turn_id: id, results: { cards: [{ id: 'c1', status: 'NEEDS_PLACE', estimate: null, error: '위치를 골라 주세요' }], fixes: [] } });
  assert.equal(r2.cards[0].status, 'NEEDS_PLACE');
  assert.equal(r2.cards[0].draft?.place, '학생회관');
  assert.match(claude!.seen.T1[1], /- 되물을 것: '동아리 모임' 장소 \(카드의 \[장소 고르기\]\)/);

  // 사용자가 장소를 고름 → 앱이 새 client_turn_id로 results만
  const est = { alarms: [{ kind: 'DEPARTURE', at: '2026-10-30T17:30:00+09:00', enabled: true }], level: 1, with_wake: false };
  const r3 = await handleVoiceTurn(deps, { session_id: sid, rev: r2.rev, client_turn_id: cid(), results: { cards: [{ id: 'c1', status: 'READY', estimate: est, error: null }], fixes: [] } });
  assert.equal(r3.cards[0].status, 'READY');
  assert.equal(r3.reply?.text, '알람이 준비됐어요. 카드의 저장 버튼을 눌러 주세요.');
  assert.equal(r3.turn_seq, 1);

  // 거절
  const r4 = await handleVoiceTurn(deps, { session_id: sid, rev: r3.rev, client_turn_id: cid(), card_action: { id: 'c1', action: 'REJECTED' } });
  assert.equal(r4.reply, null);
  assert.equal(r4.cards[0].status, 'REJECTED');
  assert.equal(r4.next, 'USER');
  assert.equal(claude!.left('T1'), 0);
});

test('장소를 고른 뒤(READY) T1 화면에서 앞서 낸 "장소 되물을 것" 줄이 사라지고 확인 필요 줄만 남음 (L8 버그 1)', async () => {
  const db = seed();
  const { deps, claude } = depsOf(db, { T2F: [t2f('place_pending_appt')], T1: [t1('preview'), t1('place_ask'), t1('place_ready')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const id = cid();
  const r1 = await handleVoiceTurn(deps, text(sid, 1, '내일 저녁 6시 반에 학생회관에서 동아리 모임', id));
  const needPlace = { cards: [{ id: 'c1', status: 'NEEDS_PLACE', estimate: null, error: '위치를 골라 주세요' }], fixes: [] };
  const r2 = await handleVoiceTurn(deps, { session_id: sid, rev: r1.rev, client_turn_id: id, results: needPlace });
  assert.match(claude!.seen.T1[1], /- 되물을 것: '동아리 모임' 장소/);
  const est = { alarms: [{ kind: 'DEPARTURE', at: '2026-10-30T17:30:00+09:00', enabled: true }], level: 1, with_wake: false };
  await handleVoiceTurn(deps, { session_id: sid, rev: r2.rev, client_turn_id: cid(), results: { cards: [{ id: 'c1', status: 'READY', estimate: est, error: null }], fixes: [] } });
  const view = claude!.seen.T1[2];
  assert.doesNotMatch(view, /되물을 것/);
  assert.match(view, /확인 필요/);
  // 서버 상태에도 해소된 되물을 것이 남지 않음
  assert.equal(stateOf(db, sid).events.flatMap((e) => e.clarify).length, 0);
});

test('모르는 카드 · 남의 세션은 NOT_FOUND, 남의 세션에 닿지 못함', async () => {
  const db = seed();
  db.rows('profiles').push({ user_id: OTHER, nickname: '서연', timezone: 'Asia/Seoul' });
  const { deps } = depsOf(db, { T2F: [t2f('empty')], T1: [t1('chat')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const first = await handleVoiceTurn(deps, text(sid, 1, '오늘 하루 괜찮았어'));

  const unknownCard = await failure(handleVoiceTurn(deps, { session_id: sid, rev: first.rev, client_turn_id: cid(), card_action: { id: 'c9', action: 'REJECTED' } }));
  assert.equal(unknownCard.code, 'NOT_FOUND');
  const unknownResult = await failure(handleVoiceTurn(deps, { session_id: sid, rev: first.rev, client_turn_id: cid(), results: { cards: [{ id: 'c9', status: 'FAILED', estimate: null, error: null }], fixes: [] } }));
  assert.equal(unknownResult.code, 'NOT_FOUND');

  const { deps: theirs } = depsOf(db, { T2F: [], T1: [] }, { userId: OTHER });
  assert.equal((await failure(handleVoiceTurn(theirs, text(sid, 1, '내 세션이야')))).code, 'NOT_FOUND');
  assert.equal((await failure(handleVoiceTurn(theirs, { session_id: sid, rev: 1, client_turn_id: cid(), card_action: { id: 'c1', action: 'REJECTED' } }))).code, 'NOT_FOUND');
  // 남의 세션을 이어 받지도 않음
  const theirSession = await handleVoiceSession(theirs, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  assert.notEqual(theirSession.session_id, sid);
  assert.equal(theirSession.resumed, false);
});

// ───────── 요청 검사 · io ─────────

test('요청 모양 검사: 자기 전 대화 · 글만, text · results · card_action 중 하나', async () => {
  const db = seed();
  const { deps } = depsOf(db, { T2F: [], T1: [] });
  assert.equal((await failure(handleVoiceSession(deps, { session_type: 'AFTER_WAKE', input_mode: 'TEXT' }))).code, 'VALIDATION_FAILED');
  assert.equal((await failure(handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'VOICE' }))).code, 'VALIDATION_FAILED');
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  assert.equal((await failure(handleVoiceTurn(deps, { session_id: sid, rev: 1, client_turn_id: cid() }))).code, 'VALIDATION_FAILED');
  assert.equal((await failure(handleVoiceTurn(deps, { session_id: sid, rev: 1, client_turn_id: cid(), text: '가', card_action: { id: 'c1', action: 'SAVED' } }))).code, 'VALIDATION_FAILED');
  assert.equal((await failure(handleVoiceTurn(deps, { session_id: 'x', rev: 1, client_turn_id: cid(), text: '가' }))).code, 'VALIDATION_FAILED');
  const badAt = { session_id: sid, rev: 1, client_turn_id: cid(), results: { cards: [{ id: 'c1', status: 'READY', estimate: { alarms: [{ kind: 'WAKE', at: '내일 아침', enabled: true }], level: 1, with_wake: true } }], fixes: [] } };
  assert.equal((await failure(handleVoiceTurn(deps, badAt))).code, 'VALIDATION_FAILED');
});

test('앱이 보낸 알람 요약이 범위 밖이면(이미 지난 시각) 카드는 FAILED로 두고 되물을 것만 — 저장 불가', async () => {
  const db = seed();
  const { deps, claude } = depsOf(db, { T2F: [t2f('new_appt')], T1: [t1('preview'), t1('place_ask')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const id = cid();
  const r1 = await handleVoiceTurn(deps, text(sid, 1, '내일 10시 강남역에서 캡스톤 발표 있어', id));
  const past = { alarms: [{ kind: 'WAKE', at: '2026-10-29T07:40:00+09:00', enabled: true }], level: 1, with_wake: true };
  const r2 = await handleVoiceTurn(deps, { session_id: sid, rev: r1.rev, client_turn_id: id, results: { cards: [{ id: 'c1', status: 'READY', estimate: past, error: null }], fixes: [] } });
  assert.equal(r2.cards[0].status, 'FAILED');
  assert.match(claude!.seen.T1[1], /- 되물을 것: '캡스톤 발표' 알람 계산/);
});

test('AI_LOG_IO_USER_IDS에 든 사용자만 ai_calls.io에 입력 · 출력 글이 남음', async () => {
  const db = seed();
  const { deps } = depsOf(db, { T2F: [t2f('empty')], T1: [t1('chat')] }, { ioUserIds: [ME] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  await handleVoiceTurn(deps, text(s.session_id as string, 1, '괜찮았어'));
  const calls = db.rows('ai_calls');
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const io = c.io as { input: string; output: unknown };
    assert.ok(io.input.includes('괜찮았어'));
    assert.ok(io.output !== null);
  }
});

// ───────── 재시도 · 마감 ─────────

test('앱 일을 기다리는 말을 같은 client_turn_id로 다시 보내면 같은 APP_TASKS를 돌려주고 모델을 또 부르지 않음', async () => {
  const db = seed();
  const { deps, claude } = depsOf(db, { T2F: [t2f('arrive_fix')], T1: [t1('preview')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const id = cid();
  const first = await handleVoiceTurn(deps, text(sid, 1, '도착은 10시 20분이었어', id));
  assert.equal(first.next, 'APP_TASKS');
  assert.equal(first.fixes.length, 1);
  const calls = claude!.order.length;
  const again = await handleVoiceTurn(deps, text(sid, 1, '도착은 10시 20분이었어', id)); // 응답을 못 받아 다시 보냄(옛 rev)
  assert.deepEqual(again, first);
  assert.equal(claude!.order.length, calls);
  assert.equal(turnsOf(db, sid).filter((t) => t.role === 'user').length, 1);
});

test('마감까지 7초 넘게 안 남았으면 가드가 다시 부르라 해도 T1을 한 번만 부르고 템플릿으로', async () => {
  const db = seed();
  let t = 0;
  const { deps, claude } = depsOf(db, { T2F: [t2f('empty')], T1: [t1('claims_saved'), t1('chat')] }, { clock: () => (t += 12_000) });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const r = await handleVoiceTurn(deps, text(s.session_id as string, 1, '그래'));
  assert.deepEqual(claude!.order.filter((p) => p === 'T1'), ['T1']);
  assert.equal(r.reply?.text, '네, 알겠어요.');
  const line = turnsOf(db, s.session_id as string).at(-1) as { source?: string; guard?: string[] };
  assert.equal(line.source, 'fallback');
  assert.ok(line.guard?.includes('template'));
});

// ───────── 영어 입력 (헤드 10/30 B2 ③) — 말은 그대로 모델에 가고, 시스템 글에 "영어도 뜻대로 알아듣고 한국어로 답" 규칙이 있고, 언어만으로 대화가 끝나지 않음 ─────────
for (const [name, said] of [
  ['영어만', 'Why no Korean input?'],
  ['한국어에 영어가 섞임', '오늘 OS 수업 so tired, 그냥 자고 싶어'],
  ['영어 장소 이름', '내일 Starbucks에서 스터디 있어'],
] as const) {
  test(`영어 입력 (${name}): 입력 그대로 모델 화면에 들어가고, 답은 한국어로 이어지고 대화는 안 끝남`, async () => {
    const db = seed();
    const { deps, claude } = depsOf(db, { T2F: [t2f('empty')], T1: [{ reply: '편한 말로 이야기해 주세요. 오늘 하루는 어땠어요?', acts: [], end: false }] });
    const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
    const out = (await handleVoiceTurn(deps, text(s.session_id as string, 1, said))) as VoiceTurnOut;
    assert.equal(out.next, 'USER');
    assert.equal(out.reply?.text, '편한 말로 이야기해 주세요. 오늘 하루는 어땠어요?');
    assert.equal(out.reply?.end, false); // 언어만으로 끝내지 않음
    assert.ok(claude!.seen.T1[0].includes(said), '사용자가 쓴 영어가 그대로 T1 화면에 들어감');
    assert.ok(claude!.seen.T2F[0].includes(said), '사용자가 쓴 영어가 그대로 T2F 화면에 들어감');
    assert.match(POINTS.T1.prompt.system, /영어로 쓰거나 한국어에 영어가 섞여도 뜻 그대로 알아듣고, 답은 한국어로/);
  });
}

// ───────── AI 대화 품질 (T1 v1.6) — 단답에 안 끝냄 · 내일 일정 물음(ASK_TOMORROW = acts REFLECT) · 규칙 문구 ─────────
test('T1 v1.6 시스템 글: 단답 한 번에 안 끝냄 · 내일 일정 물음 · 확인 문장 반복 금지 · 장소는 카드로 · 근거 줄 규칙이 있음', () => {
  const sys = POINTS.T1.prompt.system;
  assert.equal(POINTS.T1.prompt.version, 'v1.6');
  assert.match(sys, /ASK_TOMORROW/);
  assert.match(sys, /단답 한 번으로는 끝내지 마/); // ①
  assert.match(sys, /내일 챙길 일정이 있어요\?/);
  assert.match(sys, /같은 확인 문장.*똑같이 되풀이하지 마/); // ④
  assert.match(sys, /카드의 \[장소 고르기\]를 눌러 주세요/); // ③
  assert.match(sys, /"근거"/); // ②
  assert.match(sys, /근거에 없는 숫자는 쓰지 마/);
  assert.match(sys, /109\(자살예방 상담전화\)/); // ⑤ 위기 규칙은 그대로
});

test('단답("그냥 그랬어") 뒤 내일 일정 물음: end=false가 그대로 가고, 물음 acts(REFLECT)가 가드 · 질문 예산에 안 걸리며 대화가 이어짐', async () => {
  const db = seed();
  const { deps, claude } = depsOf(db, {
    T2F: [t2f('empty'), t2f('empty')],
    T1: [
      { reply: '그랬군요. 내일 챙길 일정이 있어요?', acts: [{ type: 'REFLECT', ref: null }], end: false },
      { reply: '알겠어요. 아침 일정이 정해지면 알려 주세요.', acts: [], end: false },
    ],
  });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const sid = s.session_id as string;
  const out = (await handleVoiceTurn(deps, text(sid, 1, '그냥 그랬어'))) as VoiceTurnOut;
  assert.equal(out.reply?.text, '그랬군요. 내일 챙길 일정이 있어요?');
  assert.equal(out.reply?.end, false);
  assert.deepEqual(out.reply?.acts, [{ type: 'REFLECT', ref: null }]);
  const t = turnsOf(db, sid).filter((x) => x.role === 'ai');
  assert.deepEqual(t[t.length - 1]?.guard ?? [], []); // 가드가 아무것도 안 함
  assert.equal(db.rows('user_questions').length, 0); // 서버 질문 예산(하루 1 · 주 3)은 안 씀
  // 이어 가는 말에도 끝나지 않음
  const out2 = (await handleVoiceTurn(deps, text(sid, 2, '아직 모르겠어'))) as VoiceTurnOut;
  assert.equal(out2.reply?.end, false);
  assert.equal(claude!.left('T1'), 0);
});

test('내일 일정 물음을 한 답에 둘 쓰면 물음은 하나만 남음 (한 번에 하나)', async () => {
  const db = seed();
  const two = { reply: '내일 챙길 일정이 있어요? 내일 아침에 할 일이 있어요?', acts: [{ type: 'REFLECT', ref: null }, { type: 'REFLECT', ref: null }], end: false };
  const { deps } = depsOf(db, { T2F: [t2f('empty')], T1: [two, two] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const out = (await handleVoiceTurn(deps, text(s.session_id as string, 1, '그냥 그랬어'))) as VoiceTurnOut;
  assert.equal((out.reply?.text.match(/\?/g) ?? []).length, 1);
  assert.equal(out.reply?.end, false);
});

// ───────── 새 약속 vs 수정 (T2F v2-b) — 같은 이름의 기존 일정이 있어도 ref null이면 새 약속 카드, 애매하면 되묻기 ─────────
function seedDinner(db: FakeDb) {
  db.rows('appointments').push({ appointment_id: 'ap-din', creator_id: ME, title: '저녁', appointment_at: '2026-10-30T18:00:00+09:00', dest_name: '홍대입구역', importance: 'NORMAL', recurrence_rule: null });
  db.rows('appointment_participants').push({ participant_id: 'pt-din', appointment_id: 'ap-din', user_id: ME, transport_type: 'SUBWAY', est_travel_minutes: 30, departed_at: null, departed_source: null, arrived_at: null, arrived_source: null, is_late: null, late_minutes: null });
}
const dinnerAppt = (over: Record<string, unknown>) => ({
  ...t2f('new_appt'),
  appointments: [{ ref: null, title: '저녁', date: '2026-10-30', time: '00:30', place: '강남역', importance: null, transport: null, repeat: null, save: 'UNCONFIRMED', unclear: null, ...over }],
});

test('T2F v2-b: 같은 이름 기존 일정(저녁)이 있어도 ref null · 다른 시각 · 장소면 변경 카드(APPT_OPEN)가 아니라 새 일정 카드(APPT_NEW)', async () => {
  const db = seed();
  seedDinner(db);
  const { deps, claude } = depsOf(db, { T2F: [dinnerAppt({})], T1: [t1('preview'), t1('chat')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const r = await handleVoiceTurn(deps, text(s.session_id as string, 1, 'dinner tomorrow 12:30am at gangnam station'));
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].kind, 'APPT_NEW');
  assert.doesNotMatch(r.cards[0].summary, /^변경:/);
  assert.equal(r.cards[0].draft?.place, '강남역');
  assert.equal(r.cards[0].draft?.time, '00:30');
  assert.ok(claude!.seen.T2F[0].includes('dinner tomorrow 12:30am at gangnam station'));
});

test('T2F v2-b: 애매해서 날짜 · 시각이 null + unclear면 카드 없이 되묻기(CLARIFY)', async () => {
  const db = seed();
  seedDinner(db);
  const { deps, claude } = depsOf(db, { T2F: [dinnerAppt({ date: null, time: null, place: null, unclear: '시각이 모호함' })], T1: [t1('preview'), t1('chat')] });
  const s = await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT' });
  const r = await handleVoiceTurn(deps, text(s.session_id as string, 1, '저녁 약속 있어'));
  assert.equal(r.cards.length, 0);
  assert.match(claude!.seen.T1[1], /되물을 것: '저녁'의 정확한 날짜·시각 · 장소/);
});

test('그룹: 대화를 연 뒤 가입한 그룹도 말마다 새로 읽어 후보로 — 이름 일부("캡스톤" ↔ "캡스톤팀")는 묻기만, 가입 안 한 그룹은 후보 아님', async () => {
  const db = seed();
  const meeting = { appointments: [{ ref: null, title: '캡스톤 회의', date: '2026-10-30', time: '10:30', place: '세종대학교', importance: null, transport: null, repeat: null, save: 'UNCONFIRMED', unclear: null }], alarm_changes: [], fact_feedback: [], prep_adjustment: null, safety_flag: false };
  const { deps } = depsOf(db, { T2F: [meeting], T1: [t1('preview')] });
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  const sid = s.session_id as string;
  assert.equal(stateOf(db, sid).ctx.groups, undefined); // 대화를 열 때는 가입 그룹 없음

  // 대화를 연 뒤 '캡스톤팀'에 가입 · '캡스톤 디자인'은 초대만 받음(INVITED)
  db.rows('groups').push({ group_id: 'g-cap', group_name: '캡스톤팀', owner_id: OTHER }, { group_id: 'g-inv', group_name: '캡스톤 디자인', owner_id: OTHER });
  db.rows('group_members').push({ group_member_id: 'gm1', group_id: 'g-cap', user_id: ME, invite_status: 'JOINED' }, { group_member_id: 'gm2', group_id: 'g-inv', user_id: ME, invite_status: 'INVITED' });

  const r = (await handleVoiceTurn(deps, text(sid, s.rev, '내일 10시 반에 캡스톤 회의 잡아줘'))) as VoiceTurnOut;
  assert.deepEqual(r.cards.map((c) => c.group), [{ choice: 'ASK', id: null, candidates: [{ id: 'g-cap', name: '캡스톤팀' }] }]);
});

test('그룹 · 날짜를 물어야 하는데 T1이 "네, 알겠어요."만 하면 서버 문장으로 물음 — 카드는 안 만듦', async () => {
  const db = seed();
  db.rows('groups').push({ group_id: 'g-cap', group_name: '캡스톤팀', owner_id: OTHER }, { group_id: 'g-algo', group_name: '알고리즘 스터디', owner_id: OTHER });
  db.rows('group_members').push({ group_member_id: 'gm1', group_id: 'g-cap', user_id: ME, invite_status: 'JOINED' }, { group_member_id: 'gm2', group_id: 'g-algo', user_id: ME, invite_status: 'JOINED' });
  const noDate = { appointments: [{ ref: null, title: '약속', date: null, time: '10:30', place: null, importance: null, transport: null, repeat: null, save: 'CONFIRMED', unclear: null }], alarm_changes: [], fact_feedback: [], prep_adjustment: null, safety_flag: false };
  const { deps } = depsOf(db, { T2F: [noDate], T1: [t1('preview'), t1('preview')] });
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  const r = (await handleVoiceTurn(deps, text(s.session_id as string, s.rev, '그룹 알람 10시 반에 약속 잡아줘'))) as VoiceTurnOut;
  assert.deepEqual(r.cards, []);
  assert.equal(r.reply?.text, "가입한 그룹은 캡스톤팀, 알고리즘 스터디예요. 일정이 정해지면 카드에서 그룹 일정인지 개인 일정인지 골라 주세요. '약속' 일정의 날짜를 알려 주시겠어요?");
  assert.deepEqual(r.reply?.acts, [{ type: 'CLARIFY', ref: null }]);
});
