// 폰 네이티브가 앱 없이 올리는 기록 (alarm-events-device, _shared/device-events.ts) — 실제 서버 코드를 서비스 키 길로 PGlite에 붙여 DB 트리거와 같이 도는지 확인
//   서비스 키는 RLS를 건너뛰므로 알람 주인 확인은 서버 코드가, 나머지(하루 한 건 · 하루 기록 · 원탭 반영)는 DB 트리거가 함:
//     limit_wake_confirmed_per_day (같은 날 둘째 기상 확정은 저장 안 함) · record_wake_on_confirm (확정 시각을 하루 기록에도)
//     apply_participant_times_from_event (원탭 → appointment_participants, 그룹 단계 PR #552 마이그레이션 — main에 아직 없으면 그 항목은 건너뜀)
//   사람은 이 파일 전용 계정. db-check 맨 끝에서 돎 (서버 코드는 .ts라 Node 24의 타입 제거로 바로 불러옴)
export default async function testDeviceEvents({ q, as, su, svc, check }) {
  const { recordDeviceEvents } = await import('../functions/_shared/device-events.ts');
  const U = 'd3000000-0000-4000-8000-000000000001';
  const OTHER = 'd3000000-0000-4000-8000-000000000002';
  const EV = (n) => `d3e00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const iso = (v) => (v instanceof Date ? v.toISOString() : v);
  const fix = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, iso(v)]));

  // 서버 함수가 쓰는 만큼만 흉내 낸 서비스 키 클라이언트 (e2e-suggest.mjs와 같은 방식)
  const run = async (sql, params, single) => {
    await svc();
    try {
      const rows = (await q(sql, params)).map(fix);
      return { data: single ? rows[0] ?? null : rows, error: null };
    } catch (e) {
      return { data: null, error: { code: e.code ?? '', message: e.message } };
    } finally {
      await su();
    }
  };
  const param = (v) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
  class Query {
    constructor(table) { Object.assign(this, { table, op: 'select', cols: '*', where: [], params: [], single: false }); }
    select(cols = '*') { if (this.op === 'select') this.cols = cols; return this; }
    eq(c, v) { this.params.push(v); this.where.push(`${c} = $${this.params.length}`); return this; }
    in(c, list) { this.params.push(list); this.where.push(`${c} = any($${this.params.length})`); return this; }
    maybeSingle() { this.single = true; return this; }
    update(patch) { this.op = 'update'; this.patch = patch; return this; }
    insert(rows) { this.op = 'insert'; this.rows = [].concat(rows); return this; }
    upsert(rows, opts) { this.op = 'upsert'; this.rows = [].concat(rows); this.opts = opts; return this; }
    then(ok, bad) { return this.exec().then(ok, bad); }
    exec() {
      const where = this.where.length ? ` where ${this.where.join(' and ')}` : '';
      if (this.op === 'select') return run(`select ${this.cols} from public.${this.table}${where}`, this.params, this.single);
      if (this.op === 'update') {
        const keys = Object.keys(this.patch);
        const base = this.params.length;
        return run(`update public.${this.table} set ${keys.map((k, i) => `${k} = $${base + i + 1}`).join(', ')}${where}`, [...this.params, ...keys.map((k) => param(this.patch[k]))], false);
      }
      const keys = Object.keys(this.rows[0]);
      const params = [];
      const values = this.rows.map((r) => `(${keys.map((k) => { params.push(param(r[k])); return `$${params.length}`; }).join(', ')})`).join(', ');
      const conflict = this.op === 'upsert' ? ` on conflict (${this.opts.onConflict}) do nothing` : '';
      return run(`insert into public.${this.table} (${keys.join(', ')}) values ${values}${conflict}`, params, false);
    }
  }
  const service = { from: (t) => new Query(t) };

  for (const [uid, email] of [[U, 'device-events-1@example.com'], [OTHER, 'device-events-2@example.com']]) {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email) values ($1, $2)`, [uid, email]);
    await su();
  }
  const [ap] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '기기 시험', '2026-11-19T01:00:00Z', '학교') returning appointment_id`, [U]);
  const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap.appointment_id, U]);
  const alarm = async (type, user = U, participant = pt.participant_id) =>
    (await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, $3, '2026-11-19T00:00:00Z') returning alarm_id`, [participant, user, type]))[0].alarm_id;
  const wakeAlarm = await alarm('WAKE');
  const departAlarm = await alarm('DEPARTURE');
  const arriveAlarm = await alarm('ARRIVE');
  const [otherAp] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '남의 약속', '2026-11-19T01:00:00Z', '학교') returning appointment_id`, [OTHER]);
  const [otherPt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [otherAp.appointment_id, OTHER]);
  const othersWake = await alarm('WAKE', OTHER, otherPt.participant_id);

  const tap = (n, alarmId, type, at, source = 'BUTTON') => ({ alarm_id: alarmId, client_event_id: EV(n), event_type: type, event_at: at, sequence_no: 1, input_source: source });
  const count = async (sql, params) => (await q(sql, params))[0].n;
  const hasChain = (await q(`select to_regprocedure('private.apply_participant_times_from_event()') is not null as has`))[0].has;

  await check('기기 키 길: 알림 버튼 기록이 서비스 키로 alarm_events에 들어가고, 앱이 같은 번호로 다시 올려도(upsert 충돌 무시) 한 줄 · 남의 알람은 건너뜀', async () => {
    const out = await recordDeviceEvents(service, U, { events: [tap(1, departAlarm, 'ACKNOWLEDGED', '2026-11-19T00:10:00Z'), tap(2, othersWake, 'DISMISSED', '2026-11-19T00:11:00Z')] });
    await recordDeviceEvents(service, U, { events: [tap(1, departAlarm, 'ACKNOWLEDGED', '2026-11-19T00:10:00Z')] });
    // 앱(로그인 토큰) 길의 upsert(ignoreDuplicates)
    await as(U);
    await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, client_event_id, input_source) values ($1, $2, 'ACKNOWLEDGED', '2026-11-19T00:10:00Z', $3, 'BUTTON') on conflict (client_event_id) do nothing`, [departAlarm, U, EV(1)]);
    await su();
    const n = await count(`select count(*)::int as n from public.alarm_events where client_event_id = $1`, [EV(1)]);
    const stolen = await count(`select count(*)::int as n from public.alarm_events where alarm_id = $1`, [othersWake]);
    return out.stored === 1 && out.skipped === 1 && n === 1 && stolen === 0 ? true : { out, n, stolen };
  });

  await check(hasChain ? '기기 키 길 + #552 트리거: 출발 · 도착 원탭이 서비스 키 INSERT에서도 appointment_participants에 반영 (BUTTON 출처 · 처음 값 유지)' : '기기 키 길 + #552 트리거: (이 마이그레이션 묶음에 apply_participant_times_from_event가 없어 건너뜀 — #552 브랜치에서 돌려 확인)', async () => {
    if (!hasChain) return true;
    await recordDeviceEvents(service, U, { events: [tap(3, arriveAlarm, 'ARRIVAL_CONFIRMED', '2026-11-19T01:03:00Z')] });
    await recordDeviceEvents(service, U, { events: [tap(4, departAlarm, 'ACKNOWLEDGED', '2026-11-19T00:55:00Z')] }); // 둘째 출발 원탭 — 처음 값(00:10)을 덮지 않음
    const [row] = await q(`select departed_at, departed_source, arrived_at, arrived_source, is_late from public.appointment_participants where participant_id = $1`, [pt.participant_id]);
    const ok = new Date(row.departed_at).toISOString() === '2026-11-19T00:10:00.000Z' && row.departed_source === 'BUTTON' && new Date(row.arrived_at).toISOString() === '2026-11-19T01:03:00.000Z' && row.arrived_source === 'BUTTON' && row.is_late === false;
    return ok ? true : row;
  });

  await check('기기 키 길 + 기상 확정: 해제 · 확정 이벤트와 하루 기록이 한 줄씩 — record_wake_on_confirm이 하루 기록을 또 만들지 않고 처음 확정 시각이 남음', async () => {
    const reached = '2026-11-19T00:01:00.000Z'; // 한국 시간 9:01
    const body = {
      events: [tap(5, wakeAlarm, 'DISMISSED', '2026-11-19T00:00:00Z'), tap(6, wakeAlarm, 'WAKE_CONFIRMED', reached, 'USAGE')],
      wake: { alarm_id: wakeAlarm, record_date: '2026-11-19', wake_confirmed_at: reached, wake_reported_at: '2026-11-19T00:00:00.000Z' },
    };
    const out = await recordDeviceEvents(service, U, body);
    await recordDeviceEvents(service, U, body); // 재시도
    const events = await count(`select count(*)::int as n from public.alarm_events where alarm_id = $1 and event_type in ('DISMISSED', 'WAKE_CONFIRMED')`, [wakeAlarm]);
    const days = (await q(`select record_date::text as d, wake_confirmed_at, wake_reported_at, data_source from public.daily_records where user_id = $1`, [U])).map(fix);
    const ok = out.stored === 2 && out.wake_recorded === true && events === 2 && days.length === 1 && days[0].d === '2026-11-19' && days[0].wake_confirmed_at === reached && days[0].wake_reported_at === '2026-11-19T00:00:00.000Z';
    return ok ? true : { out, events, days };
  });

  await check('기기 키 길 + limit_wake_confirmed_per_day: 같은 날 앱이 다른 번호로 기상 확정을 또 올려도 둘째는 저장 안 함 (오류 없이) · 하루 기록은 그대로', async () => {
    await as(U);
    await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, client_event_id, input_source) values ($1, $2, 'WAKE_CONFIRMED', '2026-11-19T00:20:00Z', $3, 'USAGE')`, [wakeAlarm, U, EV(7)]);
    await su();
    const n = await count(`select count(*)::int as n from public.alarm_events where alarm_id = $1 and event_type = 'WAKE_CONFIRMED'`, [wakeAlarm]);
    const [day] = (await q(`select wake_confirmed_at from public.daily_records where user_id = $1`, [U])).map(fix);
    return n === 1 && day.wake_confirmed_at === '2026-11-19T00:01:00.000Z' ? true : { n, day };
  });

  await check('기기 키 길: 폰이 안 보내는 조합(WAKE_CONFIRMED + BUTTON · 도착 알람의 해제)은 서비스 키로도 DB에 안 들어감', async () => {
    const out = await recordDeviceEvents(service, U, { events: [tap(8, arriveAlarm, 'DISMISSED', '2026-11-19T00:30:00Z'), tap(9, wakeAlarm, 'WAKE_CONFIRMED', '2026-11-19T00:31:00Z', 'BUTTON')] });
    const n = await count(`select count(*)::int as n from public.alarm_events where client_event_id = any($1)`, [[EV(8), EV(9)]]);
    return out.stored === 0 && n === 0 ? true : { out, n };
  });

  await check(hasChain ? '기기 키 길 + 해제 반영: 준비 알람 해제 = 준비 시작(PREPARE_ALARM), 출발 알람 해제 = 출발(BUTTON), 둘 다 빈 칸만 — 울림 · 미루기 기록은 참여 행을 안 건드림' : '기기 키 길 + 해제 반영 (트리거 없는 main이라 건너뜀)', async () => {
    if (!hasChain) return true;
    const [ap2] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '해제 시험', '2026-11-20T01:00:00Z', '학교') returning appointment_id`, [U]);
    const [pt2] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap2.appointment_id, U]);
    const prep = await alarm('PREPARE', U, pt2.participant_id);
    const depart = await alarm('DEPARTURE', U, pt2.participant_id);
    await recordDeviceEvents(service, U, { events: [tap(10, prep, 'TRIGGERED', '2026-11-20T00:00:00Z'), tap(11, prep, 'SNOOZED', '2026-11-20T00:01:00Z')] });
    await recordDeviceEvents(service, U, { events: [tap(12, depart, 'TRIGGERED', '2026-11-20T00:20:00Z')] });
    const [mid] = await q(`select prepare_started_at, departed_at from public.appointment_participants where participant_id = $1`, [pt2.participant_id]);
    await recordDeviceEvents(service, U, { events: [tap(13, prep, 'DISMISSED', '2026-11-20T00:05:00Z')] });
    await recordDeviceEvents(service, U, { events: [tap(14, prep, 'DISMISSED', '2026-11-20T00:40:00Z'), tap(15, depart, 'DISMISSED', '2026-11-20T00:25:00Z')] }); // 둘째 해제는 처음 값을 안 덮음
    await recordDeviceEvents(service, U, { events: [tap(16, depart, 'DISMISSED', '2026-11-20T00:50:00Z')] });
    const [row] = (await q(`select prepare_started_at, prepare_started_source, departed_at, departed_source from public.appointment_participants where participant_id = $1`, [pt2.participant_id])).map(fix);
    const ok = mid.prepare_started_at === null && mid.departed_at === null
      && row.prepare_started_at === '2026-11-20T00:05:00.000Z' && row.prepare_started_source === 'PREPARE_ALARM'
      && row.departed_at === '2026-11-20T00:25:00.000Z' && row.departed_source === 'BUTTON';
    return ok ? true : { mid, row };
  });

  await su();
  await q(`delete from public.appointments where creator_id in ($1, $2)`, [U, OTHER]);
  await q(`delete from public.daily_records where user_id in ($1, $2)`, [U, OTHER]);
  await q(`delete from public.alarm_events where user_id in ($1, $2)`, [U, OTHER]);
  await q(`delete from public.alarms where user_id in ($1, $2)`, [U, OTHER]);
}
