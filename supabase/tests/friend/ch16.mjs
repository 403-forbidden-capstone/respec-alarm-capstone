// 친구 16장 — 그룹 화면 출발 · 도착 단계 (11/19 지형님: D59 '기상까지만' → '도착까지')
//   ① 출발 · 도착 공유 동의(trip_share_opt_in)  ② 기상 조회에 departed_at · arrived_at · trip_visible  ③ 이른 위치 출발 막기
//   ④ 원탭(alarm_events)을 서버가 바로 appointment_participants에 반영  ⑤ 출발 · 도착이 바뀔 때 새로 고침 신호
//   시간이 걸린 규칙(20분)은 이 장에서 안 봄(기상 판정 그대로). 사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch16({ q, as, su, svc, check, expectErr }) {
  const id = (n) => `b6a00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const D = '2026-11-10';                    // 고정 날짜(한국 시간). 공개 함수는 오늘 기준이라 따로 TODAY를 씀
  const TODAY = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const at = (hhmm, day = D) => `${day}T${hhmm}:00+09:00`;
  const iso = (v) => (v == null ? null : new Date(v).toISOString());

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f16-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f16_user_${n}`]);
    return id(n);
  };
  const call = async (uid, sql, params = []) => { await as(uid); const [r] = await q(`select ${sql} as r`, params); await su(); return r.r; };
  // 그룹 — 만든 사람은 트리거가 참여 중으로 넣고, 나머지는 바로 참여 중. opts = { uid: [wake, trip] }
  const mkGroup = async (owner, others = [], opts = {}) => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('단계그룹', $1) returning group_id`, [owner]);
    await su();
    for (const u of others) {
      const [wake, trip] = opts[u] ?? [false, false];
      await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in, trip_share_opt_in) values ($1, $2, 'JOINED', now(), $3, $4)`, [g.group_id, u, wake, trip]);
    }
    if (opts[owner]) await q(`update public.group_members set wake_share_opt_in = $3, trip_share_opt_in = $4 where group_id = $1 and user_id = $2`, [g.group_id, owner, ...opts[owner]]);
    return g.group_id;
  };
  const appt = async (owner, g, when, extra = '') => (await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '단계 약속', $3::timestamptz, '학교') returning appointment_id`, [owner, g, when]))[0].appointment_id;
  const part = async (ap, u, { buffer = 10, travel = null } = {}) => (await q(`insert into public.appointment_participants (appointment_id, user_id, buffer_minutes, est_travel_minutes) values ($1, $2, $3, $4) returning participant_id`, [ap, u, buffer, travel]))[0].participant_id;
  const alarm = async (u, pid, type, when) => (await q(`insert into public.alarms (user_id, participant_id, alarm_type, scheduled_at) values ($1, $2, $3, $4::timestamptz) returning alarm_id`, [u, pid, type, when]))[0].alarm_id;
  const ev = (alarmId, u, type, when, src = null) => q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, input_source) values ($1, $2, $3, $4::timestamptz, $5)`, [alarmId, u, type, when, src]);
  const rows = (viewer, g, date = D, now = at('12:00')) => q(`select * from private.group_wake_rows($1, $2, $3::date, $4::timestamptz) order by is_me desc, user_id`, [viewer, g, date, now]);
  const of = (r, u) => r.find((x) => x.user_id === u);
  const pt = async (pid) => (await q(`select departed_at, departed_source, arrived_at, arrived_source, is_late, late_minutes, actual_travel_minutes, prepare_started_at, prepare_started_source from public.appointment_participants where participant_id = $1`, [pid]))[0];
  const setTimes = (pid, set) => q(`update public.appointment_participants set ${set} where participant_id = $1`, [pid]);
  const signals = () => q(`select topic, event, payload from realtime.messages order by id`);
  const clearSignals = () => q(`truncate realtime.messages`);

  await check('16-01 · 16-02: 출발 · 도착 공유 — 끈 사람은 시각이 null · trip_visible false, 켠 사람은 시각이 나오고, 내 줄은 동의와 상관없이 늘 보임', async () => {
    const A = await join_(1, '보는이'), B = await join_(2, '켬'), C = await join_(3, '끔');
    const g = await mkGroup(A, [B, C], { [A]: [true, false], [B]: [true, true], [C]: [true, false] });
    const ap = await appt(A, g, at('10:00'));
    const pa = await part(ap, A), pb = await part(ap, B), pc = await part(ap, C);
    await setTimes(pa, `departed_at = '${at('08:40')}', departed_source = 'BUTTON'`);
    await setTimes(pb, `departed_at = '${at('08:30')}', departed_source = 'BUTTON', arrived_at = '${at('09:50')}', arrived_source = 'BUTTON'`);
    await setTimes(pc, `departed_at = '${at('08:20')}', departed_source = 'BUTTON'`);
    const r = await rows(A, g);
    const a = of(r, A), b = of(r, B), c = of(r, C);
    return a.trip_visible === true && iso(a.departed_at) === iso(at('08:40')) && a.arrived_at == null
      && b.trip_visible === true && iso(b.departed_at) === iso(at('08:30')) && iso(b.arrived_at) === iso(at('09:50'))
      && c.trip_visible === false && c.departed_at == null && c.arrived_at == null && c.wake_status === 'NO_ALARM' ? true : { a, b, c };
  });

  await check('16-03: 공개 함수 get_group_wake · get_group_wake_status가 같은 세 칸(departed_at · arrived_at · trip_visible)을 돌려줌 — 동의 안 한 사람 줄은 null, 권한은 authenticated만', async () => {
    const A = await join_(4, '보는이'), B = await join_(5, '켬'), C = await join_(6, '끔');
    const g = await mkGroup(A, [B, C], { [A]: [true, false], [B]: [true, true], [C]: [true, false] });
    const ap = await appt(A, g, `${TODAY}T23:00:00+09:00`);
    const pb = await part(ap, B), pc = await part(ap, C);
    await setTimes(pb, `departed_at = now() - interval '5 minutes', departed_source = 'BUTTON'`);
    await setTimes(pc, `departed_at = now() - interval '5 minutes', departed_source = 'BUTTON'`);
    await as(A);
    const w = await q(`select * from public.get_group_wake($1)`, [g]);
    const s = await q(`select * from public.get_group_wake_status($1)`, [g]);
    await su();
    const [fn] = await q(`select has_function_privilege('authenticated', 'public.get_group_wake(uuid, date)', 'execute') as a1,
                                 has_function_privilege('anon', 'public.get_group_wake(uuid, date)', 'execute') as n1,
                                 has_function_privilege('authenticated', 'public.get_group_wake_status(uuid, date)', 'execute') as a2,
                                 has_function_privilege('anon', 'public.get_group_wake_status(uuid, date)', 'execute') as n2,
                                 has_function_privilege('authenticated', 'private.group_wake_rows(uuid, uuid, date, timestamptz)', 'execute') as a3`);
    const cols = ['departed_at', 'arrived_at', 'trip_visible'].every((k) => k in w[0] && k in s[0]);
    return cols && of(w, B).trip_visible === true && of(w, B).departed_at != null && of(w, C).trip_visible === false && of(w, C).departed_at == null
      && of(s, B).departed_at != null && of(s, C).departed_at == null
      && fn.a1 === true && fn.n1 === false && fn.a2 === true && fn.n2 === false && fn.a3 === false ? true : { w, s, fn };
  });

  await check('16-04: 그 그룹 공동 약속만 — 개인 일정(group_id 없음) · 다른 그룹 약속의 출발은 안 보이고, 그날이 아닌 약속도 안 보임', async () => {
    const A = await join_(7, '에이'), B = await join_(8, '비');
    const g = await mkGroup(A, [B], { [A]: [true, true], [B]: [true, true] });
    const g2 = await mkGroup(A, [B], { [A]: [true, true], [B]: [true, true] });
    const ap = await appt(A, g, at('19:00'));
    await part(ap, B);
    const solo = (await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '개인', $2::timestamptz, '집') returning appointment_id`, [B, at('12:00')]))[0].appointment_id;
    const other = await appt(A, g2, at('13:00'));
    const next = await appt(A, g, at('10:00', '2026-11-11'));
    for (const a2 of [solo, other, next]) {
      const p2 = await part(a2, B);
      await setTimes(p2, `departed_at = '${at('09:00')}', departed_source = 'BUTTON'`);
    }
    const r = await rows(A, g);
    return of(r, B).departed_at == null && of(r, B).arrived_at == null && of(r, B).trip_visible === true ? true : of(r, B);
  });

  await check('16-05: 같은 날 이 그룹 약속이 여럿이면 — 아직 도착 안 한 것 중 가장 이른 약속, 다 도착했으면 가장 늦은 약속', async () => {
    const A = await join_(9, '에이'), B = await join_(10, '비');
    const g = await mkGroup(A, [B], { [A]: [true, true], [B]: [true, true] });
    const a1 = await appt(A, g, at('09:00')), a2 = await appt(A, g, at('13:00')), a3 = await appt(A, g, at('18:00'));
    const p1 = await part(a1, B), p2 = await part(a2, B), p3 = await part(a3, B);
    await setTimes(p1, `departed_at = '${at('08:00')}', departed_source = 'BUTTON', arrived_at = '${at('08:50')}', arrived_source = 'BUTTON'`);
    await setTimes(p2, `departed_at = '${at('12:10')}', departed_source = 'BUTTON'`);
    await setTimes(p3, `departed_at = '${at('17:00')}', departed_source = 'BUTTON'`);
    const mid = of(await rows(A, g), B);                  // 첫 약속은 도착함 → 안 도착한 것 중 이른 13:00 약속(12:10 출발)
    await setTimes(p2, `arrived_at = '${at('12:55')}', arrived_source = 'BUTTON'`);
    const later = of(await rows(A, g), B);                // 13:00 도착 → 남은 18:00 약속(17:00 출발)
    await setTimes(p3, `arrived_at = '${at('17:50')}', arrived_source = 'BUTTON'`);
    const all = of(await rows(A, g), B);                  // 다 도착 → 가장 늦은 18:00 약속
    return iso(mid.departed_at) === iso(at('12:10')) && mid.arrived_at == null
      && iso(later.departed_at) === iso(at('17:00')) && later.arrived_at == null
      && iso(all.departed_at) === iso(at('17:00')) && iso(all.arrived_at) === iso(at('17:50')) ? true : { mid, later, all };
  });

  await check('16-06: 기상을 숨기거나 차단한 사이, 기상 공유를 끈 사람은 출발 · 도착이 켜져 있어도 줄 자체가 없음', async () => {
    const A = await join_(11, '보는이'), H = await join_(12, '숨김'), K = await join_(13, '차단'), W = await join_(14, '기상끔');
    const g = await mkGroup(A, [H, K, W], { [A]: [true, true], [H]: [true, true], [K]: [true, true], [W]: [true, true] });
    const ap = await appt(A, g, at('10:00'));
    for (const u of [H, K, W]) { const p = await part(ap, u); await setTimes(p, `departed_at = '${at('09:00')}', departed_source = 'BUTTON'`); }
    const before = await rows(A, g);
    await call(H, 'public.set_wake_hidden($1, $2)', [A, true]);
    await call(K, 'public.block_user($1)', [A]);
    await q(`update public.group_members set wake_share_opt_in = false where group_id = $1 and user_id = $2`, [g, W]);
    const after = await rows(A, g);
    return before.length === 4 && after.length === 1 && after[0].user_id === A ? true : { before: before.length, after };
  });

  await check('16-07: 동의 규칙 — 기상 공유를 끄면 출발 · 도착 공유도 꺼지고, 기상 공유가 꺼진 채 켜려 하면 꺼진 채로 남고, 나갔다 들어와도 꺼진 채 시작', async () => {
    const A = await join_(15, '에이'), B = await join_(16, '비');
    const g = await mkGroup(A, [B], { [A]: [true, false], [B]: [true, true] });
    const get = async (u) => (await q(`select wake_share_opt_in as w, trip_share_opt_in as t from public.group_members where group_id = $1 and user_id = $2`, [g, u]))[0];
    const start = await get(B);
    await as(B);                                            // 본인 행 갱신은 기존 RLS로
    await q(`update public.group_members set wake_share_opt_in = false where group_id = $1 and user_id = $2`, [g, B]);
    await su();
    const wakeOff = await get(B);
    await as(B);
    await q(`update public.group_members set trip_share_opt_in = true where group_id = $1 and user_id = $2`, [g, B]);
    await su();
    const tripWithoutWake = await get(B);
    await as(B);
    await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [g, B]);
    await q(`update public.group_members set trip_share_opt_in = true where group_id = $1 and user_id = $2`, [g, B]);
    await su();
    const on = await get(B);
    await as(B);
    await q(`update public.group_members set wake_share_opt_in = true, trip_share_opt_in = true where group_id = $1 and user_id = $2`, [g, B]);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, B]);
    await su();
    const left = await get(B);
    const [def] = await q(`select column_default, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'group_members' and column_name = 'trip_share_opt_in'`);
    return start.t === true && wakeOff.w === false && wakeOff.t === false && tripWithoutWake.t === false && on.w === true && on.t === true
      && left.t === false && def.column_default === 'false' && def.is_nullable === 'NO' ? true : { start, wakeOff, tripWithoutWake, on, left, def };
  });

  await check('16-08: 참여 중이 아닌 사람은 출발 · 도착 공유를 못 바꿈 (기상 공유와 같은 보호) · 남의 행은 못 고침', async () => {
    const A = await join_(17, '에이'), B = await join_(18, '초대만'), X = await join_(19, '남');
    const g = await mkGroup(A, [X], { [A]: [true, false], [X]: [true, false] });
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g, B]);
    await as(B);
    const invited = await expectErr(() => q(`update public.group_members set trip_share_opt_in = true where group_id = $1 and user_id = $2`, [g, B]), /참여 중일 때만/);
    await su();
    await as(X);
    const others = await q(`update public.group_members set trip_share_opt_in = true where group_id = $1 and user_id = $2 returning 1`, [g, A]);
    await su();
    return invited === true && others.length === 0 ? true : { invited, others };
  });

  await check('16-09: 이른 위치 출발은 조용히 무시 — 출발 예정 − 60분보다 이르면 앞 값(없으면 null)이 남고 오류 없음, 경계 안쪽 · 버튼은 그대로 들어감', async () => {
    const A = await join_(20, '에이');
    const g = await mkGroup(A, [], {});
    const ap = await appt(A, g, at('10:00'));
    const p = await part(ap, A, { buffer: 10, travel: 30 });         // 출발 예정 = 10:00 − 40분 = 09:20, 창 시작 08:20
    await setTimes(p, `departed_at = '${at('06:27')}', departed_source = 'LOCATION'`);
    const early = await pt(p);
    await setTimes(p, `departed_at = '${at('08:19')}', departed_source = 'LOCATION'`);
    const justEarly = await pt(p);
    await setTimes(p, `departed_at = '${at('08:20')}', departed_source = 'LOCATION'`);
    const edge = await pt(p);
    await setTimes(p, `departed_at = '${at('06:30')}', departed_source = 'LOCATION'`);        // 이미 08:20이 있고 이른 값이 또 와도 앞 값 유지
    const keep = await pt(p);
    await setTimes(p, `departed_at = '${at('06:40')}', departed_source = 'BUTTON'`);          // 버튼은 막지 않음
    const button = await pt(p);
    return early.departed_at == null && early.departed_source == null
      && justEarly.departed_at == null
      && iso(edge.departed_at) === iso(at('08:20')) && edge.departed_source === 'LOCATION'
      && iso(keep.departed_at) === iso(at('08:20'))
      && iso(button.departed_at) === iso(at('06:40')) && button.departed_source === 'BUTTON' ? true : { early, justEarly, edge, keep, button };
  });

  await check('16-10: 출발 알람이 있으면 그 시각이 출발 예정 — 알람 09:00이면 07:59 위치 출발은 무시 · 08:00은 들어감, 새 참여 조건을 만들며 넣는 이른 위치 출발도 비워서 저장', async () => {
    const A = await join_(21, '에이');
    const g = await mkGroup(A, [], {});
    const ap = await appt(A, g, at('11:00'));
    const p = await part(ap, A, { buffer: 10, travel: 30 });
    await alarm(A, p, 'DEPARTURE', at('09:00'));
    await setTimes(p, `departed_at = '${at('07:59')}', departed_source = 'LOCATION'`);
    const early = await pt(p);
    await setTimes(p, `departed_at = '${at('08:00')}', departed_source = 'LOCATION'`);
    const ok = await pt(p);
    const ap2 = await appt(A, g, at('15:00'));
    const [ins] = await q(`insert into public.appointment_participants (appointment_id, user_id, buffer_minutes, departed_at, departed_source)
                           values ($1, $2, 10, $3::timestamptz, 'LOCATION') returning departed_at, departed_source`, [ap2, A, at('06:00')]);
    return early.departed_at == null && iso(ok.departed_at) === iso(at('08:00')) && ins.departed_at == null && ins.departed_source == null ? true : { early, ok, ins };
  });

  await check('16-11: 원탭 서버 반영 — 출발 · 도착 · 준비 시작 기록이 올라오면 참여 조건에 바로 채워짐(출처 BUTTON · PREPARE_ALARM), 지각은 약속 + 5분 초과일 때만', async () => {
    const A = await join_(22, '에이');
    const g = await mkGroup(A, [], {});
    const ap = await appt(A, g, at('10:00'));
    const p = await part(ap, A);
    const pre = await alarm(A, p, 'PREPARE', at('07:30')), dep = await alarm(A, p, 'DEPARTURE', at('08:50')), arr = await alarm(A, p, 'ARRIVE', at('10:00'));
    await ev(pre, A, 'ACKNOWLEDGED', at('07:32'), 'BUTTON');
    await ev(dep, A, 'ACKNOWLEDGED', at('08:55'), 'BUTTON');
    const mid = await pt(p);
    await ev(arr, A, 'ARRIVAL_CONFIRMED', at('10:05'), 'BUTTON');
    const onTime = await pt(p);                     // 정확히 +5분은 지각 아님
    const ap2 = await appt(A, g, at('10:00', '2026-11-11'));
    const p2 = await part(ap2, A);
    const arr2 = await alarm(A, p2, 'ARRIVE', at('10:00', '2026-11-11'));
    await ev(arr2, A, 'ARRIVAL_CONFIRMED', at('10:12', '2026-11-11'), null);       // 출처 비어 있음(옛 앱) = BUTTON
    const late = await pt(p2);
    return iso(mid.prepare_started_at) === iso(at('07:32')) && mid.prepare_started_source === 'PREPARE_ALARM'
      && iso(mid.departed_at) === iso(at('08:55')) && mid.departed_source === 'BUTTON' && mid.arrived_at == null
      && iso(onTime.arrived_at) === iso(at('10:05')) && onTime.arrived_source === 'BUTTON' && onTime.is_late === false && onTime.late_minutes === 0
      && iso(late.arrived_at) === iso(at('10:12', '2026-11-11')) && late.is_late === true && late.late_minutes === 12 ? true : { mid, onTime, late };
  });

  await check('16-12: 원탭 우선순위 · 멱등 — 응답이 위치 값을 덮고(이동시간 비움), 응답끼리는 먼저 쓴 값 유지, 위치 기록 · 준비 해제 · 다른 종류 기록은 건드리지 않고, 같은 기록이 다시 와도 같은 결과', async () => {
    const A = await join_(23, '에이');
    const g = await mkGroup(A, [], {});
    const ap = await appt(A, g, at('10:00'));
    const p = await part(ap, A);
    const pre = await alarm(A, p, 'PREPARE', at('07:30')), dep = await alarm(A, p, 'DEPARTURE', at('08:50')), arr = await alarm(A, p, 'ARRIVE', at('10:00'));
    await setTimes(p, `departed_at = '${at('08:45')}', departed_source = 'LOCATION', arrived_at = '${at('09:58')}', arrived_source = 'LOCATION', actual_travel_minutes = 77`);
    await ev(dep, A, 'ACKNOWLEDGED', at('08:52'), 'LOCATION');           // 위치로 남긴 기록은 다시 반영 안 함
    await ev(arr, A, 'ARRIVAL_CONFIRMED', at('09:58'), 'LOCATION');
    const loc = await pt(p);
    await ev(dep, A, 'ACKNOWLEDGED', at('08:55'), 'BUTTON');             // 응답이 위치 값을 덮음
    await ev(arr, A, 'ARRIVAL_CONFIRMED', at('10:01'), 'BUTTON');
    const over = await pt(p);
    await ev(dep, A, 'ACKNOWLEDGED', at('08:40'), 'BUTTON');             // 응답끼리는 먼저 쓴 값
    await ev(arr, A, 'ARRIVAL_CONFIRMED', at('09:30'), 'BUTTON');
    const keep = await pt(p);
    await ev(pre, A, 'ACKNOWLEDGED', at('07:31'), 'BUTTON');
    await ev(pre, A, 'DISMISSED', at('07:40'), 'BUTTON');                // 준비 시작은 처음 한 번만
    const once = await pt(p);
    await ev(arr, A, 'TRIGGERED', at('10:00'), null);                    // 울림은 영향 없음
    const same = await pt(p);
    return loc.departed_source === 'LOCATION' && iso(loc.departed_at) === iso(at('08:45')) && loc.arrived_source === 'LOCATION' && loc.actual_travel_minutes === 77
      && iso(over.departed_at) === iso(at('08:55')) && over.departed_source === 'BUTTON' && iso(over.arrived_at) === iso(at('10:01')) && over.arrived_source === 'BUTTON'
      && over.actual_travel_minutes == null && over.is_late === false
      && iso(keep.departed_at) === iso(at('08:55')) && iso(keep.arrived_at) === iso(at('10:01'))
      && iso(once.prepare_started_at) === iso(at('07:31')) && JSON.stringify(same) === JSON.stringify(once) ? true : { loc, over, keep, once, same };
  });

  await check('16-13: 원탭 서버 반영은 일정 없는 알람 · 남의 참여 조건 · 응답 값이 이미 있는 칸을 건드리지 않음 — 위치 값도 응답 값도 없는 칸만 채움', async () => {
    const A = await join_(24, '에이'), B = await join_(25, '비');
    const g = await mkGroup(A, [B], {});
    const ap = await appt(A, g, at('10:00'));
    const pa = await part(ap, A), pb = await part(ap, B);
    const depA = await alarm(A, pa, 'DEPARTURE', at('08:50'));
    const loose = (await q(`insert into public.alarms (user_id, alarm_type, scheduled_at, routine_id, step_order) select $1, 'DEPARTURE', $2::timestamptz, r.routine_id, 1 from public.routines r limit 1`, [A, at('08:50')]));
    await setTimes(pb, `departed_at = '${at('08:30')}', departed_source = 'MANUAL'`);
    await ev(depA, B, 'ACKNOWLEDGED', at('08:56'), 'BUTTON');            // 알람 주인이 아닌 사람 이름으로 온 기록 → 무시
    const notMine = await pt(pa);
    await ev(depA, A, 'ACKNOWLEDGED', at('08:56'), 'BUTTON');
    await ev(depA, A, 'ACKNOWLEDGED', at('08:30'), 'MANUAL');            // 직접 입력 출처는 이 길로 안 받음
    const mine = await pt(pa);
    const other = await pt(pb);
    return notMine.departed_at == null && iso(mine.departed_at) === iso(at('08:56')) && mine.departed_source === 'BUTTON' && other.departed_source === 'MANUAL' && Array.isArray(loose) ? true : { notMine, mine, other };
  });

  await check('16-14: 출발 · 도착이 바뀌면 그 그룹 채널(group:<id>:wake)에 새로 고침 신호 — 내용은 약속 날짜뿐, 지워져도 보냄, 원탭 기록으로 바뀌어도 보냄', async () => {
    const A = await join_(26, '에이'), B = await join_(27, '비');
    const g = await mkGroup(A, [B], { [A]: [true, true], [B]: [true, true] });
    const ap = await appt(A, g, at('10:00'));
    const p = await part(ap, B);
    const dep = await alarm(B, p, 'DEPARTURE', at('08:50'));
    await clearSignals();
    await setTimes(p, `departed_at = '${at('08:45')}', departed_source = 'LOCATION'`);
    const s1 = await signals();
    await clearSignals();
    await setTimes(p, `departed_at = null, departed_source = null`);                     // [아니에요]로 지움
    const s2 = await signals();
    await clearSignals();
    await ev(dep, B, 'ACKNOWLEDGED', at('08:55'), 'BUTTON');
    const s3 = await signals();
    await clearSignals();
    await setTimes(p, `is_late = false`);                                                // 출발 · 도착이 안 바뀌면 신호 없음
    const s4 = await signals();
    const ok = (s) => s.length === 1 && s[0].topic === `group:${g}:wake` && s[0].event === 'refresh' && JSON.stringify(s[0].payload) === JSON.stringify({ date: D });
    return ok(s1) && ok(s2) && ok(s3) && s4.length === 0 ? true : { s1, s2, s3, s4 };
  });

  await check('16-15: 신호 조건 — 출발 · 도착 공유를 끈 사람 · 기상 공유를 끈 사람 · 개인 일정 · 그룹을 나간 사람은 신호 없음', async () => {
    const A = await join_(28, '에이'), N = await join_(29, '출발끔'), W = await join_(30, '기상끔');
    const g = await mkGroup(A, [N, W], { [A]: [true, true], [N]: [true, false], [W]: [false, false] });
    const ap = await appt(A, g, at('10:00'));
    const pn = await part(ap, N), pw = await part(ap, W);
    const solo = (await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '개인', $2::timestamptz, '집') returning appointment_id`, [A, at('12:00')]))[0].appointment_id;
    const ps = await part(solo, A);
    await clearSignals();
    for (const x of [pn, pw, ps]) await setTimes(x, `departed_at = '${at('09:00')}', departed_source = 'BUTTON'`);
    const none = await signals();
    return none.length === 0 ? true : none;
  });
}
