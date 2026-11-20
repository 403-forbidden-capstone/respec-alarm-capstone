// 친구 19장 — 그룹 화면의 하루 = 새벽 4시 기준일 (11/20 지형님 결정, 앱 lifeDayKey · AI 대화와 같은 규칙, KST)
//   기준일 D의 창 = D 04:00 ~ 다음 날 04:00. 기상 알람은 '그 약속에 딸린 알람'(없으면 창 안 첫 기상 알람), 기상 기록은 고른 알람의 alarm_id로 묶음
//   ① 23:10 기상 · 01:00 약속: 23:30 · 00:30 둘 다 날짜 없이 열어도 같은 하루(같은 줄) ② 03:30 기상 · 05:00 약속: 4시를 걸쳐도 같은 약속 줄
//   ③ 평범한 07:00 기상 · 10:00 약속은 그대로 ④ 그 그룹 약속 없는 날은 빈 결과 ⑤ 약속이 둘인 날은 이른 약속에 딸린 알람 ⑥ 새로 고침 신호 날짜도 같은 기준일
//   날짜는 오늘(한국 시간) 기준. 사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch19({ q, as, su, check }) {
  const id = (n) => `b8b00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const KST = 9 * 3600_000;
  const dayPlus = (n) => new Date(Date.parse(`${new Date(Date.now() + KST - 4 * 3600_000).toISOString().slice(0, 10)}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const TODAY = dayPlus(0);
  const at = (hhmm, day = TODAY) => `${day}T${hhmm}:00+09:00`;
  const iso = (v) => (v == null ? null : new Date(v).toISOString());
  const eq = (got, want) => (JSON.stringify(got) === JSON.stringify(want) ? true : { got, want });

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f19-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f19_user_${n}`]);
    return id(n);
  };
  // 두 사람 그룹(기상 공유 켬)
  const group = async (n0) => {
    const A = await join_(n0, '에이'), B = await join_(n0 + 1, '비');
    await as(A);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('새벽그룹', $1) returning group_id`, [A]);
    await su();
    await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in, trip_share_opt_in) values ($1, $2, 'JOINED', now(), true, false)`, [g.group_id, B]);
    await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [g.group_id, A]);
    return { A, B, g: g.group_id };
  };
  const appt = async (W, when, title = '약속') => (await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, $3, $4::timestamptz, '학교') returning appointment_id`, [W.A, W.g, title, when]))[0].appointment_id;
  // 약속에 딸린 기상 알람 (사람마다)
  const attach = async (ap, u, wakeAt) => {
    const [p] = await q(`insert into public.appointment_participants (appointment_id, user_id, buffer_minutes, est_travel_minutes) values ($1, $2, 10, 30) returning participant_id`, [ap, u]);
    return (await q(`insert into public.alarms (user_id, participant_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3::timestamptz) returning alarm_id`, [u, p.participant_id, wakeAt]))[0].alarm_id;
  };
  const ev = (alarmId, u, type, when, src = 'BUTTON') => q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, input_source) values ($1, $2, $3, $4::timestamptz, $5)`, [alarmId, u, type, when, src]);
  // 날짜 없이(null) 또는 지정해서 그룹 화면 줄 읽기 — 보는 사람 viewer 시점
  const rows = (viewer, g, date, now) => q(`select * from private.group_wake_rows($1, $2, $3::date, $4::timestamptz) order by is_me desc, user_id`, [viewer, g, date, now]);
  const of = (r, u) => r.find((x) => x.user_id === u);
  const sigs = async (g) => (await q(`select payload from realtime.messages where topic = $1 and event = 'refresh' order by id`, [`group:${g}:wake`])).map((r) => r.payload?.date ?? null);
  const clear = () => q(`truncate realtime.messages`);

  await check('19-01 23:10 기상 · 01:00 약속(다음 날): 23:30에도 00:30에도 날짜 없이 열면 같은 하루 · 같은 줄(알람 23:10, 같은 확정) — 새벽 4시가 하루의 경계', async () => {
    const W = await group(1);
    const ap = await appt(W, at('01:00', dayPlus(1)));
    const a = await attach(ap, W.A, at('23:10'));
    await attach(ap, W.B, at('23:10'));
    await ev(a, W.A, 'TRIGGERED', at('23:10'));
    await ev(a, W.A, 'DISMISSED', at('23:12'));
    await ev(a, W.A, 'WAKE_CONFIRMED', at('23:20'), 'BUTTON');
    const night = of(await rows(W.B, W.g, null, at('23:30')), W.A);
    const after = of(await rows(W.B, W.g, null, at('00:30', dayPlus(1))), W.A);
    const next = await rows(W.B, W.g, null, at('04:30', dayPlus(1))); // 새벽 4시가 지나면 새 하루 — 그 그룹 약속 없음
    return eq([night.wake_status, iso(night.wake_alarm_at), after.wake_status, iso(after.wake_alarm_at), iso(after.wake_confirmed_at), next.length], ['CONFIRMED', iso(at('23:10')), 'CONFIRMED', iso(at('23:10')), iso(at('23:20')), 0]);
  });

  await check('19-02 03:30 기상 · 05:00 약속: 알람이 4시 앞이어도 같은 약속 줄에 붙음(기준일 지정 · 04:30에 날짜 없이) — 기록(울림 · 해제 · 확정)은 그 알람 번호로 묶임', async () => {
    const W = await group(11);
    const ap = await appt(W, at('05:00'));
    const a = await attach(ap, W.A, at('03:30'));
    await attach(ap, W.B, at('03:30'));
    await ev(a, W.A, 'TRIGGERED', at('03:30'));
    await ev(a, W.A, 'DISMISSED', at('03:32'));
    await ev(a, W.A, 'WAKE_CONFIRMED', at('03:40'), 'BUTTON');
    const early = of(await rows(W.B, W.g, TODAY, at('03:45')), W.A);                // 기준일을 지정하면 03:45에도 보임
    const later = of(await rows(W.B, W.g, null, at('04:30')), W.A);                 // 날짜 없이: 04:30 = 오늘 기준일
    return eq([early.wake_status, iso(early.wake_alarm_at), later.wake_status, iso(later.wake_alarm_at), iso(later.wake_confirmed_at)], ['CONFIRMED', iso(at('03:30')), 'CONFIRMED', iso(at('03:30')), iso(at('03:40'))]);
  });

  await check('19-03 평범한 07:00 기상 · 10:00 약속은 그대로(날짜 없이 · 지정 모두) — 약속 없는 날(어제 · 내일)은 빈 결과', async () => {
    const W = await group(21);
    const ap = await appt(W, at('10:00'));
    const a = await attach(ap, W.A, at('07:00'));
    await attach(ap, W.B, at('07:00'));
    await ev(a, W.A, 'TRIGGERED', at('07:00'));
    const nowRows = of(await rows(W.B, W.g, null, at('07:05')), W.A);
    const given = of(await rows(W.B, W.g, TODAY, at('07:05')), W.A);
    const yesterday = await rows(W.B, W.g, dayPlus(-1), at('07:05'));
    const tomorrow = await rows(W.B, W.g, dayPlus(1), at('07:05'));
    return eq([nowRows.wake_status, given.wake_status, iso(given.wake_alarm_at), yesterday.length, tomorrow.length], ['RINGING', 'RINGING', iso(at('07:00')), 0, 0]);
  });

  await check('19-04 그 그룹 약속이 없는 날(다른 그룹 약속뿐 · 약속 없음)은 빈 결과 — 기준일 창 밖 약속(전날 새벽 3:59 · 다음 날 새벽 4:00)도 그날 약속이 아님', async () => {
    const W = await group(31);
    await appt(W, at('03:59'));                       // 어제 기준일
    await appt(W, at('04:00', dayPlus(1)));           // 내일 기준일
    const today = await rows(W.B, W.g, TODAY, at('12:00'));
    const yest = await rows(W.B, W.g, dayPlus(-1), at('12:00'));
    const tom = await rows(W.B, W.g, dayPlus(1), at('12:00'));
    const none = await group(41);
    return eq([today.length, yest.length, tom.length, (await rows(none.B, none.g, TODAY, at('12:00'))).length], [0, 2, 2, 0]);
  });

  await check('19-05 약속이 둘인 날(10:00 · 15:00): 이른 약속에 딸린 기상 알람이 기준 알람, 두 약속이 모두 같은 하루 · 기록은 그 알람 번호로만 묶임(다른 알람의 해제는 안 섞임)', async () => {
    const W = await group(51);
    const ap1 = await appt(W, at('10:00'), '아침 약속'), ap2 = await appt(W, at('15:00'), '오후 약속');
    const a1 = await attach(ap1, W.A, at('07:00'));
    await attach(ap1, W.B, at('07:00'));
    const a2 = await attach(ap2, W.A, at('12:30'));
    await attach(ap2, W.B, at('12:30'));
    await ev(a1, W.A, 'TRIGGERED', at('07:00'));
    await ev(a2, W.A, 'TRIGGERED', at('12:30'));
    await ev(a2, W.A, 'DISMISSED', at('12:31'));      // 오후 알람의 해제는 아침 기준 줄에 안 섞임
    const r = of(await rows(W.B, W.g, TODAY, at('07:10')), W.A);
    return eq([iso(r.wake_alarm_at), r.wake_status, r.dismissed_at], [iso(at('07:00')), 'RINGING', null]);
  });

  await check('19-06 새로 고침 신호의 날짜도 기준일: 새벽 00:30 약속의 시각을 바꾸면 신호 날짜가 앞날(오늘), 낮 약속은 그날, 기상 확정 신호는 약속에 딸린 알람이면 그 약속의 기준일', async () => {
    const W = await group(61);
    const late = await appt(W, at('00:30', dayPlus(1)), '새벽 약속');
    const aLate = await attach(late, W.A, at('23:10'));
    await attach(late, W.B, at('23:10'));
    await clear();
    await q(`update public.appointments set appointment_at = $2::timestamptz where appointment_id = $1`, [late, at('01:00', dayPlus(1))]);
    const moved = await sigs(W.g);
    await clear();
    await ev(aLate, W.A, 'WAKE_CONFIRMED', at('23:20'), 'BUTTON');
    const confirmed = await sigs(W.g);
    const noon = await group(71);
    const day = await appt(noon, at('10:00'));
    await attach(day, noon.A, at('07:00'));
    await attach(day, noon.B, at('07:00'));
    await clear();
    await q(`update public.appointments set appointment_at = $2::timestamptz where appointment_id = $1`, [day, at('11:00')]);
    const same = await sigs(noon.g);
    return eq([moved, confirmed, same], [[TODAY], [TODAY], [TODAY]]);
  });
}
