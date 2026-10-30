// 시드 데이터 모양 확인 — DB 제약(유니크 · 외래키 · 값 목록)을 어기지 않는지, 문서가 말하는 상황이 들어 있는지
//   cd supabase/seed && npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEMO_USERS, addDays, buildDataset } from './data.mjs';

const TODAY = '2026-10-15'; // 목요일
let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const users = Object.fromEntries(DEMO_USERS.map((u, i) => [u.key, `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`]));
const { tables: t, counts } = buildDataset({ users, today: TODAY, newId });

const kstHm = (iso) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const kstDay = (iso) => new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

test('계정 4명, 닉네임 · 아이디 모양 (handle ^[a-z0-9_]{3,20}$)', () => {
  assert.equal(t.profiles.length, 4);
  for (const p of t.profiles) {
    assert.match(p.handle, /^[a-z0-9_]{3,20}$/);
    assert.ok(p.nickname.length <= 30);
    assert.ok(!Number.isNaN(Date.parse(p.onboarded_at)), '데모 계정은 온보딩을 끝낸 상태');
  }
  assert.equal(new Set(t.profiles.map((p) => p.handle)).size, 4);
});

test('친구 · 그룹: 받은 요청 1개(대기), 그룹 1개 · 구성원 4명, 기상 공유 동의는 일부만', () => {
  assert.deepEqual(t.friends.map((f) => f.status), ['ACCEPTED', 'ACCEPTED', 'PENDING']);
  assert.ok(t.friends.every((f) => f.requester_id !== f.addressee_id));
  assert.equal(t.groups.length, 1);
  assert.equal(t.group_members.length, 4);
  const optIn = t.group_members.filter((m) => m.wake_share_opt_in).length;
  assert.ok(optIn > 0 && optIn < 4, `동의 ${optIn}명`);
});

test('공유 권한: 자기 자신에게 안 주고, 친구 권한의 source는 친구 관계, 그룹 권한은 그 그룹', () => {
  const friendIds = new Set(t.friends.map((f) => f.friend_id));
  const groupIds = new Set(t.groups.map((g) => g.group_id));
  const keys = new Set();
  for (const p of t.sharing_permissions) {
    assert.notEqual(p.owner_id, p.grantee_id);
    assert.ok((p.source_type === 'FRIEND' ? friendIds : groupIds).has(p.source_id));
    const key = [p.owner_id, p.grantee_id, p.source_type, p.source_id].join('|');
    assert.ok(!keys.has(key), `중복 ${key}`);
    keys.add(key);
  }
});

test('오늘(D57) 그룹 약속: 구성원 4명 모두 참여, 알람은 목업 숫자 (나 8:00 · 8:30 · 9:00 · 9:50)', () => {
  const meeting = t.appointments.find((a) => a.title === '팀 주간회의');
  assert.equal(kstDay(meeting.appointment_at), TODAY);
  assert.ok(meeting.group_id);
  assert.match(meeting.recurrence_rule, /^FREQ=WEEKLY;BYDAY=TH$/);
  const parts = t.appointment_participants.filter((p) => p.appointment_id === meeting.appointment_id);
  assert.equal(parts.length, 4);
  const mine = parts.find((p) => p.user_id === users.me);
  const alarms = t.alarms.filter((a) => a.participant_id === mine.participant_id).map((a) => `${a.alarm_type} ${kstHm(a.scheduled_at)}`);
  assert.deepEqual(alarms, ['WAKE 08:00', 'PREPARE 08:30', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  const suyeon = parts.find((p) => p.user_id === users.suyeon);
  assert.deepEqual(t.alarms.filter((a) => a.participant_id === suyeon.participant_id).map((a) => kstHm(a.scheduled_at)), ['07:30', '07:38', '08:40', '09:50']);
});

test('오늘 그룹원 기상 흐름: 수연 · 지형 · 준성은 기록이 있고 나는 아직 없음', () => {
  const meeting = t.appointments.find((a) => a.title === '팀 주간회의');
  const wakes = new Map(t.alarms.filter((a) => a.alarm_type === 'WAKE' && t.appointment_participants.some((p) => p.participant_id === a.participant_id && p.appointment_id === meeting.appointment_id)).map((a) => [a.user_id, a]));
  const confirmedBy = (uid) => t.alarm_events.filter((e) => e.event_type === 'WAKE_CONFIRMED' && e.alarm_id === wakes.get(uid).alarm_id);
  assert.equal(confirmedBy(users.me).length, 0);
  assert.equal(confirmedBy(users.suyeon).length, 1);
  assert.equal(kstHm(confirmedBy(users.suyeon)[0].event_at), '07:35');
});

test('개인 약속: 저녁약속(기상 없이 준비부터) · 알람 없는 치과 예약 · 내일 수업', () => {
  const alarmsOf = (title) => {
    const a = t.appointments.find((x) => x.title === title && kstDay(x.appointment_at) >= TODAY);
    const p = t.appointment_participants.find((x) => x.appointment_id === a.appointment_id && x.user_id === users.me);
    return t.alarms.filter((x) => x.participant_id === p.participant_id).map((x) => `${x.alarm_type} ${kstHm(x.scheduled_at)}`);
  };
  assert.deepEqual(alarmsOf('저녁약속'), ['PREPARE 17:10', 'DEPARTURE 17:35', 'ARRIVE 17:55']);
  assert.deepEqual(alarmsOf('치과 예약'), []);
  assert.deepEqual(alarmsOf('수업'), ['WAKE 07:20', 'PREPARE 07:30', 'DEPARTURE 08:00', 'ARRIVE 08:50']);
});

test('일정 없는 기상 알람(D46): 약속 · 루틴 연결 없이 반복 규칙만', () => {
  const standalone = t.alarms.filter((a) => a.participant_id === null && a.routine_id === null);
  assert.equal(standalone.length, 1);
  assert.equal(standalone[0].alarm_type, 'WAKE');
  assert.match(standalone[0].recurrence_rule, /^FREQ=WEEKLY;BYDAY=/);
});

test('지난 4주: 생활 기록 28일(날짜 중복 없음), 늦잠 지각 3번 (#49 끝 기준)', () => {
  assert.equal(t.daily_records.length, 28);
  const days = t.daily_records.map((r) => r.record_date);
  assert.equal(new Set(days).size, 28);
  assert.equal(days.sort()[0], addDays(TODAY, -28));
  assert.equal(days.sort().at(-1), addDays(TODAY, -1));
  const late = t.appointment_participants.filter((p) => p.user_id === users.me && p.is_late === true);
  assert.equal(late.length, 3);
  assert.ok(late.every((p) => p.late_minutes > 0));
  // 늦은 날은 미루기 기록이 있고, 기상 확인이 알람보다 한참 뒤
  const lateWake = late.map((p) => t.alarms.find((a) => a.participant_id === p.participant_id && a.alarm_type === 'WAKE'));
  for (const wake of lateWake) {
    assert.equal(t.alarm_events.filter((e) => e.alarm_id === wake.alarm_id && e.event_type === 'SNOOZED').length, 2);
    const confirmed = t.alarm_events.find((e) => e.alarm_id === wake.alarm_id && e.event_type === 'WAKE_CONFIRMED');
    assert.ok(new Date(confirmed.event_at) - new Date(wake.scheduled_at) >= 25 * 60_000);
  }
  // 평일 20일은 준비 시간 기록이 있음 (v_prepare_time_stats의 표본)
  const withPrep = t.daily_records.filter((r) => r.actual_prepare_minutes != null);
  assert.ok(withPrep.length >= 15 && withPrep.every((r) => r.actual_prepare_minutes > 0 && r.actual_prepare_minutes < 120));
});

test('같은 참여 조건에 같은 종류 알람이 둘 이상 없음 (alarms_participant_type_key), 순서 기상 ≤ 준비 ≤ 출발 ≤ 도착', () => {
  const seen = new Set();
  for (const a of t.alarms) {
    if (!a.participant_id) continue;
    const key = `${a.participant_id}|${a.alarm_type}`;
    assert.ok(!seen.has(key), key);
    seen.add(key);
  }
  const order = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];
  for (const p of t.appointment_participants) {
    const times = t.alarms.filter((a) => a.participant_id === p.participant_id).sort((x, y) => order.indexOf(x.alarm_type) - order.indexOf(y.alarm_type)).map((a) => a.scheduled_at);
    assert.deepEqual([...times].sort(), times);
  }
});

test('출발 · 도착 시각은 출처와 같이 (appointment_participants_*_source_needs_time) — 시각이 있으면 BUTTON, 없으면 NULL', () => {
  assert.ok(t.appointment_participants.some((p) => p.departed_at !== null), '시각이 있는 참여 조건이 하나도 없음');
  for (const p of t.appointment_participants) {
    assert.equal(p.departed_source, p.departed_at === null ? null : 'BUTTON', p.participant_id);
    assert.equal(p.arrived_source, p.arrived_at === null ? null : 'BUTTON', p.participant_id);
  }
});

test('외래키 · 값: 알람 → 참여 조건, 울림 기록 → 알람(주인 일치) · 값 목록 · client_event_id 유일', () => {
  const participants = new Map(t.appointment_participants.map((p) => [p.participant_id, p]));
  const appointments = new Set(t.appointments.map((a) => a.appointment_id));
  assert.ok(t.appointment_participants.every((p) => appointments.has(p.appointment_id)));
  for (const a of t.alarms) {
    if (a.participant_id) assert.equal(participants.get(a.participant_id).user_id, a.user_id);
  }
  const alarms = new Map(t.alarms.map((a) => [a.alarm_id, a]));
  const types = new Set(['TRIGGERED', 'SNOOZED', 'DISMISSED', 'WAKE_CONFIRMED', 'ARRIVAL_CONFIRMED', 'MISSED', 'FEEDBACK', 'ACKNOWLEDGED']);
  const sources = new Set([null, 'BUTTON', 'LOCATION', 'VOICE', 'MANUAL', 'USAGE']);
  const ids = new Set();
  for (const e of t.alarm_events) {
    assert.equal(alarms.get(e.alarm_id)?.user_id, e.user_id);
    assert.ok(types.has(e.event_type));
    assert.ok(sources.has(e.input_source));
    assert.equal(e.feedback_type, null); // FEEDBACK 이벤트가 아니므로
    assert.ok(!ids.has(e.client_event_id));
    ids.add(e.client_event_id);
  }
  for (const r of t.daily_records) assert.ok(['MANUAL', 'ALARM', 'AI'].includes(r.data_source));
});

test('날짜 칸은 모두 문자열(JSON으로 보낼 수 있음)이고 같은 입력이면 같은 지난 4주 기록', () => {
  for (const rows of Object.values(t)) for (const row of rows) for (const v of Object.values(row)) assert.ok(!(v instanceof Date));
  const again = buildDataset({ users, today: TODAY, newId: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })() });
  const first = buildDataset({ users, today: TODAY, newId: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })() });
  assert.deepEqual(again.tables.daily_records, first.tables.daily_records);
  assert.deepEqual(again.counts, first.counts);
  assert.deepEqual(counts, buildDataset({ users, today: TODAY }).counts);
});

test('반복 일정은 앞으로 올 회차 둘뿐(오늘 팀 주간회의 · 내일 수업) — 지난 4주 "수업" 20건은 반복 규칙 없음', () => {
  const recurring = t.appointments.filter((a) => a.recurrence_rule != null);
  assert.deepEqual(recurring.map((a) => a.title).sort(), ['수업', '팀 주간회의']);
  assert.ok(recurring.every((a) => kstDay(a.appointment_at) >= TODAY));
  const past = t.appointments.filter((a) => kstDay(a.appointment_at) < TODAY);
  assert.equal(past.length, 20);
  assert.ok(past.every((a) => a.recurrence_rule === null));
  // 일정 없는 기상 알람의 반복(D46)은 그대로
  assert.equal(t.alarms.filter((a) => a.recurrence_rule != null && a.participant_id === null).length, 1);
});

test('금 · 토 · 일에 넣어도 앞으로 올 수업 · 평일 알람은 평일(월~금)에 걸림', () => {
  for (const [today, expectDay] of [['2026-10-30', '2026-11-02'], ['2026-10-31', '2026-11-02'], ['2026-11-01', '2026-11-02'], ['2026-10-29', '2026-10-30']]) {
    let n = 0;
    const { tables } = buildDataset({ users, today, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
    const lecture = tables.appointments.find((a) => a.title === '수업' && a.recurrence_rule);
    assert.equal(kstDay(lecture.appointment_at), expectDay, today);
    assert.match(lecture.recurrence_rule, /BYDAY=(MO|TU|WE|TH|FR)$/);
    const standalone = tables.alarms.find((a) => a.participant_id === null && a.alarm_type === 'WAKE');
    assert.equal(kstDay(standalone.scheduled_at), expectDay, today);
  }
});
