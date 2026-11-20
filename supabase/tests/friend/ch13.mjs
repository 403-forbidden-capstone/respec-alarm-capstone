// 친구 13장 — 개인정보 · 동의 (친구_시험케이스.md 13장 DB 층, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호
//   이 장 DB에 없는 것: 13-10 · 13-12 · 13-13 · 13-17 ~ 13-20 · 13-22 · 13-23(앱 화면 · 저장본 · 동의 시트), 13-21(출발 · 도착이 안 보이는지 — 아래 빈 곳)
//   빈 곳(13-21): 알람 조회 권한을 받은 친구는 DB에서 그 약속에 붙은 알람을 종류 구분 없이 읽음(RLS `alarms_select_shared`는 알람 종류를 안 거름) —
//     출발 · 도착(위치로 잡은 것)을 가리는 곳은 지금 앱 화면뿐. 이 시험은 그 동작을 '맞다'고 못 박지 않으려고 13-21을 DB 시험에 안 넣음
//   13-24(7일 보관): 제한 · 코드 실패 기록 · 깨우기 발송 기록 · 푸시 영수증은 7일 뒤 지우고 기상 기록은 남김
//   사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch13({ q, as, su, svc, check, expectErr }) {
  const id = (n) => `bd000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const FUTURE = '2099-03-01';
  const TODAY_KST = () => new Date(Date.now() + 9 * 3600_000 - 4 * 3600_000).toISOString().slice(0, 10);       // (새벽 4시 기준일) 기상 조회는 어제~내일만 받으므로(이슈 #431) 그룹 기상을 보는 시험은 오늘(한국)로
  const at = (hhmm, day = FUTURE) => `${day}T${hhmm}:00+09:00`;

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f13-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f13_user_${n}`]);
    return id(n);
  };
  const call = async (uid, sql, params = []) => { await as(uid); const [r] = await q(`select ${sql} as r`, params); await su(); return r.r; };
  const clearLimits = (...uids) => q(`delete from public.rate_limit_events where user_id = any($1::uuid[])`, [uids]);
  const befriend = async (a, b) => {
    await call(a, 'public.send_friend_request($1)', [b]);
    await call(b, 'public.accept_friend_request($1)', [a]);
    await clearLimits(a, b);
  };
  const friendId = async (a, b) => (await q(`select friend_id from public.friends
                                             where least(requester_id, addressee_id) = least($1::uuid, $2::uuid)
                                               and greatest(requester_id, addressee_id) = greatest($1::uuid, $2::uuid)`, [a, b]))[0]?.friend_id ?? null;
  const viewGrant = async (owner, grantee) => {
    const f = await friendId(owner, grantee);
    await as(owner);
    const [r] = await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm)
                         values ($1, $2, 'FRIEND', $3, true) returning permission_id`, [owner, grantee, f]);
    await su();
    return r.permission_id;
  };
  const mkGroup = async (owner, others = []) => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('개인정보그룹', $1) returning group_id`, [owner]);
    await su();
    for (const u of others) await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now())`, [g.group_id, u]);
    return g.group_id;
  };
  // 개인 약속 + 참여 + 기상 알람 하나 (메모 · 출발지 칸은 채워 둠)
  const personalAlarm = async (u) => {
    const [ap] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name, memo)
                          values ($1, null, '비밀 약속', now() + interval '10 hours', '학교', '비공개 메모') returning appointment_id`, [u]);
    const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id, origin_name)
                          values ($1, $2, '우리 집') returning participant_id`, [ap.appointment_id, u]);
    const [al] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', now() + interval '8 hours') returning alarm_id`, [pt.participant_id, u]);
    return { appointment: ap.appointment_id, participant: pt.participant_id, alarm: al.alarm_id };
  };
  // 그룹 약속 + 그 사람 참여 + 기상 알람 (그날 그룹 기상 목록에 나오게)
  const groupWake = async (u, g, day = FUTURE) => {
    const [ap] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name)
                          values ($1, $2, '그룹 약속', $3::timestamptz, '학교') returning appointment_id`, [u, g, at('10:00', day)]);
    const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap.appointment_id, u]);
    await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3::timestamptz)`, [pt.participant_id, u, at('07:00', day)]);
  };
  const count = async (sql, params = []) => (await q(`select count(*)::int as n from (${sql}) t`, params))[0].n;
  const readAs = async (uid, sql, params = []) => { await as(uid); const r = await q(sql, params); await su(); return r; };

  // ---- 13-01 ~ 13-04: 직접 읽기 · 로그아웃 ---------------------------------------------------

  await check('13-01 · 13-03: 친구여도 상대 프로필을 직접 읽지 못하고(본인만), 남이 내 친구 · 그룹 · 멤버 표를 직접 select 해도 내 줄이 안 나옴', async () => {
    const A = await join_(1, '주인'), B = await join_(2, '친구'), D = await join_(3, '남');
    await befriend(A, B);
    const g = await mkGroup(A, [B]);
    await viewGrant(A, B);                                                                // 내가 친구에게 준 권한 행이 있어도 남에게는 안 보임
    const profile = await readAs(B, `select user_id from public.profiles where user_id = $1`, [A]);
    const own = await readAs(B, `select user_id from public.profiles where user_id = $1`, [B]);
    const friendsSeenByStranger = await readAs(D, `select 1 from public.friends where requester_id = $1 or addressee_id = $1`, [A]);
    const groupsSeenByStranger = await readAs(D, `select 1 from public.groups where group_id = $1`, [g]);
    const membersSeenByStranger = await readAs(D, `select 1 from public.group_members where group_id = $1`, [g]);
    const permsSeenByStranger = await readAs(D, `select 1 from public.sharing_permissions where owner_id = $1`, [A]);
    return profile.length === 0 && own.length === 1 && friendsSeenByStranger.length === 0 && groupsSeenByStranger.length === 0
      && membersSeenByStranger.length === 0 && permsSeenByStranger.length === 0 ? true : { profile, own, friendsSeenByStranger, groupsSeenByStranger, membersSeenByStranger, permsSeenByStranger };
  });

  await check('13-04: 로그아웃(익명) 상태에서는 소셜 함수를 하나도 못 부름(permission denied)', async () => {
    const A = await join_(4, '주인');
    const calls = [
      `select * from public.search_by_handle('f13_user_4')`,
      `select * from public.get_public_profiles()`,
      `select * from public.get_group_wake('${A}')`,
      `select * from public.my_account_delete_summary()`,
      `select * from public.my_alarm_proposals()`,
      `select * from public.get_shared_alarm_appointments()`,
      `select public.prepare_account_delete('${A}')`,
    ];
    await as(null, 'anon');
    const results = [];
    for (const sql of calls) results.push(await expectErr(() => q(sql), /permission denied/));
    await su();
    return results.every((x) => x === true) ? true : { results };
  });

  // ---- 13-02: 공개 프로필 ---------------------------------------------------------------------

  await check('13-02: 친구 · 그룹원의 공개 프로필은 아이디 · 닉네임 · 사진만 — 이메일 · 시간대 · 동의 시각 같은 칸은 응답에 없음', async () => {
    const A = await join_(5, '주인'), B = await join_(6, '친구');
    await befriend(A, B);
    const rows = await readAs(B, `select * from public.get_public_profiles(array[$1::uuid])`, [A]);
    const keys = rows[0] ? Object.keys(rows[0]).sort() : [];
    return rows.length === 1 && JSON.stringify(keys) === JSON.stringify(['handle', 'nickname', 'profile_image_url', 'user_id'])
      && rows[0].nickname === '주인' && rows[0].handle === 'f13_user_5' ? true : { rows, keys };
  });

  // ---- 13-05 ~ 13-08: 읽을 수 없는 것 -----------------------------------------------------------

  await check('13-05 · 13-06 · 13-07 · 13-08: 알람을 못 보는 친구는 알람 · 약속 · 참여 조건 · 수면 기록이 0행이고, 알람 조회를 받은 친구도 약속 메모 · 출발지 · 수면 기록은 못 읽으며 제목 · 장소 · 시각만 받음', async () => {
    const A = await join_(7, '주인'), B = await join_(8, '기상만'), C = await join_(9, '알람조회');
    await befriend(A, B); await befriend(A, C);
    const g = await mkGroup(A, [B]);                                            // B는 같은 그룹이라 기상은 볼 수 있어도 알람은 못 읽음
    await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [g, A]);
    const { appointment, alarm } = await personalAlarm(A);
    await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values ($1, $2, 'SNOOZED', now()), ($1, $2, 'DISMISSED', now())`, [alarm, A]);   // 미루기 · 해제 기록
    await q(`update public.appointment_participants set departed_at = now() - interval '1 hour', arrived_at = now() where appointment_id = $1 and user_id = $2`, [appointment, A]);   // 위치로 잡은 실제 출발 · 도착
    await q(`insert into public.daily_records (user_id, record_date, sleep_at, sleep_satisfaction) values ($1, current_date - 1, now() - interval '1 day', 3)`, [A]);
    await viewGrant(A, C);
    const wakeOnly = {
      alarms: (await readAs(B, `select 1 from public.alarms where user_id = $1`, [A])).length,
      appointments: (await readAs(B, `select 1 from public.appointments where appointment_id = $1`, [appointment])).length,
      participants: (await readAs(B, `select 1 from public.appointment_participants where user_id = $1`, [A])).length,
      daily: (await readAs(B, `select 1 from public.daily_records where user_id = $1`, [A])).length,
      events: (await readAs(B, `select 1 from public.alarm_events where user_id = $1`, [A])).length,
      shared: (await readAs(B, `select 1 from public.get_shared_alarm_appointments($1)`, [A])).length,
    };
    const alarmView = {
      alarms: (await readAs(C, `select alarm_id from public.alarms where user_id = $1`, [A])).map((x) => x.alarm_id),
      appointments: (await readAs(C, `select 1 from public.appointments where appointment_id = $1`, [appointment])).length,   // 개인 약속은 직접 select 0행(RLS)
      participants: (await readAs(C, `select 1 from public.appointment_participants where user_id = $1`, [A])).length,       // 출발지 등 참여 조건
      daily: (await readAs(C, `select 1 from public.daily_records where user_id = $1`, [A])).length,
      events: (await readAs(C, `select 1 from public.alarm_events where user_id = $1`, [A])).length,          // 미루기 · 해제 기록 (13-자)
      located: (await readAs(C, `select departed_at, arrived_at from public.appointment_participants where user_id = $1`, [A])).length,   // 위치로 잡은 실제 출발 · 도착 (13-나 · 13-21 DB 절반)
      shared: await readAs(C, `select * from public.get_shared_alarm_appointments($1)`, [A]),
    };
    const sharedKeys = alarmView.shared[0] ? Object.keys(alarmView.shared[0]).sort() : [];
    return wakeOnly.alarms === 0 && wakeOnly.appointments === 0 && wakeOnly.participants === 0 && wakeOnly.daily === 0 && wakeOnly.events === 0 && wakeOnly.shared === 0
      && alarmView.alarms.length === 1 && alarmView.alarms[0] === alarm && alarmView.appointments === 0 && alarmView.participants === 0 && alarmView.daily === 0 && alarmView.events === 0 && alarmView.located === 0
      && alarmView.shared.length === 1 && alarmView.shared[0].title === '비밀 약속' && alarmView.shared[0].dest_name === '학교'
      && JSON.stringify(sharedKeys) === JSON.stringify(['alarm_id', 'appointment_at', 'appointment_id', 'dest_name', 'title', 'user_id'])
      ? true : { wakeOnly, alarmView, sharedKeys };
  });

  // ---- 13-09: 그룹 기상 응답 ---------------------------------------------------------------------

  await check('13-09: 그룹 기상 응답은 보일 값(단계 · 알람 시각 · 확인 시각 · 출발 · 도착 · 준비 알람 · 준비 시작 시각)만 — 미루기 횟수 · 해제 시각 · 장소 · 출처 칸이 없음', async () => {
    const A = await join_(10, '주인'), B = await join_(11, '그룹원');
    const g = await mkGroup(A, [B]);
    await q(`update public.group_members set wake_share_opt_in = true where group_id = $1`, [g]);
    const today = TODAY_KST();
    await groupWake(A, g, today);
    const rows = await readAs(B, `select * from public.get_group_wake($1, $2::date)`, [g, today]);
    const keys = rows[0] ? Object.keys(rows[0]).sort() : [];
    return rows.length >= 1 && JSON.stringify(keys) === JSON.stringify(['arrived_at', 'departed_at', 'is_me', 'nickname', 'prepare_alarm_at', 'prepare_started_at', 'profile_image_url', 'trip_appointment_at', 'trip_visible', 'user_id', 'wake_alarm_at', 'wake_confirmed_at', 'wake_status'])
      ? true : { keys, rows };
  });

  // ---- 13-11 · 13-14 · 13-15 · 13-16: 끄기 · 동의 기록 · 열람 기록 ----------------------------------------

  await check('13-11 · 13-15: 기상 공유를 끄는 순간 그룹원 화면에서 내 기상이 사라지고, 모든 공유를 끄면(알람 조회 권한 삭제 + 기상 공유 끔) 상대가 읽을 수 있는 것이 하나도 없음', async () => {
    const A = await join_(12, '주인'), B = await join_(13, '친구이자그룹원');
    await befriend(A, B);
    const g = await mkGroup(A, [B]);
    await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [g, A]);
    const { alarm } = await personalAlarm(A);
    const today = TODAY_KST();
    await groupWake(A, g, today);
    const perm = await viewGrant(A, B);
    const visible = async () => ({
      wake: (await readAs(B, `select 1 from public.get_group_wake($1, $2::date) where not is_me and wake_alarm_at is not null`, [g, today])).length,
      alarms: (await readAs(B, `select 1 from public.alarms where alarm_id = $1`, [alarm])).length,
      shared: (await readAs(B, `select 1 from public.get_shared_alarm_appointments($1)`, [A])).length,
    });
    const before = await visible();
    await as(A); await q(`update public.group_members set wake_share_opt_in = false where group_id = $1 and user_id = $2`, [g, A]); await su();
    const wakeOff = await visible();
    await as(A); await q(`delete from public.sharing_permissions where permission_id = $1`, [perm]); await su();
    const allOff = await visible();
    return before.wake === 1 && before.alarms === 1 && before.shared === 2        // 알람 조회 권한으로 개인 약속 + 그룹 약속 둘이 G04에 나옴
      && wakeOff.wake === 0 && wakeOff.alarms === 1 && wakeOff.shared === 2
      && allOff.wake === 0 && allOff.alarms === 0 && allOff.shared === 0 ? true : { before, wakeOff, allOff };
  });

  await check('13-14(DB): 개인정보 동의는 시각과 판 번호가 같이 기록되고(하나만은 안 됨), 공유 스위치는 켬 · 끔 두 칸(기상 · 출발 도착)뿐 — 따로 동의 시각이 쌓이지 않음', async () => {
    const A = await join_(14, '동의');
    await as(A);
    await q(`update public.profiles set privacy_agreed_at = now(), privacy_version = 1 where user_id = $1`, [A]);
    const half = await expectErr(() => q(`update public.profiles set privacy_version = null where user_id = $1`, [A]), /profiles_privacy_agreed_pair|check constraint/);
    await q(`update public.profiles set privacy_version = 2 where user_id = $1`, [A]);                    // 판이 올라간 동의 — 앱이 다시 받아 같은 두 칸을 갱신
    await su();
    const [p] = await q(`select privacy_agreed_at is not null as agreed, privacy_version from public.profiles where user_id = $1`, [A]);
    const cols = (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'group_members'`)).map((x) => x.column_name);
    const shareCols = cols.filter((c) => /share|consent|agree/.test(c));
    return half === true && p.agreed === true && p.privacy_version === 2 && JSON.stringify([...shareCols].sort()) === JSON.stringify(['trip_share_opt_in', 'wake_share_opt_in']) ? true : { half, p, shareCols };
  });

  await check('13-16: 친구가 내 알람 · 기상을 읽어도 아무것도 기록되지 않음 — 읽기 전후로 어느 표의 줄 수도 안 변하고, 열람 기록 표 자체가 없음', async () => {
    const A = await join_(15, '주인'), B = await join_(16, '보는이');
    await befriend(A, B);
    const g = await mkGroup(A, [B]);
    await q(`update public.group_members set wake_share_opt_in = true where group_id = $1`, [g]);
    await personalAlarm(A);
    await viewGrant(A, B);
    const tables = (await q(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`)).map((x) => x.table_name);
    const snapshot = async () => {
      const out = {};
      for (const t of tables) out[t] = await count(`select 1 from public.${t}`);
      return out;
    };
    const before = await snapshot();
    await readAs(B, `select * from public.alarms where user_id = $1`, [A]);
    await readAs(B, `select * from public.get_shared_alarm_appointments($1)`, [A]);
    await readAs(B, `select * from public.get_group_wake($1)`, [g]);
    await readAs(B, `select * from public.get_public_profiles()`);
    const after = await snapshot();
    const changed = tables.filter((t) => before[t] !== after[t]);
    const logTables = tables.filter((t) => /view|viewed|access|audit|read_log|history/.test(t));
    return changed.length === 0 && logTables.length === 0 ? true : { changed, logTables };
  });

  // ---- 13-24: 서버 기록 7일 보관 ---------------------------------------------------------------------

  await check('13-24: 매일 배치가 7일 지난 제한 · 코드 실패 기록 · 깨우기 발송 기록 · 푸시 영수증 · 끝난 알람 제안만 지우고(6일 된 것 · 아직 대기 중인 제안 · 기상 기록은 남김), 몇 번 불러도 같고, 앱 · 서버 역할은 못 부름', async () => {
    const A = await join_(17, '기록'), B = await join_(18, '상대');
    const old = `now() - interval '7 days' - interval '1 hour'`, fresh = `now() - interval '6 days'`;
    for (const action of ['HANDLE_SEARCH', 'FRIEND_REQUEST', 'GROUP_CODE_FAIL']) {
      await q(`insert into public.rate_limit_events (user_id, action, created_at) values ($1, $2, ${old}), ($1, $2, ${fresh})`, [A, action]);
    }
    await q(`insert into public.push_sends (kind, sender_id, target_id, sent_at) values ('WAKE_PING', $1, $2, ${old}), ('WAKE_PING', $1, $2, ${fresh})`, [A, B]);
    await q(`insert into public.push_sends (kind, target_id, subject_id, day, sent_at) values ('NUDGE', $2, $1, current_date - 20, ${old}), ('NUDGE', $2, $1, current_date - 1, ${fresh}), ('UP', $2, $1, current_date - 20, ${old}), ('UP', $2, $1, current_date - 1, ${fresh})`, [A, B]);   // 미확인 알림 · 후속 중복 방지 줄
    await q(`insert into public.push_tickets (ticket_id, user_id, token, kind, created_at) values ('old-ticket', $1, 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', 'WAKE_PING', ${old}), ('fresh-ticket', $1, 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', 'WAKE_PING', ${fresh})`, [A]);
    await q(`insert into public.daily_records (user_id, record_date, wake_confirmed_at) values ($1, current_date - 40, now() - interval '40 days')`, [A]);
    // 알람 제안: 7일 지난 끝난 것(적용) · 7일 지난 대기(알람 시각이 한참 지남) → 삭제, 6일 된 끝난 것(무시) · 오래됐지만 알람이 아직 안 지난 대기 → 유지
    const oldApplied = await personalAlarm(A), oldPending = await personalAlarm(A), freshDismissed = await personalAlarm(A), livePending = await personalAlarm(A);
    const farApplied = await personalAlarm(A), farRecent = await personalAlarm(A);     // 알람이 아직 먼 미래인 끝난 제안: 응답 8일 전 적용 → 남음(보낸 친구의 '반영됨' 근거), 만든 지 9일 됐지만 응답이 1시간 전 → 남음
    const proposal = (alarmId, status, createdAgo, respondedAgo, fromAgoDays) => q(
      `insert into public.alarm_proposals (alarm_id, owner_id, proposer_id, from_at, to_at, status, created_at, responded_at)
       values ($1, $2, $3, now() - interval '${fromAgoDays} days', now() - interval '${fromAgoDays} days' - interval '10 minutes', $4, now() - interval '${createdAgo}', ${respondedAgo ? `now() - interval '${respondedAgo}'` : 'null'})`,
      [alarmId, A, B, status]);
    await proposal(oldApplied.alarm, 'APPLIED', '8 days', '8 days', 8);
    await proposal(oldPending.alarm, 'PENDING', '9 days', null, 8);
    await proposal(freshDismissed.alarm, 'DISMISSED', '6 days', '6 days', 6);
    await q(`insert into public.alarm_proposals (alarm_id, owner_id, proposer_id, from_at, to_at, status, created_at) values ($1, $2, $3, now() + interval '5 hours', now() + interval '4 hours', 'PENDING', now() - interval '9 days')`, [livePending.alarm, A, B]);
    await q(`insert into public.alarm_proposals (alarm_id, owner_id, proposer_id, from_at, to_at, status, created_at, responded_at) values ($1, $2, $3, now() + interval '30 days', now() + interval '30 days' - interval '10 minutes', 'APPLIED', now() - interval '8 days', now() - interval '8 days')`, [farApplied.alarm, A, B]);
    await q(`insert into public.alarm_proposals (alarm_id, owner_id, proposer_id, from_at, to_at, status, created_at, responded_at) values ($1, $2, $3, now() - interval '9 days', now() - interval '9 days' - interval '10 minutes', 'DISMISSED', now() - interval '9 days', now() - interval '1 hour')`, [farRecent.alarm, A, B]);
    const before = {
      limits: await count(`select 1 from public.rate_limit_events where user_id = $1`, [A]),
      sends: await count(`select 1 from public.push_sends where sender_id = $1 or subject_id = $1`, [A]),
      tickets: await count(`select 1 from public.push_tickets where user_id = $1`, [A]),
      proposals: await count(`select 1 from public.alarm_proposals where owner_id = $1`, [A]),
    };
    const [r1] = await q(`select * from private.purge_old_friend_records()`);
    const [r2] = await q(`select * from private.purge_old_friend_records()`);
    const after = {
      limits: await count(`select 1 from public.rate_limit_events where user_id = $1`, [A]),
      freshLimits: await count(`select 1 from public.rate_limit_events where user_id = $1 and created_at > now() - interval '7 days'`, [A]),
      sends: await count(`select 1 from public.push_sends where sender_id = $1 or subject_id = $1`, [A]),
      tickets: (await q(`select ticket_id from public.push_tickets where user_id = $1`, [A])).map((x) => x.ticket_id),
      daily: await count(`select 1 from public.daily_records where user_id = $1`, [A]),
      proposals: (await q(`select alarm_id from public.alarm_proposals where owner_id = $1 order by alarm_id`, [A])).map((x) => x.alarm_id).sort(),
    };
    const keptProposals = [freshDismissed.alarm, livePending.alarm, farApplied.alarm, farRecent.alarm].sort();
    await as(A);
    const app = await expectErr(() => q(`select * from private.purge_old_friend_records()`), /permission denied/);
    await su(); await svc();
    const server = await expectErr(() => q(`select * from private.purge_old_friend_records()`), /permission denied/);
    await su();
    return before.limits === 6 && before.sends === 6 && before.tickets === 2 && before.proposals === 6
      && r1.rate_limit_deleted >= 3 && r1.push_sends_deleted >= 3 && r1.push_tickets_deleted >= 1 && r1.alarm_proposals_deleted >= 2
      && r2.rate_limit_deleted === 0 && r2.push_sends_deleted === 0 && r2.push_tickets_deleted === 0 && r2.alarm_proposals_deleted === 0
      && after.limits === 3 && after.freshLimits === 3 && after.sends === 3 && after.tickets.length === 1 && after.tickets[0] === 'fresh-ticket' && after.daily === 1
      && JSON.stringify(after.proposals) === JSON.stringify(keptProposals)
      && app === true && server === true ? true : { before, r1, r2, after, keptProposals, app, server };
  });
}
