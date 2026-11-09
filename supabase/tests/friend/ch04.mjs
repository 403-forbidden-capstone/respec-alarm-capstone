// 친구 4장 — 차단 · 신고 (친구_시험케이스.md 4장 DB 층 + 99-03, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호
//   이 장에 없는 것: 4-14~4-16 중 푸시 종류별 보내기(WAKE_PING · FRIEND_* 푸시는 8 · 11장 — 여기선 보내도 되는지 판정 can_send_push까지),
//                   4-17 내보내기(멤버 누구나, 5장), 4-18 미리보기 · 4-20 직접 초대(5장), 4-35 변경 알림 문구(9 · 11장), 99-04 운영 화면 처리(빈 곳 — "팀원 계정만" 판별 방법)
//   사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch04({ q, as, su, check, expectErr, PGlite, AUTH_STUBS, MIG_DIR, readFileSync, readdirSync, join }) {
  const id = (n) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const NOBODY = '40000000-0000-4000-8000-999999999999';

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
      [id(n), `f4-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f4_user_${n}`]);
    return id(n);
  };
  const call = async (uid, sql, params = []) => { await as(uid); const [r] = await q(`select ${sql} as r`, params); await su(); return r.r; };
  const block = (a, b) => call(a, 'public.block_user($1)', [b]);
  const unblock = (a, b) => call(a, 'public.unblock_user($1)', [b]);
  const search = (uid, s) => call(uid, 'public.search_by_handle($1)', [s]);
  const request = (a, b) => call(a, 'public.send_friend_request($1)', [b]);
  const accept = (b, a) => call(b, 'public.accept_friend_request($1)', [a]);
  const report = (uid, type, target, reason, note) => call(uid, 'public.submit_report($1, $2, $3, $4)', [type, target, reason, note ?? null]);
  const blocksOf = async (uid) => { await as(uid); const r = await q(`select * from public.my_blocks()`); await su(); return r; };
  const clearLimits = (...uids) => q(`delete from public.rate_limit_events where user_id = any($1::uuid[])`, [uids]);
  const pairRows = (a, b) => q(`select blocker_id, blocked_id from public.user_blocks
                                where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1) order by blocker_id`, [a, b]);
  const friendRow = async (a, b) => (await q(`select status::text, friend_id from public.friends
                                              where least(requester_id, addressee_id) = least($1::uuid, $2::uuid)
                                                and greatest(requester_id, addressee_id) = greatest($1::uuid, $2::uuid)`, [a, b]))[0] ?? null;
  const permCount = async (a, b) => (await q(`select count(*)::int as n from public.sharing_permissions
                                              where (owner_id = $1 and grantee_id = $2) or (owner_id = $2 and grantee_id = $1)`, [a, b]))[0].n;
  const befriend = async (a, b) => { await request(a, b); await accept(b, a); await clearLimits(a, b); };
  const NOT_FOUND = JSON.stringify({ status: 'NOT_FOUND' });

  // 그룹 — 만든 사람은 트리거가 JOINED로 넣고, 나머지는 바로 JOINED + 기상 공유 동의
  const mkGroup = async (owner, others) => {
    const [{ group_id: g, invite_code: code }] = await q(`insert into public.groups (group_name, owner_id) values ('차단그룹', $1) returning group_id, invite_code`, [owner]);
    for (const u of [owner, ...others]) {
      await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in) values ($1, $2, 'JOINED', now(), true)
               on conflict (group_id, user_id) do update set invite_status = 'JOINED', wake_share_opt_in = true`, [g, u]);
    }
    return { g, code };
  };
  const grantGroup = (owner, grantee, g) => q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_view_wake)
                                               values ($1, $2, 'GROUP', $3, true, true)`, [owner, grantee, g]);

  // ---- 차단 효과 ------------------------------------------------------------

  const A = await join_(1, '에이');
  const B = await join_(2, '비');

  await check('4-01 · 4-10 · 4-27(DB 몫) · 4-28: 친구 + 친구 · 그룹 권한 서로 → 차단하면 친구 행 · 두 출처 권한 행이 모두 지워지고 차단 행 1개, 상대가 바꿔 둔 알람은 그대로, 두 번 차단은 행 그대로, 자기 · 없는 사람은 거절', async () => {
    await befriend(A, B);
    const f = (await friendRow(A, B)).friend_id;
    const { g } = await mkGroup(A, [B]);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm) values ($1, $2, 'FRIEND', $3, true, true), ($2, $1, 'FRIEND', $3, true, true)`, [A, B, f]);
    await grantGroup(A, B, g);
    await grantGroup(B, A, g);
    // B가 A 알람을 G04로 바꿔 둠
    const [{ appointment_id: ap }] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '수업', now() + interval '1 day', '학교') returning appointment_id`, [A]);
    const [{ participant_id: p }] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, A]);
    const [{ alarm_id: al }] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', now() + interval '20 hours') returning alarm_id`, [p, A]);
    await as(B);
    const [changed] = await q(`update public.alarms set scheduled_at = scheduled_at + interval '5 minutes' where alarm_id = $1 returning scheduled_at`, [al]);
    await su();
    const before = await permCount(A, B);
    const r = await block(A, B);
    const rows = await pairRows(A, B);
    const [kept] = await q(`select scheduled_at from public.alarms where alarm_id = $1`, [al]);
    const again = await block(A, B);
    const self = await block(A, A);
    const ghost = await block(A, NOBODY);
    const [{ n: members }] = await q(`select count(*)::int as n from public.group_members where group_id = $1 and invite_status = 'JOINED'`, [g]);
    return before === 4 && r.status === 'BLOCKED' && (await friendRow(A, B)) === null && (await permCount(A, B)) === 0
      && rows.length === 1 && rows[0].blocker_id === A && rows[0].blocked_id === B
      && new Date(kept.scheduled_at).getTime() === new Date(changed.scheduled_at).getTime()
      && again.status === 'ALREADY_BLOCKED' && (await pairRows(A, B)).length === 1 && self.status === 'SELF' && ghost.status === 'NOT_FOUND' && members === 2
      ? true : { before, r, rows, again, self, ghost, members };
  });

  const P = await join_(10, '차단한사람');
  const Q = await join_(11, '차단당한사람');

  await check('4-02 · 4-03 · 4-04 · 4-05: 차단하면 양쪽 모두 서로 검색 · 요청 · 친구 링크가 없는 사람과 글자 그대로 같은 응답, 직접 insert도 거절되고 행이 안 생김', async () => {
    await block(P, Q);
    const shapes = [
      await search(Q, 'f4_user_10'), await search(P, 'f4_user_11'), await search(P, 'nobody_f4_none'),
      await request(Q, P), await request(P, Q),
    ].map((x) => JSON.stringify(x));
    await clearLimits(P, Q);
    const linkP = await call(P, 'public.my_friend_link()');
    const linkQ = await call(Q, 'public.my_friend_link()');
    const open1 = await call(Q, 'public.open_friend_link($1)', [linkP.token]);
    const open2 = await call(P, 'public.open_friend_link($1)', [linkQ.token]);
    await as(Q);
    const direct1 = await expectErr(() => q(`insert into public.friends (requester_id, addressee_id) values ($1, $2)`, [Q, P]), /violates foreign key constraint/);
    await as(P);
    const direct2 = await expectErr(() => q(`insert into public.friends (requester_id, addressee_id) values ($1, $2)`, [P, Q]), /violates foreign key constraint/);
    await su();
    await clearLimits(P, Q);
    return shapes.every((x) => x === NOT_FOUND) && open1.status === 'EXPIRED' && open2.status === 'EXPIRED'
      && direct1 === true && direct2 === true && (await friendRow(P, Q)) === null ? true : { shapes, open1, open2, direct1, direct2 };
  });

  await check('4-06 · 4-07 · 4-08: 받은 요청을 차단하면 대기 행이 지워지고(차단 행 하나), 보낸 요청을 차단해도 지워지고, 맞요청 중에 차단해도 자동 수락 안 됨 — 요청한 쪽은 거절과 같게 NOT_FOUND', async () => {
    const R1 = await join_(12, '요청보냄1'), R2 = await join_(13, '받은사람1');
    await request(R1, R2);
    const b1 = await block(R2, R1);   // 받은 요청 상태에서 차단 (4-06)
    const gone1 = await friendRow(R1, R2);
    const again1 = await request(R1, R2);
    const S1 = await join_(14, '보낸사람2'), S2 = await join_(15, '받는사람2');
    await request(S1, S2);
    const b2 = await block(S1, S2);   // 보낸 요청을 차단 (4-07)
    const gone2 = await friendRow(S1, S2);
    const T1 = await join_(16, '동시1'), T2 = await join_(17, '동시2');
    await request(T1, T2);
    await block(T1, T2);              // 요청 중 차단 (4-08)
    const late = await request(T2, T1);   // 상대의 맞요청 → 자동 수락 안 되고 NOT_FOUND
    const acc = await accept(T2, T1);
    await clearLimits(R1, R2, S1, S2, T1, T2);
    return b1.status === 'BLOCKED' && gone1 === null && JSON.stringify(again1) === NOT_FOUND && (await pairRows(R1, R2)).length === 1
      && b2.status === 'BLOCKED' && gone2 === null
      && JSON.stringify(late) === NOT_FOUND && acc.status === 'GONE' && (await friendRow(T1, T2)) === null ? true : { b1, gone1, again1, b2, gone2, late, acc };
  });

  await check('4-30: 친구 아닌 사람 3종(검색 결과 · 요청 보낸 사람 · 같은 그룹원)도 누구나 차단됨 — 행 1개씩', async () => {
    const X = await join_(18, '차단하는사람'), X1 = await join_(19, '검색결과'), X2 = await join_(20, '요청자'), X3 = await join_(21, '그룹원');
    await request(X2, X);
    await mkGroup(X, [X3]);
    const rs = [await block(X, X1), await block(X, X2), await block(X, X3)];
    const [{ n }] = await q(`select count(*)::int as n from public.user_blocks where blocker_id = $1`, [X]);
    await clearLimits(X2);
    return rs.every((r) => r.status === 'BLOCKED') && n === 3 ? true : { rs, n };
  });

  await check('4-29: 1분 안에 차단 · 풀기를 20번 반복해도 21번째까지 처리됨(횟수 제한 없음), 기록도 안 쌓임', async () => {
    const X = await join_(22, '반복'), Y = await join_(23, '반복상대');
    let ok = true;
    for (let i = 0; i < 10; i++) {
      ok = ok && (await block(X, Y)).status === 'BLOCKED' && (await unblock(X, Y)).status === 'UNBLOCKED';
    }
    const last = await block(X, Y);
    const [{ n }] = await q(`select count(*)::int as n from public.rate_limit_events where user_id = $1`, [X]);
    return ok && last.status === 'BLOCKED' && n === 0 ? true : { ok, last, n };
  });

  // ---- 그룹 · 공개 프로필 · 푸시 판정 -------------------------------------------

  await check('4-09 · 4-11 · 4-13(DB 몫): 같은 그룹에서 차단하면 서로 상대의 기상 줄이 없음(권한이 끝나서 · 되살아난 권한 행도 무시), 그룹 구성원 자격은 그대로, 차단 안 한 사람은 그대로 보임', async () => {
    const G1 = await join_(30, '캡스톤장'), G2 = await join_(31, '차단당함'), G3 = await join_(32, '그대로');
    // 시험을 돌리는 시각과 상관없이 낮 12시쯤이 되는 시간대로 — 약속이 "오늘"에 들어가게
    const [{ tz }] = await q(`select 'Etc/GMT' || case when h >= 12 then '+' || (h - 12) else '-' || (12 - h) end as tz
                              from (select extract(hour from now() at time zone 'UTC')::int as h) x`);
    await q(`update public.profiles set timezone = $2 where user_id = any($1::uuid[])`, [[G1, G2, G3], tz]);
    const { g } = await mkGroup(G1, [G2, G3]);
    const [{ appointment_id: ap }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '약속', now() + interval '1 hour', '학교') returning appointment_id`, [G1, g]);
    for (const u of [G2, G3]) {
      const [{ participant_id: pt }] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, u]);
      await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', now() + interval '30 minutes')`, [pt, u]);
    }
    for (const [o, t] of [[G1, G2], [G2, G1], [G1, G3], [G3, G1], [G2, G3], [G3, G2]]) await grantGroup(o, t, g);
    const wakeOf = async (u) => { await as(u); const r = await q(`select user_id from public.get_group_wake_status($1)`, [g]); await su(); return r.map((x) => x.user_id); };
    const before = await wakeOf(G1);
    await block(G1, G2);
    // 권한 행이 다시 생겨도(예전 값이 되살아나는 경우를 흉내) 차단이 이김
    await grantGroup(G2, G1, g);
    await grantGroup(G1, G2, g);
    const after1 = await wakeOf(G1);
    const after2 = await wakeOf(G2);
    const after3 = await wakeOf(G3);
    // 앱이 새 권한 행을 만들려 해도 막힘(출처가 차단 쌍이라 유효하지 않음)
    await q(`delete from public.sharing_permissions where (owner_id = $1 and grantee_id = $2) or (owner_id = $2 and grantee_id = $1)`, [G1, G2]);
    await as(G2);
    const mk = await expectErr(() => q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_wake) values ($1, $2, 'GROUP', $3, true)`, [G2, G1, g]), /row-level security/);
    await su();
    const [{ n: members }] = await q(`select count(*)::int as n from public.group_members where group_id = $1 and invite_status = 'JOINED'`, [g]);
    return before.includes(G2) && before.includes(G3) && !after1.includes(G2) && after1.includes(G3) && after1.includes(G1)
      && !after2.includes(G1) && after2.includes(G3) && after3.includes(G1) && after3.includes(G2)
      && mk === true && members === 3 ? true : { before, after1, after2, after3, mk, members };
  });

  await check('4-12 · 99-06: 차단 쌍이 같은 그룹이면 공개 프로필 함수가 서로 닉네임만(사진 · 아이디 없음), 차단 안 한 그룹원은 그대로, 그룹도 친구도 아닌 차단 쌍은 줄 자체가 없음', async () => {
    const H1 = await join_(33, '프로필1'), H2 = await join_(34, '프로필2'), H3 = await join_(35, '프로필3');
    await q(`update public.profiles set profile_image_url = 'https://img.example/' || nickname where user_id = any($1::uuid[])`, [[H1, H2, H3]]);
    await mkGroup(H1, [H2, H3]);
    await block(H1, H2);
    const pubs = async (u, ids) => { await as(u); const r = await q(`select * from public.get_public_profiles($1)`, [ids]); await su(); return Object.fromEntries(r.map((x) => [x.user_id, x])); };
    const seen1 = await pubs(H1, [H1, H2, H3]);
    const seen2 = await pubs(H2, [H1, H2, H3]);
    const L1 = await join_(36, '무관1'), L2 = await join_(37, '무관2');
    await block(L1, L2);
    const none = await pubs(L1, [L2]);
    const shape = (x) => x && x.nickname && x.profile_image_url === null && x.handle === null;
    return shape(seen1[H2]) && shape(seen2[H1])
      && seen1[H3].profile_image_url === 'https://img.example/프로필3' && seen1[H3].handle === 'f4_user_35' && seen1[H1].handle === 'f4_user_33'
      && Object.keys(none).length === 0 ? true : { seen1, seen2, none };
  });

  await check('4-14 · 4-15 · 4-16(DB 몫): 차단 쌍이면 푸시 판정(can_send_push)이 막힘 — 설정 권한 행이 되살아나도 ALARM_CHANGED false, 깨우기 · 미확인(WAKE_PING · WAKE_MISSED)도 false, 차단 안 한 쌍은 그대로 true', async () => {
    const K1 = await join_(38, '푸시1'), K2 = await join_(39, '푸시2'), K3 = await join_(40, '푸시3');
    await befriend(K1, K2);
    await befriend(K1, K3);
    const fs = [(await friendRow(K1, K2)).friend_id, (await friendRow(K1, K3)).friend_id];
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm) values ($1, $2, 'FRIEND', $4, true, true), ($1, $3, 'FRIEND', $5, true, true)`, [K1, K2, K3, fs[0], fs[1]]);
    const can = async (s, t, k) => (await q(`select public.can_send_push($1, $2, $3) as ok`, [s, t, k]))[0].ok;
    const pend = async (proposer, owner) => {   // 알림 권한(ALARM_CHANGED)은 방금 보낸 대기 중 제안이 있어야 통과 (10장) — 제안 한 줄을 서버 역할로 직접 넣음
    await su();
    const [ap] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '약속', now() + interval '10 hours', '학교') returning appointment_id`, [owner]);
    const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap.appointment_id, owner]);
    const [al] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', now() + interval '8 hours') returning alarm_id`, [pt.participant_id, owner]);
    await q(`insert into public.alarm_proposals (alarm_id, owner_id, proposer_id, from_at, to_at) values ($1, $2, $3, now() + interval '8 hours', now() + interval '7 hours')`, [al.alarm_id, owner, proposer]);
  };
    await pend(K2, K1); await pend(K3, K1);
    const before = await can(K2, K1, 'ALARM_CHANGED');   // 받는 사람 K1 알람을 K2가 고침 → K1이 K2에게 설정 권한을 줬는지
    await block(K1, K2);
    await q(`insert into public.friends (friend_id, requester_id, addressee_id, status, accepted_at) values ($1, $2, $3, 'ACCEPTED', now())`, [fs[0], K1, K2]);   // 예전 친구 행 · 권한이 되살아난 상황
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm) values ($1, $2, 'FRIEND', $3, true, true)`, [K1, K2, fs[0]]);
    const after = [await can(K2, K1, 'ALARM_CHANGED'), await can(K1, K2, 'ALARM_CHANGED'), await can(K2, K1, 'WAKE_PING'), await can(K2, K1, 'WAKE_MISSED'), await can(K1, K2, 'WAKE_MISSED')];
    const other = await can(K3, K1, 'ALARM_CHANGED');
    return before === true && after.every((x) => x === false) && other === true ? true : { before, after, other };
  });

  await check('4-19: 차단 쌍도 그룹 코드 참여는 막지 않음 — 참여는 되지만 권한은 못 만들고 서로 이름만', async () => {
    const O = await join_(41, '그룹주인'), Z = await join_(42, '코드로들어옴');
    const { g, code } = await mkGroup(O, []);
    await block(O, Z);
    const joined = await call(Z, 'public.join_group_by_invite_code($1)', [code]);
    const [m] = await q(`select invite_status::text from public.group_members where group_id = $1 and user_id = $2`, [g, Z]);
    await as(Z);
    const mk = await expectErr(() => q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_wake) values ($1, $2, 'GROUP', $3, true)`, [Z, O, g]), /row-level security/);
    await su();
    return joined === g && m.invite_status === 'JOINED' && mk === true ? true : { joined, m, mk };
  });

  // ---- 풀기 · 목록 · 숨김 --------------------------------------------------------

  await check('4-21 · 4-22: 풀면 상대가 다시 검색 · 요청 되고 친구 · 권한은 복구 안 됨, 서로 차단했으면 한쪽만 풀어도 상대 차단이 남아 안 보임', async () => {
    const U1 = await join_(43, '풀기1'), U2 = await join_(44, '풀기2');
    await befriend(U1, U2);
    const f = (await friendRow(U1, U2)).friend_id;
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [U1, U2, f]);
    await block(U1, U2);
    const u = await unblock(U1, U2);
    const u2 = await unblock(U1, U2);
    const found = await search(U2, 'f4_user_43');
    const req = await request(U2, U1);
    const restored = (await permCount(U1, U2)) === 0;
    await clearLimits(U1, U2);
    // 서로 차단
    const V1 = await join_(45, '서로1'), V2 = await join_(46, '서로2');
    await block(V1, V2);
    await block(V2, V1);
    await unblock(V1, V2);
    const stillHidden = JSON.stringify(await search(V1, 'f4_user_46'));
    const rows = await pairRows(V1, V2);
    await clearLimits(V1, V2);
    return u.status === 'UNBLOCKED' && u2.status === 'GONE' && found.status === 'FOUND' && found.relation === 'NONE' && req.status === 'REQUESTED' && restored
      && stillHidden === NOT_FOUND && rows.length === 1 && rows[0].blocker_id === V2 ? true : { u, u2, found, req, restored, stillHidden, rows };
  });

  await check('4-24 · 4-25: 차단 표는 차단한 사람 본인만 읽음 — 차단당한 사람 · 남은 읽지 못하고, 앱은 직접 넣거나 고치거나 지우지 못함', async () => {
    const W1 = await join_(47, '차단자'), W2 = await join_(48, '당한자'), W3 = await join_(49, '남');
    await block(W1, W2);
    const read = async (u) => { await as(u); const r = await q(`select * from public.user_blocks`); await su(); return r.length; };
    const mine = await read(W1), theirs = await read(W2), other = await read(W3);
    await as(W3);
    const ins = await expectErr(() => q(`insert into public.user_blocks (blocker_id, blocked_id) values ($1, $2)`, [W3, W1]), /permission denied/);
    const upd = await expectErr(() => q(`update public.user_blocks set created_at = now()`), /permission denied/);
    const del = await expectErr(() => q(`delete from public.user_blocks`), /permission denied/);
    await as(W2);
    const del2 = await expectErr(() => q(`delete from public.user_blocks where blocked_id = $1`, [W2]), /permission denied/);
    await su();
    const anon = await expectErr(async () => { await as(null, 'anon'); return q(`select * from public.user_blocks`); }, /permission denied/);
    await su();
    const shown = await blocksOf(W2);
    const self = await q(`select 1 from public.user_blocks where blocker_id = blocked_id`);
    return mine === 1 && theirs === 0 && other === 0 && ins === true && upd === true && del === true && del2 === true && anon === true
      && shown.length === 0 && self.length === 0 && (await pairRows(W1, W2)).length === 1 ? true : { mine, theirs, other, ins, upd, del, del2, anon, shown };
  });

  await check('4-33(DB 몫) · 4-26: 차단 목록은 내가 건 사람만 새로 건 순서로(사진 · 아이디 포함, 아이디를 바꾸면 새 아이디), 상대가 나를 차단했는지는 안 보이고 탈퇴한 사람은 자동으로 빠짐', async () => {
    const M = await join_(50, '목록주인'), M1 = await join_(51, '첫번째'), M2 = await join_(52, '두번째'), M3 = await join_(53, '나를차단');
    await block(M, M1);
    await q(`update public.user_blocks set created_at = created_at - interval '1 hour' where blocker_id = $1`, [M]);
    await block(M, M2);
    await block(M3, M);
    const list1 = await blocksOf(M);
    await q(`update public.profiles set handle = 'f4_renamed' where user_id = $1`, [M1]);
    const list2 = await blocksOf(M);
    await q(`delete from auth.users where id = $1`, [M2]);
    const list3 = await blocksOf(M);
    const gone = await pairRows(M, M2);
    return list1.map((x) => x.user_id).join() === [M2, M1].join() && Object.keys(list1[0]).sort().join() === 'blocked_at,handle,nickname,profile_image_url,user_id'
      && list2.find((x) => x.user_id === M1).handle === 'f4_renamed'
      && list3.map((x) => x.user_id).join() === [M1].join() && gone.length === 0 ? true : { list1, list2, list3, gone };
  });

  // ---- 옛 BLOCKED 행 옮기기 · 직접 쓰기 ----------------------------------------------

  await check('4-23: 마이그레이션 전의 BLOCKED 친구 행은 받은 쪽 = 차단한 사람으로 user_blocks에 옮겨지고 friends 행은 지워짐(다른 행 · 권한은 그대로)', async () => {
    const staged = new PGlite();
    try {
      await staged.exec(AUTH_STUBS);
      const files = readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort();
      const i = files.findIndex((x) => x.endsWith('_friend_blocks.sql'));
      if (i < 0) return '_friend_blocks.sql 마이그레이션이 없음';
      for (const f of files.slice(0, i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
      const sq = async (sql, params = []) => (await staged.query(sql, params)).rows;
      const u = (n) => id(100 + n);
      for (let n = 1; n <= 8; n++) await sq(`insert into auth.users (id, email) values ($1, $2)`, [u(n), `f4-old-${n}@example.com`]);
      await sq(`insert into public.friends (friend_id, requester_id, addressee_id, status, accepted_at) values
                ('50000000-0000-4000-8000-000000000001', $1, $2, 'BLOCKED', null),
                ('50000000-0000-4000-8000-000000000002', $3, $4, 'PENDING', null),
                ('50000000-0000-4000-8000-000000000003', $5, $6, 'ACCEPTED', now())`, [u(1), u(2), u(3), u(4), u(5), u(6)]);
      await sq(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values
                ($1, $2, 'FRIEND', '50000000-0000-4000-8000-000000000003', true)`, [u(5), u(6)]);
      // 옛 BLOCKED 쌍이 같은 그룹에 있고 그룹 출처 권한 행이 남아 있던 경우 — 옮기면서 같이 지워야 풀어도 되살아나지 않음
      const [{ group_id: gOld }] = await sq(`insert into public.groups (group_name, owner_id) values ('옛그룹', $1) returning group_id`, [u(1)]);
      await sq(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now())`, [gOld, u(2)]);
      await sq(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_wake) values ($1, $2, 'GROUP', $3, true), ($2, $1, 'GROUP', $3, true)`, [u(1), u(2), gOld]);
      for (const f of files.slice(i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
      const blocks = await sq(`select blocker_id, blocked_id from public.user_blocks`);
      const left = await sq(`select friend_id::text as id, status::text from public.friends order by friend_id`);
      const [{ n }] = await sq(`select count(*)::int as n from public.sharing_permissions`);
      return blocks.length === 1 && blocks[0].blocker_id === u(2) && blocks[0].blocked_id === u(1)
        && left.length === 2 && left.every((x) => x.status !== 'BLOCKED') && n === 1 ? true : { blocks, left, n };
    } finally {
      await staged.close();
    }
  });

  // ---- 신고 ----------------------------------------------------------------------

  await check('4-31 · 99-03: 신고 — 사람(사유 4종)과 그룹 이름을 신고하면 신고 표에 1행(신고자 · 대상 · 사유 · 한 줄 메모 · 시각 · 처리 안 됨), 메모는 앞뒤 공백을 뗌', async () => {
    const R = await join_(60, '신고자'), T = await join_(61, '신고대상'), O = await join_(62, '그룹주인');
    const { g } = await mkGroup(O, [R]);
    const r1 = await report(R, 'USER', T, 'NICKNAME', '  이상한 닉네임  ');
    const r2 = await report(R, 'USER', T, 'PHOTO');   // 같은 대상, 같은 날 → 두 번째
    const r3 = await report(R, 'GROUP', g, 'GROUP_NAME', '그룹 이름이 부적절해요');
    const rows = await q(`select reporter_id, target_type, target_user_id, target_group_id, reason, note, status, handled_by, created_at is not null as at from public.reports where reporter_id = $1 order by target_type, created_at`, [R]);
    const mine = await (async () => { await as(R); const x = await expectErr(() => q(`select * from public.reports`), /permission denied/); await su(); return x; })();
    return r1.status === 'REPORTED' && r2.status === 'ALREADY_REPORTED' && r3.status === 'REPORTED' && rows.length === 2
      && rows[0].target_type === 'GROUP' && rows[0].target_group_id === g && rows[0].target_user_id === null && rows[0].reason === 'GROUP_NAME'
      && rows[1].target_type === 'USER' && rows[1].target_user_id === T && rows[1].reason === 'NICKNAME' && rows[1].note === '이상한 닉네임'
      && rows.every((x) => x.status === 'OPEN' && x.handled_by === null && x.at === true) && mine === true ? true : { r1, r2, r3, rows, mine };
  });

  await check('4-31(제한): 같은 대상 하루 1번 — 다음 날(어제 기록은 안 셈)은 다시 되고, 다른 대상은 같은 날에도 됨 · 사유 · 대상 종류 · 메모 길이가 틀리면 INVALID · 자기 · 없는 사람 · 못 보는 그룹은 거절', async () => {
    const R = await join_(63, '반복신고'), T = await join_(64, '대상1'), T2 = await join_(65, '대상2'), O = await join_(66, '남의그룹주인');
    const { g } = await mkGroup(O, []);
    const first = await report(R, 'USER', T, 'HARASSMENT');
    const same = await report(R, 'USER', T, 'OTHER');
    const other = await report(R, 'USER', T2, 'HARASSMENT');
    await q(`update public.reports set created_at = created_at - interval '1 day' where reporter_id = $1`, [R]);
    const nextDay = await report(R, 'USER', T, 'HARASSMENT');
    const bad = [
      await report(R, 'USER', T, 'GROUP_NAME'),   // 사람에게 그룹 이름 사유
      await report(R, 'GROUP', g, 'NICKNAME'),    // 그룹에 닉네임 사유
      await report(R, 'USER', T, 'SPAM'),         // 없는 사유
      await report(R, 'PLACE', T, 'OTHER'),       // 없는 대상 종류
      await report(R, 'USER', T2, 'OTHER', 'x'.repeat(201)),
      await report(R, 'USER', T2, null),
    ];
    const self = await report(R, 'USER', R, 'OTHER');
    const ghost = await report(R, 'USER', NOBODY, 'OTHER');
    const hidden = await report(R, 'GROUP', g, 'GROUP_NAME');   // 나는 그 그룹 구성원이 아님
    const ok200 = await report(R, 'USER', T2, 'OTHER', 'x'.repeat(200));   // 200자까지는 됨(T2 기록은 어제로 옮겨져 오늘은 처음)
    return first.status === 'REPORTED' && same.status === 'ALREADY_REPORTED' && other.status === 'REPORTED' && nextDay.status === 'REPORTED'
      && bad.every((x) => x.status === 'INVALID') && self.status === 'SELF' && ghost.status === 'NOT_FOUND' && hidden.status === 'NOT_FOUND'
      && ok200.status === 'REPORTED' ? true : { first, same, other, nextDay, bad, self, ghost, hidden, ok200 };
  });

  await check('4-04(변형): 직접 insert 거절은 없는 사람과 같은 모양 — 에러 코드 23503, 메시지 · 상세가 외래 키 위반 문구 (차단당했음이 드러나지 않게, 4-가)', async () => {
    const S1 = await join_(110, '차단자'), S2 = await join_(111, '차단당함');
    await block(S1, S2);
    const grab = async (who, target) => {
      await as(who);
      try { await q(`insert into public.friends (requester_id, addressee_id) values ($1, $2)`, [who, target]); return { ok: true }; }
      catch (e) { return { code: e.code, message: e.message, detail: e.detail ?? null }; }
      finally { await su(); }
    };
    const blocked = await grab(S2, S1);
    const ghost = await grab(S2, NOBODY);
    const shape = (x) => x.code === '23503' && /^insert or update on table "friends" violates foreign key constraint "friends_(requester|addressee)_id_fkey"$/.test(x.message)
      && /^Key is not present in table "profiles"\.$/.test(x.detail ?? '');
    return shape(blocked) && shape(ghost) ? true : { blocked, ghost };
  });

  await check('4-04(바탕) · 4-08(바탕): 차단 · 직접 insert 가드 · 신고가 잠금을 건 채로 일함 — 차단과 직접 insert가 같은 사람 잠금(3장)을 써서 겹쳐도 차단 쌍에 대기 행이 남지 않고, 신고는 같은 대상 잠금으로 한 번만', async () => {
    const S1 = await join_(119, '잠금1'), S2 = await join_(120, '잠금2'), S3 = await join_(121, '잠금3'), S4 = await join_(122, '잠금4');
    await q(`create function pg_temp.f4_locks(kind text, a uuid, b uuid) returns integer language plpgsql as $$
             declare n integer;
             begin
               perform set_config('request.jwt.claim.sub', a::text, true);
               if kind = 'block' then
                 perform public.block_user(b);
               elsif kind = 'report' then
                 perform public.submit_report('USER', b, 'OTHER', null);
               else
                 set local role authenticated;
                 insert into public.friends (requester_id, addressee_id) values (a, b);
               end if;
               select count(*)::integer into n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid();
               return n;
             end $$`);
    const [{ n: blockLocks }] = await q(`select pg_temp.f4_locks('block', $1, $2) as n`, [S1, S2]);
    const [{ n: insertLocks }] = await q(`select pg_temp.f4_locks('insert', $1, $2) as n`, [S3, S4]);
    const [{ n: reportLocks }] = await q(`select pg_temp.f4_locks('report', $1, $2) as n`, [S3, S1]);
    await q(`delete from public.friends where requester_id = $1`, [S3]);
    return blockLocks >= 2 && insertLocks >= 2 && reportLocks >= 1 ? true : { blockLocks, insertLocks, reportLocks };
  });

  await check('4-06(변형): 차단과 겹쳐 대기 행이 남았어도(직접 insert 경쟁 흉내) 차단한 쪽이 수락하면 GONE — 친구가 되지 않음', async () => {
    const S1 = await join_(123, '차단하는쪽'), S2 = await join_(124, '남은요청');
    await block(S1, S2);
    await q(`insert into public.friends (requester_id, addressee_id) values ($1, $2)`, [S2, S1]);   // 남은 대기 행을 흉내 (서버 권한이라 가드를 안 탐)
    const a = await call(S1, 'public.accept_friend_request($1)', [S2]);
    const row = await friendRow(S1, S2);
    await q(`delete from public.friends where requester_id = $1`, [S2]);
    return a.status === 'GONE' && row?.status === 'PENDING' ? true : { a, row };
  });

  await check('4-28(변형) · 4-21(변형): 이미 차단한 사이에 남은 친구 행 · 권한 행이 있어도 다시 차단하면(ALREADY_BLOCKED) 정리되고, 풀 때도 남은 권한 행을 지워 되살아나지 않음', async () => {
    const S1 = await join_(125, '정리1'), S2 = await join_(126, '정리2');
    await block(S1, S2);
    const [{ friend_id: f }] = await q(`insert into public.friends (requester_id, addressee_id, status, accepted_at) values ($1, $2, 'ACCEPTED', now()) returning friend_id`, [S1, S2]);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [S1, S2, f]);
    const again = await block(S1, S2);
    const cleaned = (await friendRow(S1, S2)) === null && (await permCount(S1, S2)) === 0;
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_wake) values ($1, $2, 'GROUP', gen_random_uuid(), true)`, [S2, S1]);
    const un = await unblock(S1, S2);
    return again.status === 'ALREADY_BLOCKED' && cleaned && un.status === 'UNBLOCKED' && (await permCount(S1, S2)) === 0 ? true : { again, cleaned, un, perms: await permCount(S1, S2) };
  });

  await check('4-10(변형): 대기 중인 친구 행은 권한 출처로 안 침 — 수락돼 친구가 돼야 권한이 효력을 가짐', async () => {
    const S1 = await join_(127, '대기권한1'), S2 = await join_(128, '대기권한2');
    const [{ friend_id: f }] = await q(`insert into public.friends (requester_id, addressee_id) values ($1, $2) returning friend_id`, [S1, S2]);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [S1, S2, f]);
    const pending = (await q(`select count(*)::int as n from private.granted_owner_ids_for($1, 'VIEW_ALARM')`, [S2]))[0].n;
    await q(`update public.friends set status = 'ACCEPTED' where friend_id = $1`, [f]);
    const accepted = (await q(`select count(*)::int as n from private.granted_owner_ids_for($1, 'VIEW_ALARM')`, [S2]))[0].n;
    return pending === 0 && accepted === 1 ? true : { pending, accepted };
  });

  await check('4-31(경계): 신고의 하루는 신고하는 사람 시간대 자정부터 — 자정 전 기록은 오늘로 안 세어 다시 되고, 자정 뒤 기록은 셈', async () => {
    const R = await join_(112, '시간대신고'), T = await join_(113, '시간대대상');
    // 그 시간대에서 지금이 새벽 1시쯤이 되는 고정 시간대(Etc/GMT±N) — 6시간 전은 어제, 10분 전은 오늘
    const [{ tz }] = await q(`select case when o >= 0 then 'Etc/GMT-' || o else 'Etc/GMT+' || (-o) end as tz
                              from (select case when h <= 13 then 1 - h else 25 - h end as o
                                    from (select extract(hour from now() at time zone 'UTC')::int as h) x) y`);
    await q(`update public.profiles set timezone = $2 where user_id = $1`, [R, tz]);
    const first = await report(R, 'USER', T, 'OTHER');
    await q(`update public.reports set created_at = now() - interval '6 hours' where reporter_id = $1`, [R]);
    const nextDay = await report(R, 'USER', T, 'OTHER');
    await q(`update public.reports set created_at = now() - interval '10 minutes' where reporter_id = $1 and created_at > now() - interval '1 minute'`, [R]);
    const same = await report(R, 'USER', T, 'OTHER');
    return first.status === 'REPORTED' && nextDay.status === 'REPORTED' && same.status === 'ALREADY_REPORTED' ? true : { tz, first, nextDay, same };
  });

  await check('4-31(경계): 초대만 받은 사람도 그룹 이름을 신고하고 아무 관계 없는 사람은 못 함(NOT_FOUND) · 공백만 있는 메모는 메모 없음으로 저장', async () => {
    const O = await join_(129, '신고그룹주인'), Inv = await join_(130, '초대만'), Out = await join_(131, '관계없음');
    const { g } = await mkGroup(O, []);
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g, Inv]);
    const a = await report(Inv, 'GROUP', g, 'GROUP_NAME', '   ');
    const b = await report(Out, 'GROUP', g, 'GROUP_NAME');
    const [row] = await q(`select note from public.reports where reporter_id = $1`, [Inv]);
    return a.status === 'REPORTED' && b.status === 'NOT_FOUND' && row.note === null ? true : { a, b, row };
  });

  await check('4-26(변형) · 12장 바탕: 신고한 사람이 탈퇴해도 신고는 남고(신고자만 비움), 신고당한 사람 · 그룹이 사라지면 신고도 사라짐 — 탈퇴가 신고 때문에 막히지 않음', async () => {
    const R = await join_(114, '신고하고탈퇴'), T = await join_(115, '신고당하고탈퇴'), O = await join_(116, '그룹주인2');
    const { g } = await mkGroup(O, [R]);
    await report(R, 'USER', T, 'OTHER');
    await report(R, 'GROUP', g, 'GROUP_NAME');
    await q(`delete from auth.users where id = $1`, [R]);
    const afterR = await q(`select target_type, reporter_id from public.reports where target_user_id = $1 or target_group_id = $2`, [T, g]);
    await q(`delete from auth.users where id = $1`, [T]);
    await q(`delete from public.groups where group_id = $1`, [g]);
    const left = await q(`select 1 from public.reports where target_user_id = $1 or target_group_id = $2`, [T, g]);
    return afterR.length === 2 && afterR.every((x) => x.reporter_id === null) && left.length === 0 ? true : { afterR, left };
  });

  await check('4장 함수: 로그인 정보가 없으면 42501, anon은 실행 권한 없음, 차단 판정 함수는 앱이 직접 못 부름, 신고 표는 서버 전용', async () => {
    await as(null);
    const errs = [];
    for (const sql of [`select public.block_user('${id(1)}')`, `select public.unblock_user('${id(1)}')`,
                       `select public.submit_report('USER', '${id(1)}', 'OTHER', null)`]) {
      errs.push(await expectErr(() => q(sql), /로그인이 필요함/));
    }
    const list = await q(`select * from public.my_blocks()`);   // 이름 검색(2-33)처럼 로그인 정보가 없으면 빈 결과
    await as(null, 'anon');
    const anon = await expectErr(() => q(`select public.block_user('${id(1)}')`), /permission denied/);
    await as(A);
    const pair = await expectErr(() => q(`select private.is_blocked_pair($1, $2)`, [A, B]), /permission denied/);
    const reports = await expectErr(() => q(`select * from public.reports`), /permission denied/);
    const rIns = await expectErr(() => q(`insert into public.reports (reporter_id, target_type, target_user_id, reason) values ($1, 'USER', $2, 'OTHER')`, [A, B]), /permission denied/);
    await su();
    return errs.every((x) => x === true) && list.length === 0 && anon === true && pair === true && reports === true && rIns === true ? true : { errs, list, anon, pair, reports, rIns };
  });
}
