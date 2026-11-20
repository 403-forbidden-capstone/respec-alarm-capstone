// 친구 17장 — 그룹 포인트: 준비 · 출발 알람 해제 반영 · 준비 시각 칸 · 새로 고침 신호 (11/19 지형님: 기상 · 준비 · 출발이 모두 진짜 알람)
//   ① 해제 → 참여 행: 준비 알람 해제 = prepare_started_at, 출발 알람 해제는 출발을 안 바꿈(출발 = 위치 자동, 감지 꺼진 폰만 ACKNOWLEDGED(DEPARTURE)), 빈 칸만
//   ② 그룹 조회 새 칸: prepare_alarm_at(켜진 PREPARE 알람 시각) · prepare_started_at — trip_visible일 때만, 같은 약속 고르기 규칙, 기상 없는 날도 있음
//   ③ 새로 고침 신호: 준비 시작 · 공유 바꿈 · 나가기 / 내보내짐 · 약속에서 빠짐 · 약속 시각 변경 / 취소 · 기상 숨기기 / 보이기 — 값만 바뀐 그룹에, 하나의 변경에 한 번
//   날짜는 고정 날짜 말고 오늘(한국 시간) 기준. 사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch17({ q, as, su, check }) {
  const id = (n) => `b6b00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const KST = 9 * 3600_000;
  const dayPlus = (n) => new Date(Date.parse(`${new Date(Date.now() + KST - 4 * 3600_000).toISOString().slice(0, 10)}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const TODAY = dayPlus(0);
  const at = (hhmm, day = TODAY) => `${day}T${hhmm}:00+09:00`;
  const iso = (v) => (v == null ? null : new Date(v).toISOString());

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f17-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f17_user_${n}`]);
    return id(n);
  };
  const call = async (uid, sql, params = []) => { await as(uid); const [r] = await q(`select ${sql} as r`, params); await su(); return r.r; };
  // 그룹 — opts = { uid: [wake, trip] } (만든 사람 포함)
  const mkGroup = async (owner, others = [], opts = {}) => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('포인트그룹', $1) returning group_id`, [owner]);
    await su();
    for (const u of others) {
      const [wake, trip] = opts[u] ?? [false, false];
      await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in, trip_share_opt_in) values ($1, $2, 'JOINED', now(), $3, $4)`, [g.group_id, u, wake, trip]);
    }
    if (opts[owner]) await q(`update public.group_members set wake_share_opt_in = $3, trip_share_opt_in = $4 where group_id = $1 and user_id = $2`, [g.group_id, owner, ...opts[owner]]);
    return g.group_id;
  };
  const appt = async (owner, g, when) => (await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '포인트 약속', $3::timestamptz, '학교') returning appointment_id`, [owner, g, when]))[0].appointment_id;
  const part = async (ap, u) => (await q(`insert into public.appointment_participants (appointment_id, user_id, buffer_minutes, est_travel_minutes) values ($1, $2, 10, 30) returning participant_id`, [ap, u]))[0].participant_id;
  const alarm = async (u, pid, type, when) => (await q(`insert into public.alarms (user_id, participant_id, alarm_type, scheduled_at) values ($1, $2, $3, $4::timestamptz) returning alarm_id`, [u, pid, type, when]))[0].alarm_id;
  const ev = (alarmId, u, type, when, src = 'BUTTON') => q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, input_source) values ($1, $2, $3, $4::timestamptz, $5)`, [alarmId, u, type, when, src]);
  const rows = (viewer, g, date = TODAY, now = at('12:00')) => q(`select * from private.group_wake_rows($1, $2, $3::date, $4::timestamptz) order by is_me desc, user_id`, [viewer, g, date, now]);
  const of = (r, u) => r.find((x) => x.user_id === u);
  const pt = async (pid) => (await q(`select prepare_started_at, prepare_started_source, departed_at, departed_source, arrived_at from public.appointment_participants where participant_id = $1`, [pid]))[0];
  const topic = (g) => `group:${g}:wake`;
  const sigs = async (g) => (await q(`select payload from realtime.messages where topic = $1 and event = 'refresh' order by id`, [topic(g)])).map((r) => r.payload?.date ?? null);
  const clear = () => q(`truncate realtime.messages`);
  const eq = (got, want) => (JSON.stringify(got) === JSON.stringify(want) ? true : { got, want });

  // 약속 하나 + 사람별 참여 · 준비 · 출발 알람 (기상 알람은 wake에 시각이 있을 때만)
  const setup = async (n0, { when = at('10:00'), prepAt = at('08:50'), depAt = at('09:20'), wake = null, share = [true, true] } = {}) => {
    const A = await join_(n0, '에이'), B = await join_(n0 + 1, '비');
    const g = await mkGroup(A, [B], { [A]: share, [B]: share });
    const ap = await appt(A, g, when);
    const out = { A, B, g, ap, P: {}, AL: {} };
    for (const [k, u] of [['A', A], ['B', B]]) {
      out.P[k] = await part(ap, u);
      out.AL[k] = { PREPARE: await alarm(u, out.P[k], 'PREPARE', prepAt), DEPARTURE: await alarm(u, out.P[k], 'DEPARTURE', depAt) };
      if (wake) out.AL[k].WAKE = await alarm(u, out.P[k], 'WAKE', wake);
    }
    return out;
  };

  await check('17-01 해제 → 참여 행: 준비 알람 해제 = prepare_started_at(PREPARE_ALARM), 출발 알람 해제는 출발을 안 바꿈(출발은 위치 · ACKNOWLEDGED만) — 준비는 빈 칸만(둘째 해제는 안 덮음), 울림 · 미루기 기록은 안 건드림, 기상 알람 해제도 참여 행은 그대로', async () => {
    const W = await setup(100, { wake: at('07:00') });
    await ev(W.AL.B.PREPARE, W.B, 'TRIGGERED', at('08:50'));
    await ev(W.AL.B.PREPARE, W.B, 'SNOOZED', at('08:51'));
    await ev(W.AL.B.DEPARTURE, W.B, 'TRIGGERED', at('09:20'));
    await ev(W.AL.B.WAKE, W.B, 'DISMISSED', at('07:01'));
    const mid = await pt(W.P.B);
    await ev(W.AL.B.PREPARE, W.B, 'DISMISSED', at('08:55'));
    await ev(W.AL.B.PREPARE, W.B, 'DISMISSED', at('09:05'));
    await ev(W.AL.B.DEPARTURE, W.B, 'DISMISSED', at('09:25'));
    await ev(W.AL.B.DEPARTURE, W.B, 'DISMISSED', at('09:40'));
    const row = await pt(W.P.B);
    return eq([mid.prepare_started_at, mid.departed_at, iso(row.prepare_started_at), row.prepare_started_source, iso(row.departed_at), row.departed_source, row.arrived_at],
      [null, null, iso(at('08:55')), 'PREPARE_ALARM', null, null, null]);
  });

  await check('17-02 옛 길 그대로: ACKNOWLEDGED(알림 버튼)로도 출발 · 준비 시작이 반영되고, 위치로 이미 잡힌 출발은 해제로 안 덮이며, 이른 위치 출발(출발 예정 − 60분 전)은 그대로 조용히 무시', async () => {
    const W = await setup(110);
    await ev(W.AL.A.PREPARE, W.A, 'ACKNOWLEDGED', at('08:52'));
    await ev(W.AL.A.DEPARTURE, W.A, 'ACKNOWLEDGED', at('09:22'));
    const a = await pt(W.P.A);
    await q(`update public.appointment_participants set departed_at = $2::timestamptz, departed_source = 'LOCATION' where participant_id = $1`, [W.P.B, at('09:10')]);
    await ev(W.AL.B.DEPARTURE, W.B, 'DISMISSED', at('09:30'));
    const b = await pt(W.P.B);
    const C = await join_(112, '시', );
    await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now())`, [W.g, C]);
    const pc = await part(W.ap, C);
    await alarm(C, pc, 'DEPARTURE', at('09:20'));
    await q(`update public.appointment_participants set departed_at = $2::timestamptz, departed_source = 'LOCATION' where participant_id = $1`, [pc, at('06:00')]);
    const c = await pt(pc);
    return eq([iso(a.prepare_started_at), iso(a.departed_at), a.departed_source, iso(b.departed_at), b.departed_source, c.departed_at],
      [iso(at('08:52')), iso(at('09:22')), 'BUTTON', iso(at('09:10')), 'LOCATION', null]);
  });

  await check('17-03 새 칸: prepare_alarm_at = 켜진 PREPARE 알람 시각, prepare_started_at = 준비 시작 시각 — 출발 · 도착 공유를 켠 사람만(끈 사람 · 알람 끈 사람 · 알람 없는 사람은 null)', async () => {
    const A = await join_(120, '보는이'), B = await join_(121, '켬'), C = await join_(122, '공유끔'), D = await join_(123, '알람끔'), E = await join_(124, '알람없음');
    const g = await mkGroup(A, [B, C, D, E], { [A]: [true, true], [B]: [true, true], [C]: [true, false], [D]: [true, true], [E]: [true, true] });
    const ap = await appt(A, g, at('10:00'));
    const al = {};
    for (const [k, u] of [['B', B], ['C', C], ['D', D], ['E', E]]) {
      const p = await part(ap, u);
      if (k !== 'E') al[k] = await alarm(u, p, 'PREPARE', at('08:50'));
    }
    await q(`update public.alarms set is_enabled = false where alarm_id = $1`, [al.D]);
    const before = await rows(A, g);
    await ev(al.B, B, 'DISMISSED', at('08:57'));
    await ev(al.C, C, 'DISMISSED', at('08:58'));
    const after = await rows(A, g);
    const cell = (r, u) => { const x = of(r, u); return [x.trip_visible, iso(x.prepare_alarm_at), iso(x.prepare_started_at)]; };
    return eq([cell(before, B), cell(after, B), cell(after, C), cell(after, D), cell(after, E)],
      [[true, iso(at('08:50')), null], [true, iso(at('08:50')), iso(at('08:57'))], [false, null, null], [true, null, null], [true, null, null]]);
  });

  await check('17-04 기상 없는 날(오후 약속, 기상 알람 없음): 줄은 NO_ALARM인 채 prepare_alarm_at(준비 알람 17:10)이 있고, 준비 알람을 끄면 준비 시작이 채워짐 — 단계는 그대로 NO_ALARM(준비 · 이동 중은 앱이 칸으로 그림)', async () => {
    const W = await setup(130, { when: at('18:00'), prepAt: at('17:10'), depAt: at('17:30') });
    const before = of(await rows(W.A, W.g, TODAY, at('16:00')), W.B);
    await ev(W.AL.B.PREPARE, W.B, 'TRIGGERED', at('17:10'));
    await ev(W.AL.B.PREPARE, W.B, 'DISMISSED', at('17:12'));
    const after = of(await rows(W.A, W.g, TODAY, at('17:13')), W.B);
    await ev(W.AL.B.DEPARTURE, W.B, 'DISMISSED', at('17:30'));   // 해제는 출발이 아님 — 감지가 꺼진 폰만 ACKNOWLEDGED를 함께 보냄
    await ev(W.AL.B.DEPARTURE, W.B, 'ACKNOWLEDGED', at('17:31'));
    const moving = of(await rows(W.A, W.g, TODAY, at('17:32')), W.B);
    return eq([before.wake_status, iso(before.prepare_alarm_at), before.prepare_started_at, after.wake_status, iso(after.prepare_started_at), moving.wake_status, iso(moving.prepare_started_at), iso(moving.departed_at), moving.arrived_at],
      ['NO_ALARM', iso(at('17:10')), null, 'NO_ALARM', iso(at('17:12')), 'NO_ALARM', iso(at('17:12')), iso(at('17:31')), null]);
  });

  await check('17-05 약속 고르기: 새 칸은 trip_appointment_at과 같은 약속의 것 — 10:00 약속 도착 뒤 15:00 약속 준비 시작은 기록이 가장 최근인 10:00 약속(준비 15:00 약속 값이 아님), 15:00 약속 출발하면 15:00 약속 값으로 바뀜', async () => {
    const A = await join_(140, '에이'), B = await join_(141, '비');
    const g = await mkGroup(A, [B], { [A]: [true, true], [B]: [true, true] });
    const a1 = await appt(A, g, at('10:00')), a2 = await appt(A, g, at('15:00'));
    const p1 = await part(a1, B), p2 = await part(a2, B);
    const pr1 = await alarm(B, p1, 'PREPARE', at('08:50')), pr2 = await alarm(B, p2, 'PREPARE', at('13:50'));
    const dep2 = await alarm(B, p2, 'DEPARTURE', at('14:20'));
    await q(`update public.appointment_participants set departed_at = $2::timestamptz, departed_source = 'BUTTON', arrived_at = $3::timestamptz, arrived_source = 'BUTTON' where participant_id = $1`, [p1, at('09:20'), at('09:55')]);
    await ev(pr1, B, 'DISMISSED', at('08:55'));
    await ev(pr2, B, 'DISMISSED', at('13:55'));
    const first = of(await rows(A, g), B);
    await ev(dep2, B, 'ACKNOWLEDGED', at('14:22'));
    const second = of(await rows(A, g), B);
    return eq([iso(first.trip_appointment_at), iso(first.prepare_alarm_at), iso(first.prepare_started_at), iso(second.trip_appointment_at), iso(second.prepare_alarm_at), iso(second.prepare_started_at)],
      [iso(at('10:00')), iso(at('08:50')), iso(at('08:55')), iso(at('15:00')), iso(at('13:50')), iso(at('13:55'))]);
  });

  await check('17-06 공개 함수 get_group_wake · get_group_wake_status가 끝에 prepare_alarm_at · prepare_started_at을 돌려주고(기존 칸 · 순서 그대로), 권한은 authenticated만', async () => {
    const A = await join_(150, '보는이'), B = await join_(151, '켬'), C = await join_(152, '끔');
    const g = await mkGroup(A, [B, C], { [A]: [true, false], [B]: [true, true], [C]: [true, false] });
    const ap = await appt(A, g, `${TODAY}T23:00:00+09:00`);
    for (const u of [B, C]) {
      const p = await part(ap, u);
      const a = await alarm(u, p, 'PREPARE', `${TODAY}T22:00:00+09:00`);
      await ev(a, u, 'DISMISSED', new Date(Date.now() - 5 * 60_000).toISOString());
    }
    await as(A);
    const w = await q(`select * from public.get_group_wake($1)`, [g]);
    const s = await q(`select * from public.get_group_wake_status($1)`, [g]);
    await su();
    const [fn] = await q(`select has_function_privilege('anon', 'public.get_group_wake(uuid, date)', 'execute') as n1,
                                 has_function_privilege('anon', 'public.get_group_wake_status(uuid, date)', 'execute') as n2,
                                 has_function_privilege('authenticated', 'public.get_group_wake(uuid, date)', 'execute') as a1,
                                 has_function_privilege('authenticated', 'public.get_group_wake_status(uuid, date)', 'execute') as a2`);
    const tail = (r) => Object.keys(r[0]).slice(-2);
    return eq([tail(w), tail(s), of(w, B).prepare_started_at != null, of(w, B).prepare_alarm_at != null, of(w, C).prepare_started_at, of(w, C).prepare_alarm_at, of(s, B).prepare_started_at != null, of(s, C).prepare_alarm_at, fn],
      [['prepare_alarm_at', 'prepare_started_at'], ['prepare_alarm_at', 'prepare_started_at'], true, true, null, null, true, null, { n1: false, n2: false, a1: true, a2: true }]);
  });

  await check('17-07 신호 — 준비 시작: 처음 해제만 그 그룹에 1번(날짜 = 약속 날짜), 둘째 해제 · 울림 · 미루기 · 공유 끈 사람 · 다른 그룹은 0번, 한 번에 세 칸이 바뀌어도 1번', async () => {
    const W = await setup(160);
    const g2 = await mkGroup(W.A, [W.B], { [W.A]: [true, true], [W.B]: [true, true] });
    await appt(W.A, g2, at('11:00'));
    await clear();
    await ev(W.AL.B.PREPARE, W.B, 'TRIGGERED', at('08:50'));
    await ev(W.AL.B.PREPARE, W.B, 'SNOOZED', at('08:51'));
    const quiet = await sigs(W.g);
    await ev(W.AL.B.PREPARE, W.B, 'DISMISSED', at('08:55'));
    const first = await sigs(W.g);
    await ev(W.AL.B.PREPARE, W.B, 'DISMISSED', at('09:05'));
    const again = await sigs(W.g);
    await clear();
    await q(`update public.appointment_participants set prepare_started_at = $2::timestamptz, prepare_started_source = 'PREPARE_ALARM', departed_at = $3::timestamptz, departed_source = 'BUTTON', arrived_at = $4::timestamptz, arrived_source = 'BUTTON' where participant_id = $1`, [W.P.A, at('08:55'), at('09:20'), at('09:50')]);
    const bulk = await sigs(W.g);
    await q(`update public.group_members set trip_share_opt_in = false where group_id = $1 and user_id = $2`, [W.g, W.B]);
    await clear();
    await ev(W.AL.B.DEPARTURE, W.B, 'ACKNOWLEDGED', at('09:25'));   // B는 출발 · 도착 공유를 껐음 — 화면에 안 보이니 신호 없음
    const off = await sigs(W.g);
    return eq([quiet, first, again, bulk, off, await sigs(g2)], [[], [TODAY], [TODAY], [TODAY], [], []]);
  });

  await check('17-08 신호 — 공유(기상 · 출발 · 도착) 바꿈(G8): 켜기 · 끄기 한 번에 1번, 같은 값으로 다시 쓰기 · 알림 끄기만 바꾸기는 0번, 참여 전(초대) 행은 0번, 다른 그룹은 0번', async () => {
    const W = await setup(170);
    const g2 = await mkGroup(W.A, [W.B], { [W.A]: [true, true], [W.B]: [true, true] });
    const C = await join_(172, '초대');
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [W.g, C]);
    await clear();
    const upd = async (set, params = []) => { await clear(); await q(`update public.group_members set ${set} where group_id = $1 and user_id = $2`, [W.g, W.B, ...params]); return sigs(W.g); };
    const tripOff = await upd('trip_share_opt_in = false');
    const sameValue = await upd('trip_share_opt_in = false');
    const notif = await upd('notifications_off = true');
    const tripOn = await upd('trip_share_opt_in = true');
    const wakeOff = await upd('wake_share_opt_in = false');            // 출발 · 도착도 같이 꺼지지만 행 하나 = 신호 하나
    await clear();
    await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [W.g, C]);
    const invited = await sigs(W.g);
    return eq([tripOff, sameValue, notif, tripOn, wakeOff, invited, await sigs(g2)], [[TODAY], [], [], [TODAY], [TODAY], [], []]);
  });

  await check('17-09 신호 — 나가기(JOINED → LEFT) · 내보내짐(행 지움)(NEW-3): 각 1번, 그때 같이 지워지는 참여 행 · 알람은 따로 신호 안 보냄, 초대 취소 · 그룹 지우기는 0번', async () => {
    const A = await join_(180, '에이'), B = await join_(181, '비'), C = await join_(182, '씨'), D = await join_(183, '디');
    const g = await mkGroup(A, [B, C, D], { [A]: [true, true], [B]: [true, true], [C]: [true, true], [D]: [true, true] });
    const ap = await appt(A, g, at('10:00'));
    for (const u of [A, B, C]) { const p = await part(ap, u); await alarm(u, p, 'PREPARE', at('08:50')); }
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g, await join_(184, '초대')]);
    await clear();
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, B]);
    const left = await sigs(g);
    await clear();
    await q(`delete from public.group_members where group_id = $1 and user_id = $2`, [g, C]);
    const kicked = await sigs(g);
    await clear();
    await q(`delete from public.group_members where group_id = $1 and user_id = $2`, [g, id(184)]);
    const cancelInvite = await sigs(g);
    await clear();
    await q(`delete from public.groups where group_id = $1`, [g]);
    return eq([left, kicked, cancelInvite, await sigs(g)], [[TODAY], [TODAY], [], []]);
  });

  await check('17-10 신호 — 약속에서 빠짐(참여 행 지움)(NEW-4): 1번(기상 공유만 켜도), 약속 취소로 같이 지워지는 참여 행들은 따로 안 보냄', async () => {
    const W = await setup(190, { share: [true, false] });
    await clear();
    await q(`delete from public.appointment_participants where participant_id = $1`, [W.P.B]);
    const left = await sigs(W.g);
    return eq(left, [TODAY]);
  });

  await check('17-11 신호 — 그룹 약속 시각 변경 · 취소(NEW-1): 같은 날 변경 1번, 하루 넘게 변경은 새 날짜 · 옛 날짜 각 1번, 취소 1번(참여자 수만큼 안 늘어남), 개인 일정 · 다른 그룹은 0번', async () => {
    const W = await setup(200);
    const g2 = await mkGroup(W.A, [W.B], { [W.A]: [true, true], [W.B]: [true, true] });
    const solo = (await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '개인', $2::timestamptz, '집') returning appointment_id`, [W.A, at('13:00')]))[0].appointment_id;
    await clear();
    await q(`update public.appointments set appointment_at = $2::timestamptz where appointment_id = $1`, [W.ap, at('11:00')]);
    const same = await sigs(W.g);
    await clear();
    await q(`update public.appointments set appointment_at = $2::timestamptz where appointment_id = $1`, [solo, at('14:00')]);
    await q(`update public.appointments set title = '이름만' where appointment_id = $1`, [W.ap]);
    const quiet = await sigs(W.g);
    await clear();
    await q(`update public.appointments set appointment_at = $2::timestamptz where appointment_id = $1`, [W.ap, at('11:00', dayPlus(1))]);
    const crossDay = await sigs(W.g);
    await clear();
    await q(`delete from public.appointments where appointment_id = $1`, [W.ap]);
    const cancel = await sigs(W.g);
    return eq([same, quiet, crossDay, cancel, await sigs(g2)], [[TODAY], [], [dayPlus(1), TODAY], [dayPlus(1)], []]);
  });

  await check('17-12 신호 — 기상 숨기기 · 보이기(NEW-2): 같이 참여한 그룹마다 각 1번, 이미 숨긴 것을 또 숨기기 · 이미 보이는 것을 보이기는 0번, 기상 공유를 끈 사람의 숨기기 · 같이 참여 안 한 그룹은 0번', async () => {
    const W = await setup(210);
    const g2 = await mkGroup(W.A, [], { [W.A]: [true, true] });          // B가 없는 그룹 — 신호 없음
    await appt(W.A, g2, at('11:00'));
    await clear();
    await call(W.B, 'public.set_wake_hidden($1, $2)', [W.A, true]);
    const hide = await sigs(W.g);
    await call(W.B, 'public.set_wake_hidden($1, $2)', [W.A, true]);
    const hideAgain = await sigs(W.g);
    await clear();
    await call(W.B, 'public.set_wake_hidden($1, $2)', [W.A, false]);
    const show = await sigs(W.g);
    await call(W.B, 'public.set_wake_hidden($1, $2)', [W.A, false]);
    const showAgain = await sigs(W.g);
    await q(`update public.group_members set wake_share_opt_in = false where group_id = $1 and user_id = $2`, [W.g, W.B]);
    await clear();
    await call(W.B, 'public.set_wake_hidden($1, $2)', [W.A, true]);
    const notSharing = await sigs(W.g);
    return eq([hide, hideAgain, show, showAgain, notSharing, await sigs(g2)], [[TODAY], [TODAY], [TODAY], [TODAY], [], []]);
  });
}
