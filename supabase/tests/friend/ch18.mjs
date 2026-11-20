// 친구 18장 — 기상 정정 (11/20 지형님, D61 '판정마다 1탭 정정'): 알람 이벤트 WAKE_CORRECTED
//   ① 앱이 본인 알람에만 쓸 수 있음(기존 RLS) ② 쓰면 같은 알람의 그 시각까지의 기상 확정이 지워져 그룹 화면이 '확정 없음'으로 돌아가고 하루 기록의 기상 확인 시각이 비워짐(해제 시각은 둠)
//   ③ 같은 해제의 자동 판정(USAGE)이 다시 들어와도 안 받음 — 정정 뒤 다시 해제해서 나온 새 판정 · 다음 날 판정은 받음 ④ 친구 화면 새로 고침 신호
//   날짜는 오늘(한국 시간) 기준. 사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch18({ q, as, su, check }) {
  const id = (n) => `b7b00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const KST = 9 * 3600_000;
  const dayPlus = (n) => new Date(Date.parse(`${new Date(Date.now() + KST).toISOString().slice(0, 10)}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const TODAY = dayPlus(0);
  const at = (hhmm, day = TODAY) => `${day}T${hhmm}:00+09:00`;
  const eq = (got, want) => (JSON.stringify(got) === JSON.stringify(want) ? true : { got, want });

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f18-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f18_user_${n}`]);
    return id(n);
  };
  // 두 사람 그룹(기상 공유 켬) + 오늘 10시 약속 + 사람마다 기상 알람 07:00
  const setup = async (n0) => {
    const A = await join_(n0, '에이'), B = await join_(n0 + 1, '비');
    await as(A);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('정정그룹', $1) returning group_id`, [A]);
    await su();
    for (const u of [B]) await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in, trip_share_opt_in) values ($1, $2, 'JOINED', now(), true, false)`, [g.group_id, u]);
    await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [g.group_id, A]);
    const [ap] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '정정 약속', $3::timestamptz, '학교') returning appointment_id`, [A, g.group_id, at('10:00')]);
    const out = { A, B, g: g.group_id, AL: {} };
    for (const [k, u] of [['A', A], ['B', B]]) {
      const [p] = await q(`insert into public.appointment_participants (appointment_id, user_id, buffer_minutes, est_travel_minutes) values ($1, $2, 10, 30) returning participant_id`, [ap.appointment_id, u]);
      out.AL[k] = (await q(`insert into public.alarms (user_id, participant_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3::timestamptz) returning alarm_id`, [u, p.participant_id, at('07:00')]))[0].alarm_id;
    }
    return out;
  };
  const ev = (alarmId, u, type, when, src = 'BUTTON') => q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, input_source) values ($1, $2, $3, $4::timestamptz, $5)`, [alarmId, u, type, when, src]);
  const evCount = async (alarmId, type) => (await q(`select count(*)::int as n from public.alarm_events where alarm_id = $1 and event_type = $2`, [alarmId, type]))[0].n;
  const statusOf = async (viewer, g, who, now) => (await q(`select wake_status from private.group_wake_rows($1, $2, $3::date, $4::timestamptz) where user_id = $5`, [viewer, g, TODAY, now, who]))[0]?.wake_status;
  const record = async (u, day = TODAY) => (await q(`select wake_confirmed_at, wake_reported_at from public.daily_records where user_id = $1 and record_date = $2::date`, [u, day]))[0];
  const sigs = async (g) => (await q(`select payload from realtime.messages where topic = $1 and event = 'refresh' order by id`, [`group:${g}:wake`])).map((r) => r.payload?.date ?? null);

  // 자동 판정으로 확정된 아침 — 07:00 울림 · 07:02 해제 · 07:12 USAGE 확정 (+ 하루 기록 · 해제 시각)
  const confirmedMorning = async (W) => {
    await ev(W.AL.A, W.A, 'TRIGGERED', at('07:00'));
    await ev(W.AL.A, W.A, 'DISMISSED', at('07:02'));
    await ev(W.AL.A, W.A, 'WAKE_CONFIRMED', at('07:12'), 'USAGE');
    await q(`update public.daily_records set wake_reported_at = $3::timestamptz where user_id = $1 and record_date = $2::date`, [W.A, TODAY, at('07:02')]);
  };

  await check('18-01 WAKE_CORRECTED는 앱(로그인 사용자)이 본인 알람에만 씀 — 남의 알람에는 RLS가 막음, 값은 alarm_event_type에 있음', async () => {
    const W = await setup(1);
    const [t] = await q(`select 'WAKE_CORRECTED'::public.alarm_event_type::text as v`);
    await as(W.A);
    await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values ($1, $2, 'WAKE_CORRECTED', $3::timestamptz)`, [W.AL.A, W.A, at('07:20')]);
    let denied = false;
    try {
      await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values ($1, $2, 'WAKE_CORRECTED', $3::timestamptz)`, [W.AL.B, W.A, at('07:20')]); // 남의 알람
    } catch { denied = true; }
    await su();
    return eq([t.v, await evCount(W.AL.A, 'WAKE_CORRECTED'), denied, await evCount(W.AL.B, 'WAKE_CORRECTED')], ['WAKE_CORRECTED', 1, true, 0]);
  });

  await check('18-02 정정이 들어오면 그 알람의 기상 확정이 지워져 친구 화면이 확정 없음(MISSED)으로 돌아가고, 하루 기록의 기상 확인 시각은 비고 해제 시각은 그대로', async () => {
    const W = await setup(11);
    await confirmedMorning(W);
    const before = [await statusOf(W.B, W.g, W.A, at('07:40')), (await record(W.A))?.wake_confirmed_at != null];
    await as(W.A);
    await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values ($1, $2, 'WAKE_CORRECTED', $3::timestamptz)`, [W.AL.A, W.A, at('07:25')]);
    await su();
    const rec = await record(W.A);
    return eq(
      [before, await statusOf(W.B, W.g, W.A, at('07:40')), await evCount(W.AL.A, 'WAKE_CONFIRMED'), rec.wake_confirmed_at, new Date(rec.wake_reported_at).toISOString()],
      [['CONFIRMED', true], 'MISSED', 0, null, new Date(at('07:02')).toISOString()],
    );
  });

  await check('18-03 같은 해제의 자동 판정(USAGE)이 정정 뒤 다시 들어와도 안 받음(조용히 버림, 하루 기록도 그대로 빈 채) — 정정 뒤 다시 해제해서 나온 새 판정과 직접 [일어났어요]는 받음', async () => {
    const W = await setup(21);
    await confirmedMorning(W);
    await ev(W.AL.A, W.A, 'WAKE_CORRECTED', at('07:25'));
    await ev(W.AL.A, W.A, 'WAKE_CONFIRMED', at('07:12'), 'USAGE'); // 폰 재시도 — 같은 확정 시각
    const retried = [await evCount(W.AL.A, 'WAKE_CONFIRMED'), (await record(W.A)).wake_confirmed_at];
    await ev(W.AL.A, W.A, 'WAKE_CONFIRMED', at('07:55'), 'USAGE'); // 정정 뒤 다시 해제해서 나온 새 판정
    const fresh = [await evCount(W.AL.A, 'WAKE_CONFIRMED'), (await record(W.A)).wake_confirmed_at != null, await statusOf(W.B, W.g, W.A, at('08:30'))];
    return eq([retried, fresh], [[0, null], [1, true, 'CONFIRMED']]);
  });

  await check('18-04 직접 [일어났어요](BUTTON)로 다시 확정하면 그날 한 번 확정 제한(limit_wake_confirmed_per_day)에 안 걸림 — 정정이 이전 확정을 지웠으므로 · 정정 시각보다 이른 시각의 BUTTON 확정은 막지 않음(자동 판정만 막음)', async () => {
    const W = await setup(31);
    await confirmedMorning(W);
    await ev(W.AL.A, W.A, 'WAKE_CORRECTED', at('07:25'));
    await ev(W.AL.A, W.A, 'WAKE_CONFIRMED', at('07:30'), 'BUTTON');
    return eq([await evCount(W.AL.A, 'WAKE_CONFIRMED'), await statusOf(W.B, W.g, W.A, at('07:40'))], [1, 'CONFIRMED']);
  });

  await check('18-05 알람 행이 다음 회차로 재사용돼도 정정은 그 확정 시각 뒤 1일 안만 막음 — 다음 날 자동 판정은 받음, 다른 알람의 확정은 정정이 안 지움', async () => {
    const W = await setup(41);
    await confirmedMorning(W);
    await ev(W.AL.B, W.B, 'TRIGGERED', at('07:00'));
    await ev(W.AL.B, W.B, 'DISMISSED', at('07:03'));
    await ev(W.AL.B, W.B, 'WAKE_CONFIRMED', at('07:13'), 'USAGE');
    await ev(W.AL.A, W.A, 'WAKE_CORRECTED', at('07:25'));
    await ev(W.AL.A, W.A, 'WAKE_CONFIRMED', at('07:12', dayPlus(2)), 'USAGE'); // 이틀 뒤 같은 알람 행의 새 판정
    return eq([await evCount(W.AL.A, 'WAKE_CONFIRMED'), await evCount(W.AL.B, 'WAKE_CONFIRMED')], [1, 1]);
  });

  await check('18-06 정정은 같은 그룹 친구 화면 새로 고침 신호를 보냄(기상 공유를 켠 그룹 · 약속 있는 날) — 이미 앱이 확정을 지운 뒤 정정만 들어와도 신호는 감, 공유를 끄면 안 감', async () => {
    const W = await setup(51);
    await confirmedMorning(W);
    await q(`truncate realtime.messages`);
    await ev(W.AL.A, W.A, 'WAKE_CORRECTED', at('07:25'));
    const first = await sigs(W.g);
    await q(`truncate realtime.messages`);
    await ev(W.AL.A, W.A, 'WAKE_CORRECTED', at('07:26')); // 지울 확정이 없는 두 번째 정정
    const second = await sigs(W.g);
    await q(`update public.group_members set wake_share_opt_in = false where group_id = $1 and user_id = $2`, [W.g, W.A]);
    await q(`truncate realtime.messages`);
    await ev(W.AL.A, W.A, 'WAKE_CORRECTED', at('07:27'));
    const off = await sigs(W.g);
    return eq([first, second, off], [[TODAY], [TODAY], []]);
  });
}
