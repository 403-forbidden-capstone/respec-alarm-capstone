// 친구 8장 — 깨우기 · 미확인 알림 (친구_시험케이스.md 8장 DB · 함수 층, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호
//   이 장 DB에 없는 것: 8-02 · 8-03 · 8-19(실기기) · 8-16 · 8-17 · 8-32 · 8-34 · 8-37(앱 화면) · 8-31의 소리(실기기, 조회만 여기서) — 서버 함수 쪽은 supabase/functions/_shared/{notify,wake}.test.ts
//   시간이 걸린 규칙(5분 · 10분 · 30분)은 지금(now())을 읽는 대신 인자로 받는 같은 본문으로 시각을 고정해 확인
//   사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch08({ q, as, su, svc, check, expectErr }) {
  const id = (n) => `b8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const NOBODY = 'b8000000-0000-4000-8000-999999999999';
  const D = '2026-11-10';
  const at = (hhmm, day = D, off = '+09:00') => `${day}T${hhmm}:00${off}`;

  const join_ = async (n, nickname, tz = null) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f8-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f8_user_${n}`]);
    if (tz) await q(`update public.profiles set timezone = $2 where user_id = $1`, [id(n), tz]);
    return id(n);
  };
  const call = async (uid, sql, params = []) => { await as(uid); const [r] = await q(`select ${sql} as r`, params); await su(); return r.r; };
  const mkGroup = async (owner, others = [], optIn = []) => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('깨우기그룹', $1) returning group_id`, [owner]);
    await su();
    for (const u of others) await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in) values ($1, $2, 'JOINED', now(), $3)`, [g.group_id, u, optIn.includes(u)]);
    if (optIn.includes(owner)) await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [g.group_id, owner]);
    return g.group_id;
  };
  const appt = async (owner, g, when, title = '그룹 약속') => (await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, $3, $4::timestamptz, '학교') returning appointment_id`, [owner, g, title, when]))[0].appointment_id;
  const wakeAlarm = async (u, when) => (await q(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'WAKE', $2::timestamptz) returning alarm_id`, [u, when]))[0].alarm_id;
  const ev = (alarmId, u, type, when, { snooze = null, src = null } = {}) =>
    q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, snooze_minutes, input_source) values ($1, $2, $3, $4::timestamptz, $5, $6)`, [alarmId, u, type, when, snooze, src]);
  // 깨우기 판정 (서버 전용). reserve = true면 횟수에 셈
  const ping = async (s, t, now, reserve = false) => { await svc(); const r = (await q(`select public.plan_wake_ping($1, $2, $3, $4::timestamptz) as r`, [s, t, reserve, now]))[0].r; await su(); return r; };
  const iso = (v) => (v == null ? null : new Date(v).toISOString());
  const sorted = (...x) => x.slice().sort();
  // 기본 상황: A(보내는 사람) · B(받는 사람, 동의), 오늘 그룹 약속, B 알람 07:00
  const base = async (n, { optIn = true, bAlarm = '07:00', tz = null } = {}) => {
    const A = await join_(n, '보내는이'), B = await join_(n + 1, '받는이', tz);
    const g = await mkGroup(A, [B], optIn ? [B] : []);
    await appt(A, g, at('10:00'));
    const al = await wakeAlarm(B, at(bAlarm));
    return { A, B, g, al };
  };

  // ---- 깨우기 판정 ---------------------------------------------------------------------------

  await check('8-01 · 8-04 · 8-13: 깨울 수 있는 때 — 알람 시각 전이면 NOT_RINGING, 시각이 지나면(울림 기록이 없어도 = 폰이 꺼져 기록이 못 올라와도) OK, 울림 · 해제 · 미확인 기록이 있어도 OK', async () => {
    const { A, B, al } = await base(1);
    const before = await ping(A, B, at('06:59'));
    const ontime = await ping(A, B, at('07:00'));              // 예정 시각이 지났고 확인이 없음
    await ev(al, B, 'TRIGGERED', at('07:00')); await ev(al, B, 'DISMISSED', at('07:03'));
    const dismissed = await ping(A, B, at('07:05'));
    await ev(al, B, 'MISSED', at('07:30'));
    const missed = await ping(A, B, at('07:40'));
    return before.status === 'NOT_RINGING' && ontime.status === 'OK' && dismissed.status === 'OK' && missed.status === 'OK' ? true : { before, ontime, dismissed, missed };
  });

  await check('8-05 · 8-33: 이미 일어난 사람은 ALREADY_UP — 확인(버튼)이 있거나 자동 판정 확인이 20분 안이면(그 20분 동안 깨우기는 서버가 막음), 20분이 지나도 확인이 있으면 그대로', async () => {
    const { A, B, al } = await base(3);
    await ev(al, B, 'TRIGGERED', at('07:00'));
    const ringing = await ping(A, B, at('07:05'));
    await ev(al, B, 'WAKE_CONFIRMED', at('07:08'), { src: 'USAGE' });
    const pending = await ping(A, B, at('07:20'));                // 자동 판정 12분 전 — 아직 친구에게 안 보이는 중
    const later = await ping(A, B, at('07:30'));                  // 22분 뒤 — 보이는 '일어남'
    const { A: A2, B: B2, al: al2 } = await base(5);
    await ev(al2, B2, 'WAKE_CONFIRMED', at('07:06'), { src: 'BUTTON' });
    const button = await ping(A2, B2, at('07:07'));
    return ringing.status === 'OK' && pending.status === 'ALREADY_UP' && later.status === 'ALREADY_UP' && button.status === 'ALREADY_UP' ? true : { ringing, pending, later, button };
  });

  await check('8-06 · 8-07: 같은 쌍에 5분에 한 번 — 방금 보냈으면 WAIT + 다음 가능 시각, 5분 지나면 됨(2/3). 확인만 하는 판정(reserve 아님)은 횟수에 안 셈', async () => {
    const { A, B } = await base(7);
    const peek = await ping(A, B, at('07:05'));                    // 판정만
    const first = await ping(A, B, at('07:05'), true);
    const wait = await ping(A, B, '2026-11-10T07:09:59+09:00', true);   // 4분 59초 — 아직
    const second = await ping(A, B, at('07:10'), true);
    return peek.status === 'OK' && peek.count === undefined && first.status === 'OK' && first.count === 1 && first.limit === 3 && iso(first.next_at) === iso(at('07:10'))
      && wait.status === 'WAIT' && iso(wait.next_at) === iso(at('07:10')) && second.status === 'OK' && second.count === 2 ? true : { peek, first, wait, second };
  });

  await check('8-08 · 8-09: 하루 3번 — 4번째는 DAILY_LIMIT, 다음 날(받는 사람 시간대 0시)이면 초기화. 보내는 사람 → 받는 사람 쌍마다 세므로 다른 사람은 따로', async () => {
    const { A, B, g } = await base(9);
    const C = await join_(11, '다른이');
    await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in) values ($1, $2, 'JOINED', now(), true)`, [g, C]);
    const r = [];
    for (const t of ['07:05', '07:10', '07:15']) r.push((await ping(A, B, at(t), true)).status);
    const soon4 = await ping(A, B, at('07:16'), true);               // 3번째 1분 뒤 — 5분 간격에도 걸리지만 하루 한도가 먼저 (WAIT가 아니라 DAILY_LIMIT)
    const fourth = await ping(A, B, at('07:20'), true);
    const fromC = await ping(C, B, at('07:20'), true);              // C → B는 처음
    const aToC = await ping(A, C, at('07:20'));                      // A → C는 C가 아직 안 울린 알람이 없어 NOT_RINGING일 수 있음 — 한도는 따로
    // 다음 날: 새 약속 · 새 알람이 있어야 다시 보낼 수 있음
    const D2 = '2026-11-11';
    await appt(A, g, at('10:00', D2)); await wakeAlarm(B, at('07:00', D2));
    const nextDay = await ping(A, B, at('07:05', D2), true);
    return JSON.stringify(r) === JSON.stringify(['OK', 'OK', 'OK']) && soon4.status === 'DAILY_LIMIT' && iso(soon4.resets_at) === iso(at('00:00', '2026-11-11')) && fourth.status === 'DAILY_LIMIT' && fromC.status === 'OK' && fromC.count === 1 && aToC.status !== 'DAILY_LIMIT'
      && nextDay.status === 'OK' && nextDay.count === 1 ? true : { r, soon4, fourth, fromC, aToC, nextDay };
  });

  await check('8-15: 하루는 받는 사람 시간대 0시 — UTC 사람은 UTC 자정에 횟수가 초기화(서울 시간으로는 한낮)', async () => {
    const A = await join_(12, '서울'), B = await join_(13, '유티씨', 'UTC');
    const g = await mkGroup(A, [B], [B]);
    await appt(A, g, '2026-11-10T10:00:00Z'); await appt(A, g, '2026-11-11T10:00:00Z');
    await wakeAlarm(B, '2026-11-10T08:00:00Z'); await wakeAlarm(B, '2026-11-11T08:00:00Z');
    const r = [];
    for (const t of ['2026-11-10T20:00:00Z', '2026-11-10T21:00:00Z', '2026-11-10T22:00:00Z']) r.push((await ping(A, B, t, true)).status);
    const limited = await ping(A, B, '2026-11-10T23:30:00Z', true);
    const nextMidnight = await ping(A, B, '2026-11-11T08:30:00Z', true);        // UTC 11/11 — 서울 11/11 17:30이지만 서울 기준으론 같은 날에서 이어짐
    return JSON.stringify(r) === JSON.stringify(['OK', 'OK', 'OK']) && limited.status === 'DAILY_LIMIT' && iso(limited.resets_at) === '2026-11-11T00:00:00.000Z' && nextMidnight.status === 'OK' && nextMidnight.count === 1 ? true : { r, limited, nextMidnight };
  });

  await check('8-10: 받는 사람이 깨우기 받기를 끄면 OFF("지금은 깨울 수 없어요"만) — 처음엔 켜져 있고, 기상이 안 보이는 사람에게는 꺼 둔 사실이 안 드러나 일반 FORBIDDEN', async () => {
    const { A, B } = await base(14);
    const [{ wake_ping_enabled: initial }] = await q(`select wake_ping_enabled from public.profiles where user_id = $1`, [B]);
    await as(B);
    await q(`update public.profiles set wake_ping_enabled = false where user_id = $1`, [B]);
    await su();
    const off = await ping(A, B, at('07:05'));
    const { A: A2, B: B2 } = await base(16, { optIn: false });       // 기상 공유 동의 안 함 + 받기 꺼짐
    await q(`update public.profiles set wake_ping_enabled = false where user_id = $1`, [B2]);
    const hidden = await ping(A2, B2, at('07:05'));
    return initial === true && off.status === 'OFF' && hidden.status === 'FORBIDDEN' && !('next_at' in off) ? true : { initial, off, hidden };
  });

  await check('8-11 · 8-12 · 8-35: 기상이 보이는 사람에게만 — 같은 그룹이 아니거나 · 상대가 그 그룹에 기상 공유를 안 했거나 · 오늘 그 그룹 약속이 없거나 · 상대가 나에게 숨겼거나 · 차단 쌍이거나 · 나 자신 · 없는 사람은 모두 같은 FORBIDDEN(이유 구분 없음)', async () => {
    const { A, B, g } = await base(18);
    const ok = await ping(A, B, at('07:05'));
    const stranger = await join_(20, '남');
    const noGroup = await ping(stranger, B, at('07:05'));
    const { A: A2, B: B2 } = await base(21, { optIn: false });
    const noConsent = await ping(A2, B2, at('07:05'));
    const { A: A3, B: B3, g: g3 } = await base(23);
    const noMeeting = await ping(A3, B3, at('07:05', '2026-11-12'));        // 11/12에는 이 그룹 약속이 없음
    await call(B, 'public.set_wake_hidden($1, true)', [A]);
    const hiddenFromA = await ping(A, B, at('07:05'));
    await call(B, 'public.set_wake_hidden($1, false)', [A]);
    await call(A, 'public.block_user($1)', [B]);
    const blocked = await ping(A, B, at('07:05'));
    const odd = [await ping(A, A, at('07:05')), await ping(A, NOBODY, at('07:05')), await ping(NOBODY, B, at('07:05')), await ping(null, B, at('07:05')), await ping(A, null, at('07:05'))];
    const shapes = [noGroup, noConsent, noMeeting, hiddenFromA, blocked, ...odd].map((x) => JSON.stringify(x));
    return ok.status === 'OK' && shapes.every((x) => x === JSON.stringify({ status: 'FORBIDDEN' })) ? true : { ok, noGroup, noConsent, noMeeting, hiddenFromA, blocked, odd, g3 };
  });

  await check('8-11(푸시 권한): can_send_push는 WAKE_PING을 늘 거절 — 기상이 보이는 사람에게도(깨우기 판정 · 횟수는 plan_wake_ping 한 곳, 새 notify는 can_send_push를 안 부름 · 이 마이그레이션이 먼저 적용돼도 옛 notify가 한도 없이 보내지 못함)', async () => {
    const { A, B } = await base(80);
    const visible = await ping(A, B, at('07:05'));                        // 같은 쌍을 plan_wake_ping은 보내도 된다고 함 (시각을 고정해 시계와 무관)
    const stranger = await join_(88, '남');
    const can = async (s, t) => { await svc(); const r = (await q(`select public.can_send_push($1, $2, 'WAKE_PING') as ok`, [s, t]))[0].ok; await su(); return r; };
    const r = [await can(A, B), await can(B, A), await can(stranger, B), await can(A, A), await can(A, NOBODY), await can(null, B), await can(A, null)];
    return visible.status === 'OK' && r.every((x) => x === false) ? true : { visible, r };
  });

  await check('8-14: 토큰이 없을 때 횟수에 안 세는 길 — 판정만(reserve 아님)은 횟수를 늘리지 않고, 센 횟수만 한도에 쌓임', async () => {
    const { A, B } = await base(25);
    for (let i = 0; i < 5; i++) await ping(A, B, at('07:05'));                 // 판정만 5번
    const counts = (await q(`select count(*)::int as n from public.push_sends where sender_id = $1`, [A]))[0].n;
    const first = await ping(A, B, at('07:05'), true);
    return counts === 0 && first.status === 'OK' && first.count === 1 ? true : { counts, first };
  });

  await check('8-18: 받은 깨우기 한 줄 — my_wake_pings가 오늘(내 시간대) 받은 깨우기를 보낸 사람 이름 · 시각과 함께 줌, 어제 것 · 차단한 사람 것 · 남의 것은 안 나옴', async () => {
    const { A, B, g } = await base(27);
    const C = await join_(29, '다른이');
    await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in) values ($1, $2, 'JOINED', now(), true)`, [g, C]);
    await ping(A, B, at('07:12'), true);
    await q(`insert into public.push_sends (sender_id, target_id, kind, sent_at) values ($1, $2, 'WAKE_PING', $3::timestamptz)`, [A, B, at('06:00', '2026-11-09')]);   // 어제 것 직접
    await q(`insert into public.push_sends (sender_id, target_id, kind, sent_at) values ($1, $2, 'WAKE_PING', $3::timestamptz)`, [C, B, at('07:40')]);
    const run = async (viewer, date) => { await as(viewer); const r = await q(`select * from public.my_wake_pings($1::date)`, [date]); await su(); return r; };
    const mine = await run(B, D), none = await run(A, D), other = await run(B, '2026-11-12'), yesterday = await run(B, '2026-11-09');
    await call(B, 'public.block_user($1)', [C]);
    const afterBlock = await run(B, D);
    return mine.length === 2 && mine[0].sender_id === C && mine[1].sender_id === A && mine[1].sender_nickname === '보내는이' && iso(mine[1].sent_at) === iso(at('07:12'))
      && none.length === 0 && other.length === 0 && yesterday.length === 1 && yesterday[0].sender_id === A && iso(yesterday[0].sent_at) === iso(at('06:00', '2026-11-09'))
      && afterBlock.length === 1 && afterBlock[0].sender_id === A ? true : { mine, none, other, yesterday, afterBlock };
  });

  // ---- 미확인 알림 (본인 → 10분 뒤 친구) -------------------------------------------------------------

  // 배치는 모든 사람을 한꺼번에 돎(다른 장 시험 데이터의 미확인도 같이 잡힘) — 그래서 이 시험의 사람(sleepers)만 골라 봄
  const claim = async (now, ...sleepers) => { await svc(); const r = await q(`select * from public.claim_wake_nudges($1::timestamptz)`, [now]); await su(); return sleepers.length ? r.filter((x) => sleepers.includes(x.sleeper_id)) : r; };
  // 상황: S가 07:00 알람 미확인(MISSED 07:30), 같은 그룹 약속 08:30, 보는 사람들
  const missedCase = async (n, { appointmentAt = '08:30', optInS = true } = {}) => {
    const S = await join_(n, '잠꾸러기'), V1 = await join_(n + 1, '보는이1'), V2 = await join_(n + 2, '보는이2');
    const g = await mkGroup(V1, [S, V2], optInS ? [S, V1, V2] : [V1, V2]);
    await appt(V1, g, at(appointmentAt));
    const al = await wakeAlarm(S, at('07:00'));
    await ev(al, S, 'TRIGGERED', at('07:00'));
    await ev(al, S, 'MISSED', at('07:30'));
    return { S, V1, V2, g, al };
  };
  const targetsOf = (rows) => rows.map((x) => x.recipient_id).sort();

  await check('8-22: 미확인(MISSED) 10분 뒤 그날 그룹 약속의 그룹원 중 기상이 보이는 사람에게 "깨워 볼까요?" — 10분 전에는 없고, 같은 배치가 겹쳐도 한 번만(8-23), 받는 사람은 이름 없이 id만', async () => {
    const { S, V1, V2, g } = await missedCase(30);
    const early = await claim(at('07:39'), S);
    const first = await claim(at('07:40'), S);
    const again = await claim(at('07:45'), S);
    const cols = Object.keys(first[0] ?? {}).sort().join();
    return early.length === 0 && JSON.stringify(targetsOf(first)) === JSON.stringify(sorted(V1, V2)) && first.every((x) => x.kind === 'NUDGE' && x.sleeper_id === S) && again.length === 0
      && cols === 'event_key,group_id,kind,recipient_id,sleeper_id' && first.every((r) => r.group_id === g) ? true : { early, first, again, cols };
  });

  await check('8-21: 본인 알림 뒤 10분 안에 본인이 확인하면 친구 알림 취소', async () => {
    const { S, al } = await missedCase(33);
    await ev(al, S, 'WAKE_CONFIRMED', at('07:38'), { src: 'BUTTON' });
    const r = await claim(at('07:40'), S);
    return r.length === 0 ? true : r;
  });

  await check('8-24: 약속 시각이 지나면 친구 알림을 안 보냄 — 이른 약속은 친구 알림 0번이 남음(약속 7:35 · 알람 7:00 · 미확인 7:30 · 10분 뒤 7:40은 이미 약속 뒤)', async () => {
    const a = await missedCase(36, { appointmentAt: '07:35' });
    const r = await claim(at('07:40'), a.S);
    const b = await missedCase(39, { appointmentAt: '08:00' });
    const ok = await claim(at('07:41'), b.S);
    const late = await claim(at('08:01'), a.S, b.S);
    return r.length === 0 && ok.length === 2 && late.length === 0 ? true : { r, ok, late };
  });

  await check('8-21(보강): 직접 입력(MANUAL) · 대화 정정(VOICE) 확인은 본인 확인으로 안 쳐서 친구 알림을 취소하지 않음', async () => {
    const m = await missedCase(96), v = await missedCase(99);
    await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, input_source) values ($1, $2, 'WAKE_CONFIRMED', $3::timestamptz, 'MANUAL')`, [m.al, m.S, at('07:35')]);
    await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, input_source) values ($1, $2, 'WAKE_CONFIRMED', $3::timestamptz, 'VOICE')`, [v.al, v.S, at('07:36')]);
    const r = await claim(at('07:45'), m.S, v.S);
    return r.filter((x) => x.sleeper_id === m.S).length === 2 && r.filter((x) => x.sleeper_id === v.S).length === 2 ? true : r;
  });

  await check('8-24(보강): 그날 가장 이른 그룹 약속이 이미 시작했으면 늦은 약속이 남아 있어도 안 보냄 — 미확인 기록이 12시간 넘게 지났으면 약속이 아직 남아도 안 보냄(12시간 안이면 보냄)', async () => {
    const S = await join_(102, '잠꾸러기'), V = await join_(103, '보는이');
    const g = await mkGroup(V, [S], [S, V]);
    await appt(V, g, at('07:35'), '이른 약속'); await appt(V, g, at('15:00'), '늦은 약속');
    const al = await wakeAlarm(S, at('07:00'));
    await ev(al, S, 'MISSED', at('07:30'));
    const twoAppts = await claim(at('07:45'), S);                   // 가장 이른 약속(7:35)이 시작함 → 늦은 약속(15:00)이 남아도 안 보냄
    const old = await missedCase(105, { appointmentAt: '23:00' });
    const tooOld = await claim(at('20:45'), old.S);                  // 미확인 7:30 → 13시간 15분 뒤, 약속 23:00은 아직 안 지남
    const recent = await missedCase(108, { appointmentAt: '23:00' });
    const within = await claim(at('18:45'), recent.S);               // 11시간 15분 뒤
    return twoAppts.length === 0 && tooOld.length === 0 && within.length === 2 ? true : { twoAppts, tooOld, within };
  });

  await check('8-25 · 8-26: 그룹 약속이 없는 개인 알람의 미확인 · 친구 권한만 있고 그룹 약속이 없는 사람은 친구 알림 0 — 그날 그룹 약속의 그룹원에게만 감', async () => {
    const S = await join_(42, '개인알람'), F = await join_(43, '친구'), G2 = await join_(44, '약속없는그룹');
    const al = await wakeAlarm(S, at('07:00'));
    await ev(al, S, 'MISSED', at('07:30'));
    await call(S, 'public.send_friend_request($1)', [F]); await call(F, 'public.accept_friend_request($1)', [S]);
    const g = await mkGroup(S, [G2], [S]);                                      // 그룹은 있지만 오늘 약속이 없음
    const r = await claim(at('07:45'), S);
    return r.length === 0 ? true : r;
  });

  await check('8-27 · 8-28 · 8-29: 받는 사람 후보 — 차단 · 알림 끈 · 나를 숨긴 · 기상 공유 안 한 쪽은 제외, 두 그룹에 같이 있어도 한 번, 한 그룹 알림만 꺼도 다른 그룹 몫으로는 받음', async () => {
    const S = await join_(46, '잠꾸러기'), BL = await join_(47, '차단'), OFF = await join_(48, '알림끔'), HID = await join_(49, '숨김'), TW = await join_(50, '두그룹'), OK1 = await join_(51, '보통');
    const g1 = await mkGroup(OK1, [S, BL, OFF, HID, TW], [S]);
    const g2 = await mkGroup(TW, [S], [S]);
    for (const g of [g1, g2]) await appt(OK1, g, at('08:30'));
    await q(`update public.group_members set notifications_off = true where group_id = $1 and user_id = $2`, [g1, OFF]);
    await call(S, 'public.set_wake_hidden($1, true)', [HID]);
    await call(BL, 'public.block_user($1)', [S]);
    const al = await wakeAlarm(S, at('07:00'));
    await ev(al, S, 'MISSED', at('07:30'));
    const r = await claim(at('07:45'), S);
    // TW는 g1 · g2에 둘 다 있고, g1 알림은 안 껐으니 한 번 받음. OFF가 g2에도 있고 g2 알림을 껐다면 g1 몫은 못 받아도 g2 몫은 받음 — 아래에서 따로 확인
    const twCount = r.filter((x) => x.recipient_id === TW).length;
    const S2 = await join_(52, '두번째'), TG = await join_(53, '한그룹끔');
    const h1 = await mkGroup(TG, [S2], [S2]), h2 = await mkGroup(S2, [TG], [S2]);
    for (const g of [h1, h2]) await appt(TG, g, at('08:30'));
    await q(`update public.group_members set notifications_off = true where group_id = $1 and user_id = $2`, [h1, TG]);
    const al2 = await wakeAlarm(S2, at('07:00'));
    await ev(al2, S2, 'MISSED', at('07:30'));
    const r2 = await claim(at('07:46'), S2);
    return JSON.stringify(targetsOf(r.filter((x) => x.sleeper_id === S))) === JSON.stringify(sorted(OK1, TW)) && twCount === 1
      && r2.filter((x) => x.sleeper_id === S2 && x.recipient_id === TG).length === 1 ? true : { r, r2, twCount };
  });

  await check('8-30: 친구 알림을 받은 뒤 본인이 늦게 확인하면 후속 1회("일어났어요") — 같은 사람에게 한 번만, 확인 전에는 안 보냄', async () => {
    const { S, V1, V2, g, al } = await missedCase(55);
    const nudge = await claim(at('07:45'), S);
    const noneYet = await claim(at('07:50'), S);
    await ev(al, S, 'WAKE_CONFIRMED', at('07:55'), { src: 'BUTTON' });
    const up = await claim(at('08:00'), S);
    const upAgain = await claim(at('08:05'), S);
    return nudge.length === 2 && noneYet.length === 0 && up.length === 2 && up.every((x) => x.kind === 'UP' && x.sleeper_id === S && x.group_id === g) && JSON.stringify(targetsOf(up)) === JSON.stringify(sorted(V1, V2)) && upAgain.length === 0 ? true : { nudge, noneYet, up, upAgain };
  });

  await check('8-30(보강): 후속은 자동 판정(USAGE) 확인이 20분 지난 뒤부터, 받는 사람이 그사이 상대를 차단했으면 안 보냄', async () => {
    const a = await missedCase(111);
    const first = await claim(at('07:45'), a.S);
    await ev(a.al, a.S, 'WAKE_CONFIRMED', at('07:50'), { src: 'USAGE' });
    const tooSoon = await claim(at('08:05'), a.S);                  // 확인 15분 — 아직 친구에게 안 보이는 중
    const ready = await claim(at('08:11'), a.S);                    // 21분
    const b = await missedCase(114);
    const firstB = await claim(at('07:45'), b.S);
    await call(b.V1, 'public.block_user($1)', [b.S]);
    await ev(b.al, b.S, 'WAKE_CONFIRMED', at('07:55'), { src: 'BUTTON' });
    const afterBlock = await claim(at('08:00'), b.S);
    const c = await missedCase(117);
    const firstC = await claim(at('07:45'), c.S);
    await q(`update public.group_members set notifications_off = true where group_id = $1 and user_id = $2`, [c.g, c.V2]);   // 친구 알림을 받은 뒤 이 그룹 알림을 끔
    await ev(c.al, c.S, 'WAKE_CONFIRMED', at('07:55'), { src: 'BUTTON' });
    const offOne = await claim(at('08:00'), c.S);
    return first.length === 2 && tooSoon.length === 0 && ready.length === 2 && ready.every((x) => x.kind === 'UP')
      && firstB.length === 2 && afterBlock.length === 1 && afterBlock[0].recipient_id === b.V2
      && firstC.length === 2 && offOne.length === 1 && offOne[0].recipient_id === c.V1 ? true : { first, tooSoon, ready, firstB, afterBlock, firstC, offOne };
  });

  await check('8-36: "친구 지연" 알림은 없음 — 보내는 종류는 깨우기 · 미확인 · 후속뿐이고 약속에 늦을 것 같은 사람에 대한 별도 후보가 없음', async () => {
    const { S, V1 } = await missedCase(58);
    const kinds = new Set((await claim(at('07:45'), S)).map((x) => x.kind));
    return kinds.size === 1 && kinds.has('NUDGE') ? true : [...kinds];
  });

  // ---- 음성 안내 -------------------------------------------------------------------------------------

  await check('8-31: 음성 안내 조회 — 오늘 약속이 있는 내 그룹별로 그룹 이름 + 일어난 사람 수(내가 볼 수 있는 사람, 나 빼고), 사람 이름은 없음. 일어난 사람이 없으면 줄이 없음', async () => {
    const A = await join_(70, '듣는이'), B = await join_(71, '일어남1'), C = await join_(72, '일어남2'), D2 = await join_(73, '자는중'), H = await join_(74, '숨김');
    const g = await mkGroup(A, [B, C, D2, H], [B, C, D2, H]);
    await appt(A, g, at('10:00'));
    const g2 = await mkGroup(A, [B], [B]);                                   // 둘째 그룹 — 일어난 사람 1명 (B)
    await appt(A, g2, at('11:00'));
    const bAl = await wakeAlarm(B, at('06:50')), cAl = await wakeAlarm(C, at('06:55')), dAl = await wakeAlarm(D2, at('07:00')), hAl = await wakeAlarm(H, at('06:50'));
    const aAl = await wakeAlarm(A, at('07:00'));
    await ev(aAl, A, 'WAKE_CONFIRMED', at('06:58'), { src: 'BUTTON' });   // 내 확인은 안 셈(나 빼고)
    await ev(bAl, B, 'WAKE_CONFIRMED', at('06:52'), { src: 'BUTTON' });
    await ev(cAl, C, 'WAKE_CONFIRMED', at('06:58'), { src: 'LOCATION' });
    await ev(hAl, H, 'WAKE_CONFIRMED', at('06:53'), { src: 'BUTTON' });
    await call(H, 'public.set_wake_hidden($1, true)', [A]);                    // 숨긴 사람은 안 셈
    const announce = async (viewer, now) => { await su(); return q(`select * from private.wake_announcement($1, $2::timestamptz)`, [viewer, now]); };
    const r = await announce(A, at('07:05'));
    const quiet = await announce(A, at('06:40'));
    await as(A);
    const pub = await q(`select * from public.get_wake_announcement()`);
    await su();
    return r.length === 2 && r[0].group_id === g && r[0].group_name === '깨우기그룹' && r[0].up_count === 2 && r[1].group_id === g2 && r[1].up_count === 1 && Object.keys(r[0]).sort().join() === 'group_id,group_name,up_count'
      && quiet.length === 0 && Array.isArray(pub) ? true : { r, quiet, pub };
  });

  await check('8-14(보강): 횟수를 센 줄 번호(send_id)를 돌려줌 — 판정만 할 땐 없음. 서버가 푸시가 한 건도 못 나갔을 때 그 줄을 지워 횟수를 돌려놓으면 같은 5분 안에도 다시 보낼 수 있음', async () => {
    const { A, B } = await base(120);
    const peek = await ping(A, B, at('07:05'));
    const first = await ping(A, B, at('07:05'), true);
    const row = await q(`select send_id, kind, sender_id, target_id from public.push_sends where send_id = $1`, [first.send_id]);
    const blocked = await ping(A, B, at('07:06'), true);                       // 방금 보냈으니 WAIT
    await q(`delete from public.push_sends where send_id = $1`, [first.send_id]);   // 서버가 하는 일 (service_role)
    const again = await ping(A, B, at('07:06'), true);
    return peek.send_id === undefined && Number.isInteger(first.send_id) && row.length === 1 && row[0].kind === 'WAKE_PING' && row[0].sender_id === A && row[0].target_id === B
      && blocked.status === 'WAIT' && blocked.send_id === undefined && again.status === 'OK' && again.count === 1 ? true : { peek, first, row, blocked, again };
  });

  await check('8-21(보강2): 자동 판정(USAGE) 확인은 아직 친구에게 안 보이는 20분 안이어도 본인 확인으로 쳐서 친구 알림을 취소함', async () => {
    const { S, al } = await missedCase(140);
    await ev(al, S, 'WAKE_CONFIRMED', at('07:35'), { src: 'USAGE' });
    const r = await claim(at('07:40'), S);
    return r.length === 0 ? true : r;
  });

  await check('8-24(새벽 약속): 새벽 약속(다음 날 01:00)이면 알람이 울리는 전날 밤에도 친구 알림을 보냄(7장 "약속 있는 날"과 같은 기준) — 그 약속이 이미 시작했으면 안 보냄', async () => {
    const mk = async (n) => {
      const S = await join_(n, '밤샘'), V = await join_(n + 1, '보는이');
      const g = await mkGroup(V, [S], [S, V]);
      const apId = await appt(V, g, at('01:00', '2026-11-11'));
      const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [apId, S]);
      const [al] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3::timestamptz) returning alarm_id`, [pt.participant_id, S, at('23:00')]);
      await ev(al.alarm_id, S, 'TRIGGERED', at('23:00'));
      await ev(al.alarm_id, S, 'MISSED', at('23:30'));
      return { S, V };
    };
    const a = await mk(122), b = await mk(124);
    const sent = await claim(at('23:40'), a.S);
    const started = await claim(at('01:10', '2026-11-11'), b.S);                 // 약속(01:00)이 시작한 뒤
    return sent.length === 1 && sent[0].recipient_id === a.V && sent[0].kind === 'NUDGE' && started.length === 0 ? true : { sent, started };
  });

  await check('8-30(보강2): 후속 "일어났어요"는 친구 알림을 보낸 지 12시간 안에 본인이 확인했을 때만 — 12시간이 지나면 안 보냄', async () => {
    const a = await missedCase(126), b = await missedCase(129);
    await claim(at('07:45'), a.S, b.S);                                         // 친구 알림 07:45
    await ev(a.al, a.S, 'WAKE_CONFIRMED', at('07:55'), { src: 'BUTTON' });
    await ev(b.al, b.S, 'WAKE_CONFIRMED', at('07:55'), { src: 'BUTTON' });
    const within = await claim(at('19:44'), a.S);                               // 11시간 59분
    const over = await claim(at('19:46'), b.S);                                 // 12시간 1분
    return within.length === 2 && within.every((x) => x.kind === 'UP') && over.length === 0 ? true : { within, over };
  });

  await check('8-22(보강): 기상 알람이 아닌 알람(준비 · 출발)의 미확인은 친구 알림을 만들지 않음', async () => {
    const S = await join_(132, '잠꾸러기'), V = await join_(133, '보는이');
    const g = await mkGroup(V, [S], [S, V]);
    await appt(V, g, at('09:30'));
    const [prep] = await q(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'PREPARE', $2::timestamptz) returning alarm_id`, [S, at('07:00')]);
    await ev(prep.alarm_id, S, 'MISSED', at('07:30'));
    const r = await claim(at('07:45'), S);
    return r.length === 0 ? true : r;
  });

  await check('8-29(보강): 두 그룹에 같이 있으면 한 번만 받고, 누르면 열 그룹은 조건에 맞는 그룹 중 id가 가장 작은 것', async () => {
    const S = await join_(134, '잠꾸러기'), V = await join_(135, '보는이');
    const g1 = await mkGroup(V, [S], [S, V]), g2 = await mkGroup(V, [S], [S, V]);
    for (const g of [g1, g2]) await appt(V, g, at('09:30'));
    const al = await wakeAlarm(S, at('07:00'));
    await ev(al, S, 'MISSED', at('07:30'));
    const r = await claim(at('07:45'), S);
    const smallest = [g1, g2].sort()[0];
    return r.length === 1 && r[0].recipient_id === V && r[0].group_id === smallest ? true : { r, g1, g2 };
  });

  await check('8-31(보강): get_wake_announcement()는 부른 사람(auth.uid()) 시점 — 듣는 사람은 일어난 사람 수를 받고, 같은 그룹이 아닌 사람 · 보이는 사람이 없는 사람은 줄이 없음', async () => {
    // 이 함수는 지금(now())을 읽으므로 오늘 한국 시간 0시의 기상 알람 · 확인과 오늘 낮 12시 약속으로 만듦 (시계와 무관)
    const [{ t: start }] = await q(`select ((now() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul') as t`);
    const zero = new Date(start).toISOString(), noon = new Date(new Date(start).getTime() + 12 * 3600_000).toISOString();
    const L = await join_(136, '듣는이'), U = await join_(137, '일어남'), X = await join_(138, '남');
    const g = await mkGroup(L, [U], [U]);
    await appt(L, g, noon);
    const al = await wakeAlarm(U, zero);
    await ev(al, U, 'WAKE_CONFIRMED', zero, { src: 'BUTTON' });
    const mine = async (uid) => { await as(uid); const r = await q(`select * from public.get_wake_announcement()`); await su(); return r; };
    const listener = await mine(L), self = await mine(U), stranger = await mine(X);
    return listener.length === 1 && listener[0].group_id === g && listener[0].up_count === 1 && self.length === 0 && stranger.length === 0 ? true : { listener, self, stranger };
  });

  await check('8장 실행 권한: plan_wake_ping · claim_wake_nudges는 서버 역할만, my_wake_pings · get_wake_announcement는 앱(로그인한 사람)이 부르고 anon은 못 부름, push_sends는 앱이 못 읽음', async () => {
    const A = await join_(76, '에이');
    await as(A);
    const app = [await expectErr(() => q(`select public.plan_wake_ping($1, $2, false, now())`, [A, NOBODY]), /permission denied/),
                 await expectErr(() => q(`select * from public.claim_wake_nudges(now())`), /permission denied/),
                 await expectErr(() => q(`select * from public.push_sends`), /permission denied/)];
    const mine = await q(`select * from public.my_wake_pings()`);
    await as(null, 'anon');
    const anon = [await expectErr(() => q(`select * from public.my_wake_pings()`), /permission denied/), await expectErr(() => q(`select * from public.get_wake_announcement()`), /permission denied/)];
    await su();
    return app.every((x) => x === true) && Array.isArray(mine) && anon.every((x) => x === true) ? true : { app, mine, anon };
  });
}
