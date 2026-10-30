// 데모 데이터 만들기 — 순수 함수 (네트워크 없음). seed.mjs가 이 결과를 넣고, data.test.mjs가 모양을 확인함
//   · 이메일 계정 4명 · 친구 · 그룹 1개(기상 공유 동의 일부) · 공유 권한
//   · 오늘(D57) 그룹 약속 + 개인 약속 · 일정 없는 기상 알람
//   · 나(데모)의 지난 4주: 생활 기록 28일 + 평일마다 약속 · 알람 · 울림 기록, 늦잠 지각 3번 (#49 끝 기준 "늦잠 지각 3번 → 10분 앞당김")
// 알람 시각은 서버 함수와 같은 공용 계산(functions/_shared/calc, Node 24가 .ts를 바로 읽음)으로 만듦 → 서버가 계산한 값과 같은 숫자
import { randomUUID } from 'node:crypto';

import { alarmChain, resolveIntensity } from '../functions/_shared/calc/index.ts';

export const DEMO_DOMAIN = 'example.com'; // IANA 예약 도메인 — 실제 사람의 메일이 아님
export const DEMO_USERS = [
  { key: 'me', email: `demo-me@${DEMO_DOMAIN}`, handle: 'demo_me', nickname: '나(데모)' },
  { key: 'suyeon', email: `demo-suyeon@${DEMO_DOMAIN}`, handle: 'demo_suyeon', nickname: '수연' },
  { key: 'jihyeong', email: `demo-jihyeong@${DEMO_DOMAIN}`, handle: 'demo_jihyeong', nickname: '지형' },
  { key: 'junseong', email: `demo-junseong@${DEMO_DOMAIN}`, handle: 'demo_junseong', nickname: '준성' },
];

const HOME = { name: '우리 집', lat: 37.5445, lng: 127.056 };
const SEJONG = { name: '세종대학교', lat: 37.5509, lng: 127.0736 };
const GANGNAM = { name: '강남역 2번출구', lat: 37.4979, lng: 127.0276 };
const DENTIST = { name: '동네 치과', lat: 37.5469, lng: 127.0626 };
const GWANGHWAMUN = { name: '광화문', lat: 37.5712, lng: 126.9769 };

// ---- 시각 도우미 (한국 시각 기준 날짜 문자열 'YYYY-MM-DD') ----

const KST_OFFSET_MIN = 9 * 60;
const at = (day, hour, minute = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - KST_OFFSET_MIN * 60_000);
};
const addMin = (date, minutes) => new Date(date.getTime() + minutes * 60_000);
export const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 일 … 6 토
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// 한국 날짜 오늘 (시험에서는 today를 직접 넘김)
export function todayInKst(now = new Date()) {
  return new Date(now.getTime() + KST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

// 같은 입력이면 같은 값 (지난 4주 기록이 실행마다 달라지지 않게)
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 데이터 만들기 ----

// users: { me: id, suyeon: id, jihyeong: id, junseong: id }  today: 'YYYY-MM-DD'  newId: UUID 만드는 함수 (시험에서 바꿈)
export function buildDataset({ users, today, newId = randomUUID }) {
  const t = {
    profiles: [], // 계정을 만들면 트리거가 만든 행을 고침
    friends: [],
    groups: [],
    group_members: [], // 만든 사람 행은 트리거가 이미 만듦 → groupOwnerUpdate로 고침
    sharing_permissions: [],
    appointments: [],
    appointment_participants: [],
    alarms: [],
    alarm_events: [],
    daily_records: [],
  };
  const now = new Date();

  // 프로필 — 이메일 계정은 닉네임만 있으므로 아이디 · 집 · 기본값 · 온보딩 끝낸 시각을 채움
  for (const u of DEMO_USERS) {
    t.profiles.push({
      user_id: users[u.key],
      handle: u.handle,
      nickname: u.nickname,
      home_name: HOME.name,
      home_lat: HOME.lat,
      home_lng: HOME.lng,
      default_prepare_minutes: 60,
      default_buffer_minutes: 10,
      default_transport: 'TRANSIT',
      timezone: 'Asia/Seoul',
      onboarded_at: now.toISOString(), // 데모 계정은 온보딩을 끝낸 상태 (나머지 새 칸은 DB 기본값)
    });
  }

  // 친구 — 나↔수연(수락) · 지형→나(수락) · 준성→나(대기: 받은 요청에 보임)
  const friend = (requester, addressee, status) => {
    const row = {
      friend_id: newId(),
      requester_id: users[requester],
      addressee_id: users[addressee],
      status,
      requested_at: now.toISOString(),
      accepted_at: status === 'ACCEPTED' ? now.toISOString() : null,
    };
    t.friends.push(row);
    return row;
  };
  const fMeSuyeon = friend('me', 'suyeon', 'ACCEPTED');
  const fJihyeongMe = friend('jihyeong', 'me', 'ACCEPTED');
  friend('junseong', 'me', 'PENDING');

  // 그룹 — 지형이 만든 캡스톤팀. 기상 공유 동의: 나 · 수연 · 지형 = 켬, 준성 = 끔 (동의 안 한 사람은 그룹 권한으로 못 봄)
  const group = { group_id: newId(), group_name: '캡스톤팀', description: '데모 그룹', owner_id: users.jihyeong };
  t.groups.push(group);
  const optIn = { me: true, suyeon: true, jihyeong: true, junseong: false };
  for (const u of DEMO_USERS) {
    t.group_members.push({
      group_id: group.group_id,
      user_id: users[u.key],
      invite_status: 'JOINED',
      wake_share_opt_in: optIn[u.key],
      joined_at: now.toISOString(),
    });
  }

  // 공유 권한 (준 사람 owner → 받는 사람 grantee)
  const perm = (owner, grantee, sourceType, sourceId, v) =>
    t.sharing_permissions.push({
      owner_id: users[owner],
      grantee_id: users[grantee],
      source_type: sourceType,
      source_id: sourceId,
      can_view_alarm: !!v.alarm,
      can_edit_alarm: !!v.edit,
      can_view_wake: !!v.wake,
    });
  perm('suyeon', 'me', 'FRIEND', fMeSuyeon.friend_id, { alarm: true, edit: true, wake: true }); // G04 설정 권한(±5분) · 알림 시험
  perm('me', 'suyeon', 'FRIEND', fMeSuyeon.friend_id, { alarm: true });
  perm('jihyeong', 'me', 'FRIEND', fJihyeongMe.friend_id, { alarm: true, wake: true });
  perm('suyeon', 'me', 'GROUP', group.group_id, { alarm: true, wake: true });
  perm('jihyeong', 'me', 'GROUP', group.group_id, { wake: true });
  perm('junseong', 'me', 'GROUP', group.group_id, { wake: true }); // 준성은 동의가 꺼져 있어 효력 없음
  perm('me', 'suyeon', 'GROUP', group.group_id, { wake: true });
  perm('me', 'jihyeong', 'GROUP', group.group_id, { wake: true });

  // ---- 약속 · 참여 조건 · 알람 만드는 도우미 ----

  const appointment = (creator, fields) => {
    const row = {
      appointment_id: newId(),
      creator_id: users[creator],
      group_id: null,
      importance: 'NORMAL',
      recurrence_rule: null,
      memo: null,
      dest_lat: null,
      dest_lng: null,
      ...fields,
    };
    t.appointments.push(row);
    return row;
  };

  // lateCount: 그 사람의 최근 4주 늦잠 지각 (강도 자동 값). 알람 시각은 서버와 같은 calc로
  const participate = (appt, who, opts) => {
    const p = {
      participant_id: newId(),
      appointment_id: appt.appointment_id,
      user_id: users[who],
      origin_name: opts.origin?.name ?? HOME.name,
      origin_lat: opts.origin?.lat ?? HOME.lat,
      origin_lng: opts.origin?.lng ?? HOME.lng,
      transport_type: opts.transport ?? 'TRANSIT',
      est_travel_minutes: opts.travel,
      travel_source: 'API',
      prepare_minutes: opts.prepare,
      buffer_minutes: opts.buffer,
      departed_at: null,
      departed_source: null,
      arrived_at: null,
      arrived_source: null,
      is_late: null,
      late_minutes: null,
    };
    t.appointment_participants.push(p);

    const chain = alarmChain({
      at: new Date(appt.appointment_at),
      travelMinutes: opts.travel,
      bufferMinutes: opts.buffer,
      prepareMinutes: opts.prepare,
      beforePrepareMinutes: opts.before ?? 0,
      withWake: opts.withWake,
      kinds: opts.kinds,
    });
    const intensity = resolveIntensity(appt.importance, opts.lateCount ?? 0).fields;
    const alarms = chain.map((c) => {
      const row = {
        alarm_id: newId(),
        participant_id: p.participant_id,
        routine_id: null,
        step_order: null,
        user_id: users[who],
        alarm_type: c.kind,
        scheduled_at: c.at.toISOString(),
        intensity: intensity.intensity,
        voice_tone: intensity.voiceTone,
        sound_key: intensity.soundKey,
        is_enabled: true,
        snooze_limit: 3,
        time_source: 'AUTO',
        intensity_source: 'AUTO',
        recurrence_rule: null,
        last_calculated_at: now.toISOString(),
      };
      t.alarms.push(row);
      return row;
    });
    return { participant: p, alarms, byType: Object.fromEntries(alarms.map((a) => [a.alarm_type, a])) };
  };

  let eventSeq = 0;
  const event = (alarm, type, when, extra = {}) => {
    t.alarm_events.push({
      alarm_id: alarm.alarm_id,
      user_id: alarm.user_id,
      event_type: type,
      event_at: when.toISOString(),
      snooze_minutes: null,
      feedback_type: null,
      sequence_no: 1,
      client_event_id: newId(),
      input_source: null,
      ...extra,
    });
    eventSeq += 1;
  };

  // ---- 오늘 (D57: 그룹 약속이 있는 날에만 그룹원 기상 상태가 보임) ----

  const meeting = appointment('jihyeong', {
    group_id: group.group_id,
    title: '팀 주간회의',
    appointment_at: at(today, 10, 0).toISOString(),
    dest_name: SEJONG.name,
    dest_lat: SEJONG.lat,
    dest_lng: SEJONG.lng,
    recurrence_rule: `FREQ=WEEKLY;BYDAY=${BYDAY[weekdayOf(today)]}`, // D44 — 알람은 오늘 회차만 (D4)
  });
  const mock = {
    // 목업 mocks/data.ts 그룹원 하루: [분, 사건]
    me: { travel: 50, prepare: 60, before: 30, buffer: 10, lateCount: 3, timeline: null },
    suyeon: { travel: 70, prepare: 70, before: 8, buffer: 10, lateCount: 0, timeline: { ring: 450, dismiss: 452, confirm: 455, source: 'BUTTON', prep: 458, depart: 520, arrive: 588 } },
    jihyeong: { travel: 60, prepare: 90, before: 40, buffer: 10, lateCount: 0, timeline: { ring: 440, dismiss: 444, confirm: 450, source: 'USAGE', prep: 480, depart: 530, arrive: 592 } },
    junseong: { travel: 25, prepare: 35, before: 8, buffer: 10, lateCount: 2, timeline: { ring: 530, dismiss: 532, confirm: 535, source: 'USAGE', prep: 538, depart: 565, arrive: 591 } },
  };
  const minuteOfToday = (m) => at(today, 0, m);
  for (const u of DEMO_USERS) {
    const o = mock[u.key];
    const made = participate(meeting, u.key, { ...o, withWake: true });
    const tl = o.timeline;
    if (!tl) continue; // 나는 아직 자는 중 — 폰에서 직접 울려 보는 사람
    event(made.byType.WAKE, 'TRIGGERED', minuteOfToday(tl.ring), { input_source: 'BUTTON' });
    event(made.byType.WAKE, 'DISMISSED', minuteOfToday(tl.dismiss), { input_source: 'BUTTON' });
    event(made.byType.WAKE, 'WAKE_CONFIRMED', minuteOfToday(tl.confirm), { input_source: tl.source });
    event(made.byType.PREPARE, 'ACKNOWLEDGED', minuteOfToday(tl.prep), { input_source: 'BUTTON' });
    event(made.byType.DEPARTURE, 'ACKNOWLEDGED', minuteOfToday(tl.depart), { input_source: 'BUTTON' });
    event(made.byType.ARRIVE, 'ARRIVAL_CONFIRMED', minuteOfToday(tl.arrive), { input_source: 'BUTTON' });
    Object.assign(made.participant, { departed_at: minuteOfToday(tl.depart).toISOString(), departed_source: 'BUTTON', arrived_at: minuteOfToday(tl.arrive).toISOString(), arrived_source: 'BUTTON', is_late: false });
  }

  // 나의 개인 약속 (목업 a2 · a3 · a4)
  const dinner = appointment('me', { title: '저녁약속', appointment_at: at(today, 18, 0).toISOString(), dest_name: GANGNAM.name, dest_lat: GANGNAM.lat, dest_lng: GANGNAM.lng, importance: 'LOW' });
  // 그날 첫 일정이 아니라 기상 없이 준비부터 (같은 날 앞에 회의 기상 알람이 있음)
  participate(dinner, 'me', { origin: SEJONG, travel: 20, prepare: 25, buffer: 5, before: 0, withWake: false, lateCount: 3 });
  const dentist = appointment('me', { title: '치과 예약', appointment_at: at(today, 15, 30).toISOString(), dest_name: DENTIST.name, dest_lat: DENTIST.lat, dest_lng: DENTIST.lng, importance: 'LOW' });
  participate(dentist, 'me', { travel: 20, prepare: 25, buffer: 10, before: 0, withWake: false, kinds: [], lateCount: 3 }); // 알람 없는 일정 (D46)
  const tomorrow = addDays(today, 1);
  const lecture = appointment('me', {
    title: '수업',
    appointment_at: at(tomorrow, 9, 0).toISOString(),
    dest_name: SEJONG.name,
    dest_lat: SEJONG.lat,
    dest_lng: SEJONG.lng,
    recurrence_rule: `FREQ=WEEKLY;BYDAY=${BYDAY[weekdayOf(tomorrow)]}`,
  });
  participate(lecture, 'me', { travel: 50, prepare: 40, buffer: 10, before: 10, withWake: true, lateCount: 3 });
  const seminar = appointment('suyeon', { title: '교양 수업', appointment_at: at(tomorrow, 10, 30).toISOString(), dest_name: GWANGHWAMUN.name, dest_lat: GWANGHWAMUN.lat, dest_lng: GWANGHWAMUN.lng, importance: 'LOW' });
  participate(seminar, 'suyeon', { travel: 40, prepare: 60, buffer: 10, before: 10, withWake: true });

  // 일정 없는 기상 알람 (D46 — 평일 7시, 약속 · 루틴과 연결 없음)
  const standaloneIntensity = resolveIntensity('NORMAL', 0).fields;
  t.alarms.push({
    alarm_id: newId(),
    participant_id: null,
    routine_id: null,
    step_order: null,
    user_id: users.me,
    alarm_type: 'WAKE',
    scheduled_at: at(tomorrow, 7, 0).toISOString(),
    intensity: standaloneIntensity.intensity,
    voice_tone: standaloneIntensity.voiceTone,
    sound_key: standaloneIntensity.soundKey,
    is_enabled: true,
    snooze_limit: 3,
    time_source: 'MANUAL',
    intensity_source: 'AUTO',
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    last_calculated_at: now.toISOString(),
  });

  // ---- 나의 지난 4주 (어제부터 28일) ----
  // 평일마다 9시 수업(기상 7:20 · 준비 7:30 · 출발 8:00 · 도착 목표 8:50). 늦잠 지각 3번 = 평일 4 · 10 · 16번째
  const rand = prng(20261015);
  const LATE_WEEKDAYS = new Set([3, 9, 15]);
  let weekdayIndex = 0;
  for (let back = 28; back >= 1; back--) {
    const day = addDays(today, -back);
    const dow = weekdayOf(day);
    const weekend = dow === 0 || dow === 6;
    const sleepAt = at(addDays(day, -1), 23, 20 + Math.floor(rand() * 40));

    if (weekend) {
      const woke = at(day, 9, 30 + Math.floor(rand() * 60));
      t.daily_records.push({ user_id: users.me, record_date: day, sleep_at: sleepAt.toISOString(), wake_reported_at: null, wake_confirmed_at: woke.toISOString(), actual_prepare_minutes: null, data_source: 'MANUAL' });
      continue;
    }

    const late = LATE_WEEKDAYS.has(weekdayIndex++);
    const appt = appointment('me', {
      title: '수업',
      appointment_at: at(day, 9, 0).toISOString(),
      dest_name: SEJONG.name,
      dest_lat: SEJONG.lat,
      dest_lng: SEJONG.lng,
      // 지난 회차는 반복 규칙 없음(기본 null) — 반복 일정은 앞으로 올 "수업" 한 줄뿐. 회차마다 규칙을 달면 H01 · H02에 반복 일정이 20개로 보이고 D4 배치가 시리즈를 따로 만듦
    });
    const made = participate(appt, 'me', { travel: 50, prepare: 40, buffer: 10, before: 10, withWake: true, lateCount: 0 });
    const wakeAt = new Date(made.byType.WAKE.scheduled_at);

    let dismissed;
    let confirmed;
    let prepAck;
    let departed;
    let arrived;
    if (late) {
      // 늦잠: 10분 미루기 두 번, 알람을 끄고도 한참 뒤에야 기상 확인, 서둘러 준비하고 늦게 도착
      event(made.byType.WAKE, 'TRIGGERED', wakeAt, { input_source: 'BUTTON' });
      event(made.byType.WAKE, 'SNOOZED', addMin(wakeAt, 1), { snooze_minutes: 10, sequence_no: 1, input_source: 'BUTTON' });
      event(made.byType.WAKE, 'TRIGGERED', addMin(wakeAt, 11), { sequence_no: 2, input_source: 'BUTTON' });
      event(made.byType.WAKE, 'SNOOZED', addMin(wakeAt, 12), { snooze_minutes: 10, sequence_no: 2, input_source: 'BUTTON' });
      event(made.byType.WAKE, 'TRIGGERED', addMin(wakeAt, 22), { sequence_no: 3, input_source: 'BUTTON' });
      dismissed = addMin(wakeAt, 24);
      confirmed = addMin(wakeAt, 30 + Math.floor(rand() * 8));
      prepAck = addMin(confirmed, 4);
      departed = addMin(prepAck, 22 + Math.floor(rand() * 4));
      const lateBy = 6 + Math.floor(rand() * 9);
      arrived = addMin(new Date(appt.appointment_at), lateBy);
      Object.assign(made.participant, { is_late: true, late_minutes: lateBy });
    } else {
      event(made.byType.WAKE, 'TRIGGERED', wakeAt, { input_source: 'BUTTON' });
      dismissed = addMin(wakeAt, 1 + Math.floor(rand() * 2));
      confirmed = addMin(wakeAt, 3 + Math.floor(rand() * 6));
      prepAck = addMin(confirmed, 6 + Math.floor(rand() * 7));
      departed = new Date(made.byType.DEPARTURE.scheduled_at);
      departed = addMin(departed, -2 + Math.floor(rand() * 6));
      arrived = addMin(new Date(appt.appointment_at), -(2 + Math.floor(rand() * 6)));
      Object.assign(made.participant, { is_late: false });
    }
    event(made.byType.WAKE, 'DISMISSED', dismissed, { input_source: 'BUTTON' });
    event(made.byType.WAKE, 'WAKE_CONFIRMED', confirmed, { input_source: rand() < 0.7 ? 'USAGE' : 'BUTTON' });
    event(made.byType.PREPARE, 'ACKNOWLEDGED', prepAck, { input_source: 'BUTTON' });
    event(made.byType.DEPARTURE, 'ACKNOWLEDGED', departed, { input_source: 'BUTTON' });
    event(made.byType.ARRIVE, 'ARRIVAL_CONFIRMED', arrived, { input_source: 'BUTTON' });
    Object.assign(made.participant, { departed_at: departed.toISOString(), departed_source: 'BUTTON', arrived_at: arrived.toISOString(), arrived_source: 'BUTTON' });

    t.daily_records.push({
      user_id: users.me,
      record_date: day,
      sleep_at: sleepAt.toISOString(),
      wake_reported_at: dismissed.toISOString(),
      wake_confirmed_at: confirmed.toISOString(),
      actual_prepare_minutes: Math.round((departed.getTime() - prepAck.getTime()) / 60_000), // 출발 − 준비 시작
      data_source: 'ALARM',
    });
  }

  // 날짜는 JSON으로 보낼 문자열로
  const iso = (v) => (v instanceof Date ? v.toISOString() : v);
  for (const rows of Object.values(t)) for (const row of rows) for (const k of Object.keys(row)) row[k] = iso(row[k]);

  const counts = Object.fromEntries(Object.entries(t).map(([name, rows]) => [name, rows.length]));
  return { tables: t, counts, eventCount: eventSeq };
}

// 여러 번 넣어도 같은 데이터를 지우려고 계정 이메일 목록을 한 군데에
export const demoEmails = () => DEMO_USERS.map((u) => u.email);
