// 친구 7장 — 그룹 기상 상태 (친구_시험케이스.md 7장 DB · 함수 층, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호
//   이 장 DB에 없는 것: 7-02의 앱 문구 · 7-13 ~ 7-15 · 7-17 · 7-18 · 7-34 ~ 7-36 · 7-41 ~ 7-43의 화면 글자 · 7-30 · 7-32 ~ 7-33의 실기기(앱 · 대본 · 실기기 층)
//   시간이 걸린 규칙(20분 · 30분)은 서버가 now()를 직접 읽는 공개 함수 대신 같은 본문인 private.group_wake_rows(…, 지금)로 시각을 고정해 확인
//   사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch07({ q, as, su, svc, check, expectErr }) {
  const id = (n) => `b7000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const NOBODY = 'b7000000-0000-4000-8000-999999999999';
  const D = '2026-11-10';                    // 시험하는 날(고정). 한국 시간 기준
  const at = (hhmm, day = D, off = '+09:00') => `${day}T${hhmm}:00${off}`;

  const join_ = async (n, nickname, tz = null) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f7-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f7_user_${n}`]);
    if (tz) await q(`update public.profiles set timezone = $2 where user_id = $1`, [id(n), tz]);
    return id(n);
  };
  const call = async (uid, sql, params = []) => { await as(uid); const [r] = await q(`select ${sql} as r`, params); await su(); return r.r; };
  const clearLimits = (...uids) => q(`delete from public.rate_limit_events where user_id = any($1::uuid[])`, [uids]);
  const befriend = async (a, b) => {
    await call(a, 'public.send_friend_request($1)', [b]);
    await call(b, 'public.accept_friend_request($1)', [a]);
    await clearLimits(a, b);
  };
  // 그룹 — 만든 사람은 트리거가 참여 중으로 넣고, 나머지는 바로 참여 중. optIn = 기상 공유 동의
  const mkGroup = async (owner, others = [], optIn = []) => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('기상그룹', $1) returning group_id`, [owner]);
    await su();
    for (const u of others) {
      await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in) values ($1, $2, 'JOINED', now(), $3)`, [g.group_id, u, optIn.includes(u)]);
    }
    if (optIn.includes(owner)) await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [g.group_id, owner]);
    return g.group_id;
  };
  const setOptIn = (u, g, v) => q(`update public.group_members set wake_share_opt_in = $3 where group_id = $1 and user_id = $2`, [g, u, v]);
  const appt = async (owner, g, when, title = '그룹 약속') => (await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, $3, $4::timestamptz, '학교') returning appointment_id`, [owner, g, title, when]))[0].appointment_id;
  const wakeAlarm = async (u, when, { enabled = true } = {}) => (await q(`insert into public.alarms (user_id, alarm_type, scheduled_at, is_enabled) values ($1, 'WAKE', $2::timestamptz, $3) returning alarm_id`, [u, when, enabled]))[0].alarm_id;
  const ev = (alarmId, u, type, when, { snooze = null, src = null } = {}) =>
    q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, snooze_minutes, input_source) values ($1, $2, $3, $4::timestamptz, $5, $6)`, [alarmId, u, type, when, snooze, src]);
  const eventCount = async (u, type) => (await q(`select count(*)::int as n from public.alarm_events where user_id = $1 and event_type = $2`, [u, type]))[0].n;
  // 비교용: 시각을 고정해 부름 (viewer, 그룹, 날짜, 지금)
  const rows = (viewer, g, date = D, now = at('12:00')) => q(`select * from private.group_wake_rows($1, $2, $3::date, $4::timestamptz) order by is_me desc, user_id`, [viewer, g, date, now]);
  const who = (r) => r.map((x) => x.user_id).sort();
  const of = (r, u) => r.find((x) => x.user_id === u);
  const sorted = (...x) => x.slice().sort();
  const signals = () => q(`select topic, event, payload from realtime.messages order by id`);
  const clearSignals = () => q(`truncate realtime.messages`);
  const iso = (v) => (v == null ? null : new Date(v).toISOString());
  const hide = (owner, other, hidden = true) => call(owner, 'public.set_wake_hidden($1, $2)', [other, hidden]);

  // ---- 누구 줄이 보이나 ----------------------------------------------------------------------

  await check('7-01 · 7-04 · 7-05 · 7-07: 약속이 있는 날, 나 + 기상 공유에 동의한 참여 중 멤버만 — 권한 행이 없어도 동의 하나로 보이고, 동의를 끄면 사라지고, 내 줄은 동의와 상관없이 늘 나옴', async () => {
    const A = await join_(1, '보는이'), B = await join_(2, '동의'), C = await join_(3, '동의안함');
    const g = await mkGroup(A, [B, C], [B]);
    await appt(A, g, at('10:00'));
    for (const u of [A, B, C]) await wakeAlarm(u, at('08:00'));
    const permRows = (await q(`select count(*)::int as n from public.sharing_permissions where owner_id = any($1::uuid[])`, [[A, B, C]]))[0].n;
    const on = await rows(A, g);
    await setOptIn(B, g, false);
    const off = await rows(A, g);
    const mineOnly = await rows(C, g);       // 동의 안 한 C도 자기 줄은 나옴
    return permRows === 0 && JSON.stringify(who(on)) === JSON.stringify(sorted(A, B)) && JSON.stringify(who(off)) === JSON.stringify([A])
      && of(on, A).is_me === true && of(on, B).is_me === false && JSON.stringify(who(mineOnly)) === JSON.stringify([C]) ? true : { permRows, on, off, mineOnly };
  });

  await check('7-08 · 7-09: 그룹 밖 사람 · 초대만 받은 사람 · 나간 사람이 부르면 0행, 초대만 받은 사람 · 나간 사람의 줄은 동의가 남아 있어도 안 나옴', async () => {
    const A = await join_(4, '보는이'), B = await join_(5, '초대만'), L = await join_(6, '나감'), X = await join_(7, '밖');
    const g = await mkGroup(A, [L], [L]);
    await q(`insert into public.group_members (group_id, user_id, invite_status, wake_share_opt_in) values ($1, $2, 'INVITED', true)`, [g, B]);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, L]);
    await appt(A, g, at('10:00'));
    for (const u of [A, B, L]) await wakeAlarm(u, at('08:00'));
    const outsider = await rows(X, g), invited = await rows(B, g), left = await rows(L, g), mine = await rows(A, g), ghost = await rows(A, NOBODY), nobody = await rows(null, g);
    return outsider.length === 0 && invited.length === 0 && left.length === 0 && JSON.stringify(who(mine)) === JSON.stringify([A]) && ghost.length === 0 && nobody.length === 0 ? true : { outsider, invited, left, mine, ghost, nobody };
  });

  await check('7-10: 차단한 사이(어느 쪽이 걸었든)는 서로의 줄이 안 나옴 — 값도 없음', async () => {
    const A = await join_(8, '에이'), B = await join_(9, '비'), C = await join_(10, '씨');
    const g = await mkGroup(A, [B, C], [A, B, C]);
    await appt(A, g, at('10:00'));
    for (const u of [A, B, C]) await wakeAlarm(u, at('08:00'));
    await call(B, 'public.block_user($1)', [A]);
    const a = await rows(A, g), b = await rows(B, g), c = await rows(C, g);
    return JSON.stringify(who(a)) === JSON.stringify(sorted(A, C)) && JSON.stringify(who(b)) === JSON.stringify(sorted(B, C)) && JSON.stringify(who(c)) === JSON.stringify(sorted(A, B, C)) ? true : { a, b, c };
  });

  await check('7-11: 두 그룹에 같이 있는 사람이 한 그룹에만 동의하면 동의한 그룹에서만 보임', async () => {
    const A = await join_(11, '에이'), B = await join_(12, '비');
    const g1 = await mkGroup(A, [B], [B]), g2 = await mkGroup(A, [B], []);
    for (const g of [g1, g2]) await appt(A, g, at('10:00'));
    for (const u of [A, B]) await wakeAlarm(u, at('08:00'));
    const one = await rows(A, g1), two = await rows(A, g2);
    return who(one).length === 2 && who(two).length === 1 && who(two)[0] === A ? true : { one, two };
  });

  await check('7-06 · 7-43: 내 기상을 특정 사람에게만 숨길 수 있음 — 친구도 친구 아닌 그룹원도 되고, 숨긴 사람 줄만 사라지고 나는 그 사람 줄을 계속 봄, 다시 보이게 하면 돌아옴', async () => {
    const A = await join_(13, '보는이'), B = await join_(14, '숨김'), C = await join_(15, '남');
    const g = await mkGroup(A, [B, C], [A, B, C]);
    await befriend(A, B);                     // A-B는 친구, A-C는 친구 아닌 그룹원
    await appt(A, g, at('10:00'));
    for (const u of [A, B, C]) await wakeAlarm(u, at('08:00'));
    const before = await rows(A, g);
    const h1 = await hide(B, A), h2 = await hide(C, A);            // B · C가 A에게 기상을 숨김
    const hidden = await rows(A, g), bSees = await rows(B, g);
    const again = await hide(B, A);                                  // 같은 걸 또 해도 OK(행 하나)
    const n = (await q(`select count(*)::int as n from public.wake_hides where owner_id = $1 and hidden_from_id = $2`, [B, A]))[0].n;
    const un = await hide(B, A, false);
    const back = await rows(A, g);
    return who(before).length === 3 && h1.status === 'OK' && h2.status === 'OK' && JSON.stringify(who(hidden)) === JSON.stringify([A]) && who(bSees).length === 3
      && again.status === 'OK' && n === 1 && un.status === 'OK' && JSON.stringify(who(back)) === JSON.stringify(sorted(A, B)) ? true : { before, h1, h2, hidden, bSees, again, n, un, back };
  });

  await check('7-43(함수): set_wake_hidden — 나 자신 · 없는 사람 · 관계 없는 사람은 NOT_FOUND, 로그인이 없으면 거절, 숨긴 목록은 숨긴 본인만 읽고 숨김당한 쪽은 못 읽음(몰라야 함), 앱이 표를 직접 못 고침', async () => {
    const A = await join_(16, '숨기는이'), B = await join_(17, '그룹원'), X = await join_(18, '남');
    const g = await mkGroup(A, [B], [A, B]);
    const self = await hide(A, A), ghost = await hide(A, NOBODY), stranger = await hide(A, X), nul = await hide(A, null);
    const ok = await hide(A, B);
    await as(null);
    const noLogin = await expectErr(() => q(`select public.set_wake_hidden($1, true)`, [B]), /로그인이 필요함/);
    await as(null, 'anon');
    const anon = await expectErr(() => q(`select public.set_wake_hidden($1, true)`, [B]), /permission denied/);
    await as(A);
    const mine = await q(`select hidden_from_id from public.wake_hides`);
    const direct = await expectErr(() => q(`insert into public.wake_hides (owner_id, hidden_from_id) values ($1, $2)`, [A, X]), /permission denied/);
    await as(B);
    const theirs = await q(`select hidden_from_id from public.wake_hides`);       // 숨김당한 B는 자기가 숨겨진 걸 못 봄
    await su();
    const left = await call(A, 'public.set_wake_hidden($1, false)', [X]);          // 관계가 없어도 거두기는 OK(옛 행을 치울 수 있게)
    return self.status === 'NOT_FOUND' && ghost.status === 'NOT_FOUND' && stranger.status === 'NOT_FOUND' && nul.status === 'NOT_FOUND' && ok.status === 'OK'
      && noLogin === true && anon === true && mine.length === 1 && mine[0].hidden_from_id === B && direct === true && theirs.length === 0 && left.status === 'OK' ? true : { self, ghost, stranger, nul, ok, noLogin, anon, mine, direct, theirs, left };
  });

  // ---- 약속 있는 날 ------------------------------------------------------------------------

  await check('7-02 · 7-03 · 7-27: 그 그룹에 약속이 없는 날(어제 · 내일 · 다른 그룹 약속뿐 · 약속이 한 번도 없음)은 빈 결과, 자정 경계(23:59 · 00:00)가 정확하고 자정을 넘으면 새 날 상태로 시작', async () => {
    const A = await join_(19, '에이'), B = await join_(20, '비');
    const g = await mkGroup(A, [B], [B]), other = await mkGroup(A, [B], [B]), empty = await mkGroup(A, [B], [B]);
    await appt(A, g, at('00:00', '2026-11-11'));            // 내일 0시 정각 = 내일 약속
    await appt(A, g, at('23:59', '2026-11-08'));            // 그제 23:59
    await appt(A, other, at('10:00'));                      // 오늘 약속은 다른 그룹 것
    for (const u of [A, B]) { await wakeAlarm(u, at('08:00')); await wakeAlarm(u, at('08:00', '2026-11-11')); }
    const today = await rows(A, g), tomorrow = await rows(A, g, '2026-11-11'), yesterday = await rows(A, g, '2026-11-09'), twoDays = await rows(A, g, '2026-11-08');
    const otherToday = await rows(A, other), none = await rows(A, empty);
    const midnight = of(await rows(A, g, '2026-11-11', at('00:01', '2026-11-11')), A);    // 새 날은 "8:00 알람" 상태로 시작
    return today.length === 0 && yesterday.length === 0 && tomorrow.length === 2 && twoDays.length === 2 && otherToday.length === 2 && none.length === 0
      && midnight.wake_status === 'SCHEDULED' ? true : { today, tomorrow, yesterday, twoDays, otherToday, none, midnight };
  });

  await check('7-23: 새벽 약속(00:30)의 기상은 알람이 울린 날(전날 23:00)로 셈 — 전날이 약속 있는 날이고, 약속 날짜로는 기상 줄이 안 나옴', async () => {
    const A = await join_(21, '에이'), B = await join_(22, '새벽');
    const g = await mkGroup(A, [B], [B]);
    const ap = await appt(A, g, at('00:30', '2026-11-11'));
    for (const u of [A, B]) {
      const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, u]);
      await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3::timestamptz)`, [pt.participant_id, u, at('23:00')]);
    }
    const [{ alarm_id: bAlarm }] = await q(`select alarm_id from public.alarms where user_id = $1`, [B]);
    await ev(bAlarm, B, 'WAKE_CONFIRMED', at('23:05'));
    const eve = await rows(A, g, D, at('23:20'));                          // 전날
    const day = await rows(A, g, '2026-11-11', at('23:20'));               // 약속 날짜: 약속은 있지만 그날 기상 알람은 없음
    return JSON.stringify(who(eve)) === JSON.stringify(sorted(A, B)) && of(eve, B).wake_status === 'CONFIRMED' && iso(of(eve, B).wake_alarm_at) === iso(at('23:00'))
      && of(eve, A).wake_status === 'SCHEDULED' && day.every((x) => x.wake_status === 'NO_ALARM') ? true : { eve, day };
  });

  await check('7-22: 하루는 사람마다 프로필 시간대로 셈 — 서울 A가 보는 UTC B의 기상은 B의 날짜(UTC)로 잡히고, 시각은 같은 순간 그대로', async () => {
    const A = await join_(23, '서울'), B = await join_(24, '유티씨', 'UTC');
    const g = await mkGroup(A, [B], [B]);
    await appt(A, g, at('10:00'));
    await wakeAlarm(A, at('08:00'));
    await wakeAlarm(B, '2026-11-10T16:00:00Z');                       // = 서울 11/11 01:00, UTC로는 11/10
    const r = await rows(A, g, D, '2026-11-10T17:00:00Z');
    const seoulWindow = await q(`select count(*)::int as n from public.alarms where user_id = $1 and scheduled_at >= '2026-11-09T15:00:00Z' and scheduled_at < '2026-11-10T15:00:00Z'`, [B]);   // 서울 날짜 11/10에는 안 들어가는 알람
    return JSON.stringify(who(r)) === JSON.stringify(sorted(A, B)) && iso(of(r, B).wake_alarm_at) === '2026-11-10T16:00:00.000Z' && of(r, B).wake_status === 'MISSED'
      && seoulWindow[0].n === 0 ? true : { r, seoulWindow };
  });

  await check('7-24 · 7-25: 같은 날 알람이 여럿이면 그날 첫 기상 알람(개인 일정 알람도) 시각 하나만 — 사람마다 행은 1개, 일정 이름 · 장소는 응답에 없음', async () => {
    const A = await join_(25, '에이'), B = await join_(26, '비');
    const g = await mkGroup(A, [B], [B]);
    await appt(A, g, at('10:00'), '그룹 약속 하나'); await appt(A, g, at('15:00'), '그룹 약속 둘');
    await wakeAlarm(B, at('08:00')); await wakeAlarm(B, at('06:00')); await wakeAlarm(B, at('04:00'), { enabled: false });   // 꺼 둔 알람은 안 셈
    await wakeAlarm(A, at('07:00'));
    const r = await rows(A, g);
    const cols = Object.keys(r[0]).sort().join();
    return r.length === 2 && iso(of(r, B).wake_alarm_at) === iso(at('06:00')) && !/title|dest|memo|place/.test(cols) ? true : { r, cols };
  });

  // ---- 단계 · 값 ------------------------------------------------------------------------------

  await check('7-12 ~ 7-16 · 7-20 · 7-37: 단계(SCHEDULED → RINGING → DISMISSED → CONFIRMED)와 값 — 응답에는 단계 · 알람 시각 · 확인 시각만(미루기 횟수 · 알람 끈 시각 · 울린 시각 · 미확인 시각 칸 없음), 알람 전 기상은 그 시각으로 CONFIRMED', async () => {
    const A = await join_(27, '에이'), B = await join_(28, '비');
    const g = await mkGroup(A, [B], [B]);
    await appt(A, g, at('10:00'));
    await wakeAlarm(A, at('07:00'));
    const al = await wakeAlarm(B, at('08:00'));
    const pub = async (now) => { await as(A); const r = await q(`select * from public.get_group_wake($1, $2::date)`, [g, D]); await su(); return of(r, B); };
    const s0 = of(await rows(A, g, D, at('07:00')), B);
    await ev(al, B, 'TRIGGERED', at('08:00'));
    const s1 = of(await rows(A, g, D, at('08:05')), B);
    await ev(al, B, 'SNOOZED', at('08:01'), { snooze: 5 }); await ev(al, B, 'SNOOZED', at('08:07'), { snooze: 5 });
    const s2 = of(await rows(A, g, D, at('08:10')), B);
    await ev(al, B, 'DISMISSED', at('08:12'));
    const s3 = of(await rows(A, g, D, at('08:15')), B);
    await ev(al, B, 'WAKE_CONFIRMED', at('08:20'), { src: 'BUTTON' });
    const s4 = of(await rows(A, g, D, at('08:25')), B);
    const shape = await as(A).then(() => q(`select * from public.get_group_wake($1, $2::date)`, [g, D])).then(async (r) => { await su(); return r; });
    const cols = Object.keys(shape[0]).sort().join();
    // 알람 전에 일어남(D61): 깬 시각 그대로
    const C = await join_(29, '일찍'); await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in) values ($1, $2, 'JOINED', now(), true)`, [g, C]);
    const cal = await wakeAlarm(C, at('09:00'));
    await ev(cal, C, 'WAKE_CONFIRMED', at('07:40'), { src: 'BUTTON' });
    const early = of(await rows(A, g, D, at('07:45')), C);
    return s0.wake_status === 'SCHEDULED' && iso(s0.wake_alarm_at) === iso(at('08:00')) && s1.wake_status === 'RINGING' && s2.wake_status === 'RINGING' && s3.wake_status === 'DISMISSED'
      && s4.wake_status === 'CONFIRMED' && iso(s4.wake_confirmed_at) === iso(at('08:20'))
      && cols === 'is_me,nickname,profile_image_url,user_id,wake_alarm_at,wake_confirmed_at,wake_status'
      && early.wake_status === 'CONFIRMED' && iso(early.wake_confirmed_at) === iso(at('07:40')) ? true : { s0, s1, s2, s3, s4, cols, early };
  });

  await check('7-14(옛 모양): get_group_wake_status는 같은 값을 옛 11칸 모양으로 — 내 줄은 울린 시각 · 미루기 횟수 · 해제 시각이 차고, 다른 사람 줄은 그 칸이 비어 있음(미루기 0)', async () => {
    const P = new Date(Date.now() + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10);   // 어제(한국) — 공개 함수는 지금 시각 기준이라 기록이 지난 날이어야 보이고, 날짜는 어제~내일만 받음 (이슈 #431)
    const A = await join_(30, '에이'), B = await join_(31, '비'), M = await join_(72, '미확인');
    const g = await mkGroup(A, [B, M], [A, B, M]);
    await appt(A, g, at('10:00', P));
    const aa = await wakeAlarm(A, at('07:00', P)), ba = await wakeAlarm(B, at('07:00', P));
    await wakeAlarm(M, at('07:00', P));                  // 확인 없이 지난 날 → 미확인
    for (const [al, u] of [[aa, A], [ba, B]]) {
      await ev(al, u, 'TRIGGERED', at('07:00', P)); await ev(al, u, 'SNOOZED', at('07:01', P), { snooze: 5 }); await ev(al, u, 'DISMISSED', at('07:09', P));
      await ev(al, u, 'WAKE_CONFIRMED', at('07:12', P), { src: 'BUTTON' });
    }
    await as(A);
    const old = await q(`select * from public.get_group_wake_status($1, $2::date)`, [g, P]);
    await su();
    const me = of(old, A), other = of(old, B);
    const missedOther = of(old, M);
    await as(M);
    const missedMine = of(await q(`select * from public.get_group_wake_status($1, $2::date)`, [g, P]), M);
    await su();
    const cols = Object.keys(old[0]).sort().join();
    return cols === 'dismissed_at,is_me,missed_at,nickname,profile_image_url,rang_at,snooze_count,user_id,wake_alarm_at,wake_confirmed_at,wake_status'
      && me.snooze_count === 1 && iso(me.rang_at) === iso(at('07:00', P)) && iso(me.dismissed_at) === iso(at('07:09', P)) && me.wake_status === 'CONFIRMED'
      && other.rang_at === null && other.dismissed_at === null && other.missed_at === null && other.snooze_count === 0 && other.wake_status === 'CONFIRMED' && iso(other.wake_confirmed_at) === iso(at('07:12', P))
      && missedOther.wake_status === 'MISSED' && missedOther.missed_at === null && missedMine.wake_status === 'MISSED' && iso(missedMine.missed_at) === iso(at('07:30', P)) ? true : { me, other, missedOther, missedMine, cols };
  });

  await check('7-19: 저녁에 직접 입력한 기상(daily_records) · 직접 입력 · 대화 정정 출처의 확인 기록은 그룹에 안 띄움 — 내 기록만 고침', async () => {
    const A = await join_(32, '에이'), B = await join_(33, '직접입력'), C = await join_(34, '대화정정');
    const g = await mkGroup(A, [B, C], [A, B, C]);
    await appt(A, g, at('10:00'));
    await wakeAlarm(A, at('07:00'));
    const ba = await wakeAlarm(B, at('07:00')), ca = await wakeAlarm(C, at('07:00'));
    await q(`insert into public.daily_records (user_id, record_date, wake_confirmed_at) values ($1, $2::date, $3::timestamptz)`, [B, D, at('07:10')]);
    await ev(ba, B, 'WAKE_CONFIRMED', at('07:10'), { src: 'MANUAL' });
    await ev(ca, C, 'WAKE_CONFIRMED', at('07:12'), { src: 'VOICE' });
    const r = await rows(A, g, D, at('07:30')), mineB = await rows(B, g, D, at('07:30'));
    return of(r, B).wake_status !== 'CONFIRMED' && of(r, B).wake_confirmed_at === null && of(r, C).wake_status !== 'CONFIRMED' && of(mineB, B).wake_status !== 'CONFIRMED' ? true : { r, mineB };
  });

  await check('7-38: 자동 판정(폰 사용) 기상은 20분 뒤에 다른 사람에게 보임 — 내 화면에는 바로, [일어났어요]류(버튼)와 위치는 바로, 20분이 안 되면 해제만 한 상태("울렸어요") 그대로', async () => {
    const A = await join_(35, '에이'), B = await join_(36, '자동판정'), C = await join_(37, '버튼');
    const g = await mkGroup(A, [B, C], [A, B, C]);
    await appt(A, g, at('10:00'));
    await wakeAlarm(A, at('07:00'));
    const ba = await wakeAlarm(B, at('07:00')), ca = await wakeAlarm(C, at('07:00'));
    await ev(ba, B, 'TRIGGERED', at('07:00')); await ev(ba, B, 'DISMISSED', at('07:05')); await ev(ba, B, 'WAKE_CONFIRMED', at('07:10'), { src: 'USAGE' });
    await ev(ca, C, 'TRIGGERED', at('07:00')); await ev(ca, C, 'DISMISSED', at('07:05')); await ev(ca, C, 'WAKE_CONFIRMED', at('07:10'), { src: 'BUTTON' });
    const early = await rows(A, g, D, at('07:25'));            // 15분 뒤: 아직 안 보임
    const edge = await rows(A, g, D, at('07:30'));             // 정확히 20분: 보임
    const mine = await rows(B, g, D, at('07:11'));             // 본인은 바로
    return of(early, B).wake_status === 'DISMISSED' && of(early, B).wake_confirmed_at === null && of(early, C).wake_status === 'CONFIRMED'
      && of(edge, B).wake_status === 'CONFIRMED' && iso(of(edge, B).wake_confirmed_at) === iso(at('07:10')) && of(mine, B).wake_status === 'CONFIRMED' ? true : { early, edge, mine };
  });

  await check('7-32 · 7-40 · 7-17: 폰이 꺼졌거나 기록이 안 올라와도 알람 시각이 지나고 30분 동안 확인이 없으면 미확인("울렸어요")과 같게 MISSED — 마지막 미루기가 있으면 그 울림 시작부터 30분, 확인이 있으면 CONFIRMED, 서버가 기록한 MISSED도 같음', async () => {
    const A = await join_(38, '에이'), B = await join_(39, '폰꺼짐'), C = await join_(40, '미룸'), D2 = await join_(41, '기록됨');
    const g = await mkGroup(A, [B, C, D2], [A, B, C, D2]);
    await appt(A, g, at('12:00'));
    await wakeAlarm(A, at('07:00'));
    await wakeAlarm(B, at('07:00'));
    const ca = await wakeAlarm(C, at('07:00')), da = await wakeAlarm(D2, at('07:00'));
    await ev(ca, C, 'TRIGGERED', at('07:00')); await ev(ca, C, 'SNOOZED', at('07:20'), { snooze: 10 });      // 7:30에 다시 울림 시작 → 8:00까지 기다림
    await ev(da, D2, 'MISSED', at('07:45'));
    const at0729 = await rows(A, g, D, at('07:29')), at0731 = await rows(A, g, D, at('07:31')), at0759 = await rows(A, g, D, at('07:59')), at0801 = await rows(A, g, D, at('08:01'));
    const first = of(await rows(A, g, D, at('07:30')), B);
    return of(at0729, B).wake_status === 'SCHEDULED' && first.wake_status === 'MISSED' && of(at0731, B).wake_status === 'MISSED'
      && of(at0759, C).wake_status === 'RINGING' && of(at0801, C).wake_status === 'MISSED' && of(at0801, D2).wake_status === 'MISSED' ? true : { at0729, at0731, at0759, at0801, first };
  });

  await check('7-40 · 7-17(배치): find_missed_wake_alarms의 미확인 시각 = 마지막 울림 시작 + 30분 — 다시 울림 시간을 더하지 않음(강도와 상관없이), 반환에 다시 울림 칸 없음', async () => {
    const A = await join_(42, '에이');
    const soft = await wakeAlarm(A, at('06:00'));
    const strong = await q(`insert into public.alarms (user_id, alarm_type, scheduled_at, intensity) values ($1, 'WAKE', $2::timestamptz, 'STRONG') returning alarm_id`, [A, at('09:00')]);
    const snoozed = await q(`insert into public.alarms (user_id, alarm_type, scheduled_at, intensity) values ($1, 'WAKE', $2::timestamptz, 'NORMAL') returning alarm_id`, [A, at('12:00')]);
    await ev(snoozed[0].alarm_id, A, 'SNOOZED', at('12:10'), { snooze: 10 });
    await svc();
    const r = await q(`select * from public.find_missed_wake_alarms($1::timestamptz, 24)`, [at('23:00')]);
    await su();
    const pick = (al) => r.find((x) => x.alarm_id === al);
    const cols = Object.keys(r[0]).sort().join();
    return iso(pick(soft).missed_at) === iso(at('06:30')) && iso(pick(strong[0].alarm_id).missed_at) === iso(at('09:30')) && iso(pick(snoozed[0].alarm_id).missed_at) === iso(at('12:50'))
      && !cols.includes('rering') ? true : { r, cols };
  });

  await check('7-35 · 7-37: 응답에 수면 시간 · 메모 · 위치 · 강도 같은 칸이 없음 — 줄 하나의 칸은 일곱 개뿐', async () => {
    const A = await join_(43, '에이');
    const g = await mkGroup(A, [], [A]);
    await appt(A, g, at('10:00')); await wakeAlarm(A, at('07:00'));
    await as(A);
    const r = await q(`select * from public.get_group_wake($1, $2::date)`, [g, D]);
    await su();
    return r.length === 1 && Object.keys(r[0]).sort().join() === 'is_me,nickname,profile_image_url,user_id,wake_alarm_at,wake_confirmed_at,wake_status' ? true : r;
  });

  await check('7-43(대상): 숨기기는 친구이거나 둘 다 참여 중인 그룹원일 때만 — 같은 그룹이 없는 친구도 되고, 초대만 받은 사람 · 나간 사람 · 내가 나간 그룹의 사람은 NOT_FOUND', async () => {
    const A = await join_(66, '숨기는이'), F = await join_(67, '친구만'), I = await join_(68, '초대만'), L = await join_(69, '나감'), B = await join_(70, '그룹원'), M = await join_(71, '나간이');
    await befriend(A, F);
    const g = await mkGroup(A, [B, L, M], [A, B, L, M]);
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g, I]);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id in ($2, $3)`, [g, L, M]);
    const friend = await hide(A, F), invited = await hide(A, I), left = await hide(A, L), mine = await hide(M, B), ok = await hide(A, B);
    return friend.status === 'OK' && invited.status === 'NOT_FOUND' && left.status === 'NOT_FOUND' && mine.status === 'NOT_FOUND' && ok.status === 'OK' ? true : { friend, invited, left, mine, ok };
  });

  await check('7-23(시간대 · 꺼짐): 약속 있는 날의 알람 갈래는 알람 주인의 시간대로 날짜를 셈(보는 사람 시간대가 아님)이고 꺼 둔 알람은 안 셈', async () => {
    const A = await join_(79, '서울'), B = await join_(80, '유티씨', 'UTC'), C = await join_(81, '꺼둠');
    const g = await mkGroup(A, [B], [B]), g2 = await mkGroup(A, [C], [C]);
    const part = async (ap, u, when, enabled = true) => {
      const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, u]);
      await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at, is_enabled) values ($1, $2, 'WAKE', $3::timestamptz, $4)`, [pt.participant_id, u, when, enabled]);
    };
    await part(await appt(A, g, '2026-11-11T01:00:00Z'), B, '2026-11-10T23:30:00Z');             // 서울 11/11 10:00 약속 — 유티씨의 기상은 UTC 11/10 밤
    await part(await appt(A, g2, '2026-11-10T15:30:00Z'), C, '2026-11-10T14:00:00Z', false);     // 서울 11/11 00:30 약속 — 전날 밤 알람은 꺼져 있음
    const viaB = await rows(A, g, '2026-11-10', '2026-11-11T00:00:00Z');
    const viaC = await rows(A, g2, '2026-11-10', '2026-11-11T00:00:00Z');
    return JSON.stringify(who(viaB)) === JSON.stringify(sorted(A, B)) && iso(of(viaB, B).wake_alarm_at) === '2026-11-10T23:30:00.000Z' && viaC.length === 0 ? true : { viaB, viaC };
  });

  await check('7장 기록 구간: 기상 알람의 앞 6시간 ~ 뒤 18시간 안의 울림 · 미루기 · 해제만 그 알람의 것 — 밖의 기록(전날 저녁 · 다음 날 새벽)은 안 셈', async () => {
    const A = await join_(75, '에이'), B = await join_(76, '구간');
    const g = await mkGroup(A, [B], [A, B]);
    await appt(A, g, at('10:00'));
    await wakeAlarm(A, at('07:00'));
    const ba = await wakeAlarm(B, at('07:00'));
    await ev(ba, B, 'TRIGGERED', at('20:00', '2026-11-09'));                  // 11시간 앞 — 밖
    await ev(ba, B, 'TRIGGERED', at('06:30'));                                // 안
    await ev(ba, B, 'DISMISSED', at('23:30'));                                // 16시간 30분 뒤 — 안
    await ev(ba, B, 'SNOOZED', at('02:00', '2026-11-11'), { snooze: 5 });     // 19시간 뒤 — 밖
    const r = of(await rows(A, g, D, at('12:00')), B);
    return iso(r.rang_at) === iso(at('06:30')) && iso(r.dismissed_at) === iso(at('23:30')) && r.snooze_count === 0 ? true : r;
  });

  await check('7장 첫 알람 기준: 둘째 기상 알람의 미루기는 첫 알람의 미확인 시각을 늦추지 않음', async () => {
    const A = await join_(77, '에이'), B = await join_(78, '둘째알람');
    const g = await mkGroup(A, [B], [A, B]);
    await appt(A, g, at('12:00'));
    await wakeAlarm(A, at('07:00'));
    await wakeAlarm(B, at('07:00'));
    const b2 = await wakeAlarm(B, at('09:00'));
    await ev(b2, B, 'TRIGGERED', at('09:00')); await ev(b2, B, 'SNOOZED', at('09:20'), { snooze: 10 });
    const r = of(await rows(A, g, D, at('08:00')), B);
    return r.wake_status === 'MISSED' && iso(r.wake_alarm_at) === iso(at('07:00')) && iso(r.missed_at) === iso(at('07:30')) ? true : r;
  });

  await check('7-38(대기): 자동 판정 확인이 20분이 안 돼 숨겨진 동안은 미확인(MISSED)으로 바꾸지 않고 확인 대기 칸이 켜짐, 20분 뒤 CONFIRMED — 본인 화면은 바로 확인, 대기 칸 꺼짐', async () => {
    const A = await join_(73, '에이'), B = await join_(74, '대기');
    const g = await mkGroup(A, [B], [A, B]);
    await appt(A, g, at('10:00'));
    await wakeAlarm(A, at('07:00'));
    const ba = await wakeAlarm(B, at('07:00'));
    await ev(ba, B, 'TRIGGERED', at('07:00')); await ev(ba, B, 'DISMISSED', at('07:05'));
    await ev(ba, B, 'WAKE_CONFIRMED', at('07:35'), { src: 'USAGE' });         // 미확인 기준(07:30)이 지난 뒤 자동 판정으로 확인
    const during = of(await rows(A, g, D, at('07:40')), B);
    const own = of(await rows(B, g, D, at('07:40')), B);
    const later = of(await rows(A, g, D, at('07:55')), B);
    const mineA = of(await rows(A, g, D, at('07:40')), A);
    return during.wake_status === 'DISMISSED' && during.missed_at === null && during.confirm_pending === true && during.wake_confirmed_at === null
      && own.wake_status === 'CONFIRMED' && own.confirm_pending === false && mineA.confirm_pending === false
      && later.wake_status === 'CONFIRMED' && later.confirm_pending === false && iso(later.wake_confirmed_at) === iso(at('07:35')) ? true : { during, own, later, mineA };
  });

  await check('7-18: 약속이 있는 날 알람이 없거나 기상 알람을 꺼 둔 멤버는 "알람 없음"(NO_ALARM) 한 줄', async () => {
    const A = await join_(44, '에이'), B = await join_(45, '알람없음'), C = await join_(46, '꺼둠');
    const g = await mkGroup(A, [B, C], [A, B, C]);
    await appt(A, g, at('10:00'));
    await wakeAlarm(A, at('07:00')); await wakeAlarm(C, at('07:00'), { enabled: false });
    const r = await rows(A, g, D, at('06:00'));
    return of(r, A).wake_status === 'SCHEDULED' && of(r, B).wake_status === 'NO_ALARM' && of(r, C).wake_status === 'NO_ALARM' && of(r, B).wake_alarm_at === null ? true : r;
  });

  // ---- 기상 확인 하루 한 건 · 하루 기록 ------------------------------------------------------------

  await check('7-21: 기상 확인은 사람마다 하루 첫 한 건만 저장(폰 · 웹이 겹쳐도 먼저 것, 출처도 먼저 것) — 오류 없이 무시, 다음 날은 따로, 같은 사람의 다른 날 · 다른 사람은 영향 없음', async () => {
    const A = await join_(47, '에이'), B = await join_(48, '비');
    const a1 = await wakeAlarm(A, at('07:00')), a2 = await wakeAlarm(A, at('07:00', '2026-11-11')), b1 = await wakeAlarm(B, at('07:00'));
    await ev(a1, A, 'WAKE_CONFIRMED', at('07:10'), { src: 'BUTTON' });
    await ev(a1, A, 'WAKE_CONFIRMED', at('07:11'), { src: 'USAGE' });           // 같은 날 둘째 — 버림
    await ev(a1, A, 'WAKE_CONFIRMED', at('23:50'), { src: 'LOCATION' });        // 같은 날 늦게 — 버림
    await ev(a2, A, 'WAKE_CONFIRMED', at('07:05', '2026-11-11'), { src: 'BUTTON' });   // 다음 날
    await ev(b1, B, 'WAKE_CONFIRMED', at('07:20'), { src: 'BUTTON' });
    const mine = await q(`select event_at, input_source from public.alarm_events where user_id = $1 and event_type = 'WAKE_CONFIRMED' order by event_at`, [A]);
    return mine.length === 2 && iso(mine[0].event_at) === iso(at('07:10')) && mine[0].input_source === 'BUTTON' && iso(mine[1].event_at) === iso(at('07:05', '2026-11-11'))
      && (await eventCount(B, 'WAKE_CONFIRMED')) === 1 ? true : { mine };
  });

  await check('7-21(경계) · 7장 신호: 자정을 넘긴 기상 확인도 알람이 울린 날의 것 — 하루 한 건 · 하루 기록 · 그룹 줄 · 미확인 후보 · 신호 날짜가 같은 날로 맞고, 다음 날 아침 알람은 그 확인에 가려지지 않음(UTC 사람)', async () => {
    const U = await join_(49, '유티씨', 'UTC'), A = await join_(63, '서울');
    const g = await mkGroup(A, [U], [U]);
    const ap = await appt(A, g, '2026-11-11T08:00:00Z');
    const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, U]);
    const a1 = (await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3::timestamptz) returning alarm_id`, [pt.participant_id, U, '2026-11-10T23:50:00Z']))[0].alarm_id;
    const a2 = await wakeAlarm(U, '2026-11-11T05:00:00Z');
    await clearSignals();
    await ev(a1, U, 'WAKE_CONFIRMED', '2026-11-11T00:10:00Z', { src: 'BUTTON' });      // 자정을 넘겨 확인 → 알람이 울린 날(11/10)
    const sig = await signals();
    await ev(a1, U, 'WAKE_CONFIRMED', '2026-11-11T00:20:00Z', { src: 'BUTTON' });      // 같은 기상한 날 둘째 — 버림
    const n1 = await eventCount(U, 'WAKE_CONFIRMED');
    const recs1 = await q(`select record_date::text as d, wake_confirmed_at from public.daily_records where user_id = $1 order by record_date`, [U]);
    const night = of(await rows(A, g, '2026-11-10', '2026-11-11T00:30:00Z'), U);
    const morning = of(await rows(A, g, '2026-11-11', '2026-11-11T05:40:00Z'), U);     // 아침 알람은 아직 확인 없음 → 30분 지나 미확인
    await svc();
    const miss = await q(`select alarm_id from public.find_missed_wake_alarms($1::timestamptz, 24) where user_id = $2`, ['2026-11-11T05:40:00Z', U]);
    await su();
    await ev(a2, U, 'WAKE_CONFIRMED', '2026-11-11T05:05:00Z', { src: 'BUTTON' });      // 다음 날 아침 확인 — 따로 저장
    const n2 = await eventCount(U, 'WAKE_CONFIRMED');
    const recs2 = await q(`select record_date::text as d from public.daily_records where user_id = $1 order by record_date`, [U]);
    const after = of(await rows(A, g, '2026-11-11', '2026-11-11T05:40:00Z'), U);
    return sig.length === 1 && sig[0].topic === `group:${g}:wake` && JSON.stringify(sig[0].payload) === JSON.stringify({ date: '2026-11-10' })
      && n1 === 1 && recs1.length === 1 && recs1[0].d === '2026-11-10' && iso(recs1[0].wake_confirmed_at) === '2026-11-11T00:10:00.000Z'
      && night.wake_status === 'CONFIRMED' && iso(night.wake_confirmed_at) === '2026-11-11T00:10:00.000Z'
      && morning.wake_status === 'MISSED' && miss.length === 1 && miss[0].alarm_id === a2
      && n2 === 2 && recs2.map((x) => x.d).join() === '2026-11-10,2026-11-11' && after.wake_status === 'CONFIRMED' && iso(after.wake_confirmed_at) === '2026-11-11T05:05:00.000Z' ? true : { sig, n1, recs1, night, morning, miss, n2, recs2, after };
  });

  await check('7-21(기상한 날 경계): 확인이 붙은 알람의 앞 6시간 · 뒤 18시간 안이면 알람이 울린 날, 밖이면 확인한 날 — 구간 밖의 옛 확인이 붙어 있어도 하루 한 건이 어긋나지 않음', async () => {
    const U = await join_(64, '뒤', 'UTC'), V = await join_(65, '앞', 'UTC');
    const x1 = await wakeAlarm(U, '2026-11-10T06:00:00Z');
    await ev(x1, U, 'WAKE_CONFIRMED', '2026-11-11T03:00:00Z', { src: 'BUTTON' });   // 알람 21시간 뒤(구간 밖) → 확인한 날 11/11
    await ev(x1, U, 'WAKE_CONFIRMED', '2026-11-10T06:30:00Z', { src: 'BUTTON' });   // 알람이 울린 날 11/10 → 따로 저장
    const x2 = await wakeAlarm(V, '2026-11-12T02:00:00Z');
    await ev(x2, V, 'WAKE_CONFIRMED', '2026-11-11T19:30:00Z', { src: 'BUTTON' });   // 알람 6시간 30분 앞(구간 밖) → 확인한 날 11/11
    await ev(x2, V, 'WAKE_CONFIRMED', '2026-11-12T02:10:00Z', { src: 'BUTTON' });   // 알람이 울린 날 11/12 → 따로 저장
    return (await eventCount(U, 'WAKE_CONFIRMED')) === 2 && (await eventCount(V, 'WAKE_CONFIRMED')) === 2 ? true : { u: await eventCount(U, 'WAKE_CONFIRMED'), v: await eventCount(V, 'WAKE_CONFIRMED') };
  });

  await check('7-21(알람 종류): 기상 알람이 아닌 알람(출발 알람)에 붙은 기상 확인은 그 알람 시각이 아니라 확인한 날로 셈 — 하루 기록 날짜가 확인한 날', async () => {
    const U = await join_(84, '출발알람', 'UTC');
    const dep = (await q(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'DEPARTURE', $2::timestamptz) returning alarm_id`, [U, '2026-11-10T23:50:00Z']))[0].alarm_id;
    await ev(dep, U, 'WAKE_CONFIRMED', '2026-11-11T00:10:00Z', { src: 'BUTTON' });
    const rec = await q(`select record_date::text as d from public.daily_records where user_id = $1`, [U]);
    return rec.length === 1 && rec[0].d === '2026-11-11' ? true : rec;
  });

  await check('7-21 · 7-39(하루 기록): 기상 확인이 저장되면 그날 daily_records.wake_confirmed_at이 같이 기록됨 — 이미 있던 값은 안 덮고, 버려진 중복은 기록을 안 바꿈', async () => {
    const A = await join_(50, '에이'), B = await join_(51, '이미있음');
    const a = await wakeAlarm(A, at('07:00')), b = await wakeAlarm(B, at('07:00'));
    await q(`insert into public.daily_records (user_id, record_date, wake_confirmed_at) values ($1, $2::date, $3::timestamptz)`, [B, D, at('06:50')]);
    await ev(a, A, 'WAKE_CONFIRMED', at('07:10'), { src: 'BUTTON' });
    await ev(a, A, 'WAKE_CONFIRMED', at('07:30'), { src: 'USAGE' });
    await ev(b, B, 'WAKE_CONFIRMED', at('07:15'), { src: 'BUTTON' });
    const ra = await q(`select wake_confirmed_at, data_source::text as src from public.daily_records where user_id = $1`, [A]);
    const rb = await q(`select wake_confirmed_at from public.daily_records where user_id = $1`, [B]);
    return ra.length === 1 && iso(ra[0].wake_confirmed_at) === iso(at('07:10')) && ra[0].src === 'ALARM' && rb.length === 1 && iso(rb[0].wake_confirmed_at) === iso(at('06:50')) ? true : { ra, rb };
  });

  // ---- 새로 고침 신호 ------------------------------------------------------------------------------

  await check('7-16 · 7-28 · 7-29: 기상 기록이 들어오면 동의한 사람의 약속 있는 그룹 채널에만 새로 고침 신호(날짜뿐) — 동의 안 한 사람 · 약속 없는 그룹 · 친구 관계만 있는 사람은 신호 없음', async () => {
    const A = await join_(52, '에이'), B = await join_(53, '동의'), C = await join_(54, '동의안함'), F = await join_(55, '친구만');
    const g = await mkGroup(A, [B, C], [B]), noMeeting = await mkGroup(B, [], [B]);
    await befriend(A, F);
    await appt(A, g, at('10:00'));
    const ba = await wakeAlarm(B, at('07:00')), ca = await wakeAlarm(C, at('07:00')), fa = await wakeAlarm(F, at('07:00'));
    await clearSignals();
    await ev(ba, B, 'WAKE_CONFIRMED', at('07:10'), { src: 'BUTTON' });
    const sent = await signals();
    await clearSignals();
    await ev(ca, C, 'WAKE_CONFIRMED', at('07:10'), { src: 'BUTTON' });
    await ev(fa, F, 'WAKE_CONFIRMED', at('07:10'), { src: 'BUTTON' });
    const none = await signals();
    return sent.length === 1 && sent[0].topic === `group:${g}:wake` && sent[0].event === 'refresh' && JSON.stringify(sent[0].payload) === JSON.stringify({ date: D })
      && !sent.some((x) => x.topic === `group:${noMeeting}:wake`) && none.length === 0 ? true : { sent, none };
  });

  await check('7장 신호(출처): 직접 입력 · 대화 정정 · 자동 판정(폰 사용)이 만든 기상 확인은 신호를 안 냄 — 버튼 · 위치 · 출처 없음은 보냄, 새벽 약속의 신호 날짜는 알람이 울린 날', async () => {
    const A = await join_(56, '에이'), B = await join_(57, '비');
    const g = await mkGroup(A, [B], [B]);
    await appt(A, g, at('10:00')); await appt(A, g, at('00:30', '2026-11-11'));
    const days = [['MANUAL', '2026-11-09'], ['VOICE', '2026-11-08'], ['USAGE', '2026-11-07'], ['BUTTON', D], ['LOCATION', '2026-11-06'], [null, '2026-11-05']];
    const counts = {};
    for (const [src, day] of days) {
      const al = await wakeAlarm(B, at('07:00', day));
      await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '그날', $3::timestamptz, '학교')`, [A, g, at('10:00', day)]);
      await clearSignals();
      await ev(al, B, 'WAKE_CONFIRMED', at('07:10', day), { src });
      counts[src ?? 'none'] = (await signals()).length;
    }
    const lateAppt = await appt(A, g, at('00:30', '2026-11-05'), '새벽');
    const [{ participant_id: latePt }] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [lateAppt, B]);
    const late = (await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3::timestamptz) returning alarm_id`, [latePt, B, at('23:00', '2026-11-04')]))[0].alarm_id;
    await clearSignals();
    await ev(late, B, 'WAKE_CONFIRMED', at('23:05', '2026-11-04'), { src: 'BUTTON' });
    const lateSig = await signals();
    return counts.MANUAL === 0 && counts.VOICE === 0 && counts.USAGE === 0 && counts.BUTTON === 1 && counts.LOCATION === 1 && counts.none === 1
      && lateSig.length === 1 && JSON.stringify(lateSig[0].payload) === JSON.stringify({ date: '2026-11-04' }) ? true : { counts, lateSig };
  });

  // ---- 공개 함수 · 권한 ----------------------------------------------------------------------------

  await check('7장 공개 함수: 앱은 get_group_wake · get_group_wake_status를 부르고 로그인이 없으면 빈 결과, anon은 거절 — 판정 본문 private.group_wake_rows · can_see_wake는 앱이 직접 못 부름(아무 사람 시점으로 부르지 못하게)', async () => {
    const A = await join_(58, '에이'), B = await join_(59, '비');
    const g = await mkGroup(A, [B], [A, B]);
    await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '지금', now(), '학교')`, [A, g]);
    await wakeAlarm(B, new Date(Date.now() + 3_600_000).toISOString());
    await as(A);
    const mine = await q(`select * from public.get_group_wake($1)`, [g]);
    const old = await q(`select * from public.get_group_wake_status($1)`, [g]);
    await as(null);
    const noLogin = await q(`select * from public.get_group_wake($1)`, [g]);
    await as(null, 'anon');
    const anon = await expectErr(() => q(`select * from public.get_group_wake($1)`, [g]), /permission denied/);
    await as(A);
    const priv = [await expectErr(() => q(`select * from private.group_wake_rows($1, $2, null, now())`, [B, g]), /permission denied/),
                  await expectErr(() => q(`select private.can_see_wake($1, $2, $3)`, [A, B, g]), /permission denied/)];
    await su();
    return mine.length === 2 && old.length === 2 && noLogin.length === 0 && anon === true && priv.every((x) => x === true) ? true : { mine, old, noLogin, anon, priv };
  });

  await check('7장 판정 한 곳: private.can_see_wake(보는 사람, 주인, 그룹) — 둘 다 참여 중 + 주인의 동의 + 차단 아님 + 숨김 아님일 때만 true(서버 역할이 부를 수 있음)', async () => {
    const A = await join_(60, '보는이'), B = await join_(61, '주인'), C = await join_(62, '동의안함');
    const g = await mkGroup(A, [B, C], [B]);
    const ask = async (v, o) => { await svc(); const r = (await q(`select private.can_see_wake($1, $2, $3) as ok`, [v, o, g]))[0].ok; await su(); return r; };
    const I = await join_(82, '초대'), L = await join_(83, '나감');
    await q(`insert into public.group_members (group_id, user_id, invite_status, wake_share_opt_in) values ($1, $2, 'INVITED', true), ($1, $3, 'INVITED', true)`, [g, I, L]);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, L]);
    const base = await ask(A, B);
    const noOptIn = await ask(A, C);
    const notJoined = [await ask(I, B), await ask(L, B), await ask(A, I), await ask(A, L)];       // 동의가 남아 있어도 참여 중이 아니면 아님
    await hide(B, A);
    const hidden = await ask(A, B);
    await hide(B, A, false);
    await call(A, 'public.block_user($1)', [B]);
    const blocked = await ask(A, B);
    return base === true && noOptIn === false && notJoined.every((x) => x === false) && hidden === false && blocked === false && (await ask(NOBODY, B)) === false && (await ask(A, NOBODY)) === false ? true : { base, noOptIn, notJoined, hidden, blocked };
  });

  // ---- 7-날짜 제한: 기상 조회는 어제 · 오늘 · 내일만 (이슈 #431) ----------------------------------------

  await check('7장 날짜 제한: 기상 조회(get_group_wake · get_group_wake_status)는 호출자 시간대의 어제 · 오늘 · 내일만 — 그 밖의 날짜는 그날 약속이 있어도 줄이 없고, 날짜를 안 주면 오늘, 비공개 계산은 제한 없이 같은 날을 읽음', async () => {
    const dayIn = (tz, n) => new Date(Date.now() + n * 86400_000).toLocaleDateString('en-CA', { timeZone: tz });
    const offsetOf = { 'Pacific/Kiritimati': '+14:00', 'Pacific/Pago_Pago': '-11:00' };      // UTC · 서울과 날짜가 같아지는 시각이 없도록 가장 먼 두 시간대(하루 중 어느 때 돌려도 시간대 계산 변이를 잡음)
    const run = async (tz, base) => {
      const V = await join_(base, `보는이-${tz}`), O = await join_(base + 1, `상대-${tz}`);
      await q(`update public.profiles set timezone = $2 where user_id = $1`, [V, tz]);
      await q(`update public.profiles set timezone = $2 where user_id = $1`, [O, tz]);
      const g = await mkGroup(V, [O], [V, O]);
      for (const n of [-3, -2, -1, 0, 1, 2, 3]) await appt(V, g, at('10:00', dayIn(tz, n), offsetOf[tz]));
      const out = {};
      for (const n of [-3, -2, -1, 0, 1, 2, 3]) {
        const d = dayIn(tz, n);
        await as(V);
        const narrow = await q(`select 1 from public.get_group_wake($1, $2::date)`, [g, d]);
        const old = await q(`select 1 from public.get_group_wake_status($1, $2::date)`, [g, d]);
        await su();
        const internal = await rows(V, g, d);
        out[n] = { narrow: narrow.length, old: old.length, internal: internal.length };
      }
      await as(V);
      const none = await q(`select 1 from public.get_group_wake($1, null)`, [g]);
      const noneOld = await q(`select 1 from public.get_group_wake_status($1)`, [g]);
      const inf = [await q(`select 1 from public.get_group_wake($1, 'infinity'::date)`, [g]), await q(`select 1 from public.get_group_wake_status($1, '-infinity'::date)`, [g])];   // 오류 없이 0행
      await su();
      return { out, none: none.length, noneOld: noneOld.length, inf: inf.map((x) => x.length) };
    };
    const seoul = await run('Pacific/Kiritimati', 400), honolulu = await run('Pacific/Pago_Pago', 410);
    const ok = (r) => [-1, 0, 1].every((n) => r.out[n].narrow >= 1 && r.out[n].old >= 1)
      && [-3, -2, 2, 3].every((n) => r.out[n].narrow === 0 && r.out[n].old === 0)
      && [-3, -2, -1, 0, 1, 2, 3].every((n) => r.out[n].internal >= 1)       // 그날 데이터는 있음 — 막은 것은 날짜 범위뿐
      && r.none >= 1 && r.noneOld >= 1 && r.inf[0] === 0 && r.inf[1] === 0;
    return ok(seoul) && ok(honolulu) ? true : { seoul, honolulu };
  });

  // ---- 탐색 시험 X-WAKE-04: 알람이 울린 뒤 알람만 끈 사람 --------------------------------------------

  await check('X-WAKE-04(조회): 알람이 울린 뒤 알람만 끄고 기상 확인이 없어도 그룹 기상 조회에 줄이 남음 — 울림 직후 DISMISSED, 30분 뒤 MISSED(미확인). 울리기 전에 꺼 둔 알람은 그대로 NO_ALARM', async () => {
    const A = await join_(90, '에이'), B = await join_(91, '끈이'), C = await join_(92, '미리끈이');
    const g = await mkGroup(A, [B, C], [B, C]);
    await appt(A, g, at('10:00'));
    const bAl = await wakeAlarm(B, at('07:00'));
    await ev(bAl, B, 'TRIGGERED', at('07:00')); await ev(bAl, B, 'DISMISSED', at('07:03'));
    await q(`update public.alarms set is_enabled = false where alarm_id = $1`, [bAl]);     // 울린 뒤 알람을 끔 — 기상 확인은 없음
    await wakeAlarm(C, at('07:00'), { enabled: false });                                     // 울리기 전에 꺼 둔 알람
    const soon = await rows(A, g, D, at('07:10')), late = await rows(A, g, D, at('07:40'));
    return JSON.stringify(who(soon)) === JSON.stringify(sorted(A, B, C)) && of(soon, B).wake_status === 'DISMISSED' && iso(of(soon, B).wake_alarm_at) === iso(at('07:00')) && of(soon, C).wake_status === 'NO_ALARM'
      && of(late, B).wake_status === 'MISSED' && iso(of(late, B).missed_at) === iso(at('07:30')) && of(late, C).wake_status === 'NO_ALARM' ? true : { soon, late };
  });

  await check('X-WAKE-04(새벽 약속): 약속이 다음 날 00:30이고 그 전날 기상 알람이 울린 뒤 꺼졌어도 전날 그룹 기상 조회가 비지 않고 그 사람 줄이 남음 — 울리기 전에 끈 알람이면 전날은 약속 없는 날(0행)', async () => {
    const A = await join_(93, '에이'), B = await join_(94, '끈이'), A2 = await join_(95, '에이2'), C = await join_(96, '미리끈이');
    const g = await mkGroup(A, [B], [B]), g2 = await mkGroup(A2, [C], [C]);
    const addAlarm = async (ap, u) => {
      const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, u]);
      return (await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3::timestamptz) returning alarm_id`, [pt.participant_id, u, at('23:00')]))[0].alarm_id;
    };
    const bAl = await addAlarm(await appt(A, g, at('00:30', '2026-11-11')), B);                // 참여자는 B 하나 — 보는 사람 A는 알람 없음
    await ev(bAl, B, 'TRIGGERED', at('23:00')); await ev(bAl, B, 'DISMISSED', at('23:03'));
    await q(`update public.alarms set is_enabled = false where alarm_id = $1`, [bAl]);
    const cAl = await addAlarm(await appt(A2, g2, at('00:30', '2026-11-11')), C);
    await q(`update public.alarms set is_enabled = false where alarm_id = $1`, [cAl]);          // 울리기 전에 꺼 둠
    const eve = await rows(A, g, D, at('23:10')), eveOff = await rows(A2, g2, D, at('23:10'));
    return JSON.stringify(who(eve)) === JSON.stringify(sorted(A, B)) && of(eve, B).wake_status === 'DISMISSED' && iso(of(eve, B).wake_alarm_at) === iso(at('23:00')) && eveOff.length === 0 ? true : { eve, eveOff };
  });

  await check('X-WAKE-04(미확인 후보): 울린 뒤 알람만 끈 알람도 30분이 지나면 find_missed_wake_alarms에 나옴(미확인 시각 = 울림 + 30분) — 울리기 전에 꺼 둔 알람은 안 나옴', async () => {
    const U = await join_(97, '끈이'), V = await join_(98, '미리끈이');
    const a1 = await wakeAlarm(U, at('06:00'));
    await ev(a1, U, 'TRIGGERED', at('06:00')); await ev(a1, U, 'DISMISSED', at('06:02'));
    await q(`update public.alarms set is_enabled = false where alarm_id = $1`, [a1]);
    const a2 = await wakeAlarm(V, at('06:00'), { enabled: false });
    await svc();
    const r = await q(`select * from public.find_missed_wake_alarms($1::timestamptz, 24)`, [at('23:00')]);
    await su();
    const got = r.find((x) => x.alarm_id === a1);
    return got && iso(got.missed_at) === iso(at('06:30')) && !r.some((x) => x.alarm_id === a2) ? true : { r };
  });
}
