// 친구 15장 — 남용 · 보안 (친구_시험케이스.md 15장 DB 층, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호
//   이 장 DB에 없는 것: 15-09 ~ 15-11 · 15-24(알림 서버 함수 = notify.test.ts) · 15-23 · 15-25 · 15-26(앱) · 15-27 · 15-28(대본) · 15-16의 대본 부분 · 15-21(함수마다 다른 시험으로 이미 확인)
//   이미 다른 곳 시험이 있는 것: 15-16 DB 부분(그룹 채널에 앱이 broadcast insert 거부 = db-check '그룹 기상 신호' 시험) · 15-22(모든 public 표 RLS 켜짐 = db-check 전 표 RLS 확인)
//   빈 곳: ① 15-08 `wake_ping_enabled` 직접 update 거절 — 앱 PR(#417)이 지금 그 길로 스위치를 바꿔서 함수 + 트리거는 앱이 옮긴 뒤 ② `groups_insert_owner`(그룹 만들기 직접 insert) — 앱이 지금 그 길로 만들어서 같은 이유로 안 닫음
//   사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch15({ q, as, su, svc, check, expectErr }) {
  const id = (n) => `be000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const NOBODY = 'be000000-0000-4000-8000-999999999999';

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f15-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f15_user_${n}`]);
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
  const mkGroup = async (owner, others = []) => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ('보안그룹', $1) returning group_id`, [owner]);
    await su();
    for (const u of others) await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now())`, [g.group_id, u]);
    return g.group_id;
  };
  const count = async (sql, params = []) => (await q(`select count(*)::int as n from (${sql}) t`, params))[0].n;

  // ---- 15-01: 계정 단위로만 셈 ----------------------------------------------------------------

  await check('15-01: 계정 3개가 돌려 가며 검색해도 막지 않음 — 제한은 계정마다 1분 10회(셋이 합쳐 30회)', async () => {
    const accounts = [await join_(1, '하나'), await join_(2, '둘'), await join_(3, '셋')];
    const results = [];
    for (let i = 0; i < 10; i++) {
      for (const a of accounts) results.push((await call(a, 'public.search_by_handle($1)', ['f15_user_1'])).status);
    }
    const eleventh = (await call(accounts[0], 'public.search_by_handle($1)', ['f15_user_1'])).status;
    const fresh = (await call(await join_(4, '넷'), 'public.search_by_handle($1)', ['f15_user_1'])).status;
    const limited = results.filter((x) => x === 'LIMIT' || x === 'RATE_LIMITED' || x === 'TOO_MANY');
    return limited.length === 0 && results.length === 30 && eleventh !== 'OK' && fresh !== eleventh ? true : { limited, n: results.length, eleventh, fresh };
  });

  // ---- 15-02: 직접 쓰기 정책을 닫고 함수로만 ---------------------------------------------------

  await check('15-02: 함수 밖 직접 insert로는 친구 요청 · 그룹 초대를 만들 수 없음(요청 11번 모두 거부) — 횟수 제한 · 차단 검사를 우회하지 못함', async () => {
    const A = await join_(5, '보내는이'), B = await join_(6, '받는이'), C = await join_(7, '초대받는이');
    const g = await mkGroup(A, []);
    await befriend(A, C);                                                                // 친구 사이여도 함수 밖 직접 초대는 안 됨
    await as(A);
    const attempts = [];
    for (let i = 0; i < 11; i++) {
      attempts.push(await expectErr(() => q(`insert into public.friends (requester_id, addressee_id, status) values ($1, $2, 'PENDING')`, [A, B]), /row-level security|permission denied|violates/));
    }
    const invite = await expectErr(() => q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g, C]), /row-level security|permission denied/);
    await su();
    const rows = { friends: await count(`select 1 from public.friends where requester_id = $1 and addressee_id = $2`, [A, B]), invites: await count(`select 1 from public.group_members where group_id = $1 and invite_status = 'INVITED'`, [g]) };
    const viaFunction = await call(A, 'public.send_friend_request($1)', [B]);                   // 함수로는 됨
    return attempts.every((x) => x === true) && invite === true && rows.friends === 0 && rows.invites === 0 && viaFunction.status === 'REQUESTED' ? true : { attempts, invite, rows, viaFunction };
  });

  await check('15-02(수락 · 거절 · 끊기): 앱의 직접 update · delete로는 요청을 수락 · 거절 · 취소하거나 친구를 끊을 수 없음(0행, 친구 100명 상한을 우회하던 길) — 함수로는 됨', async () => {
    const A = await join_(60, '요청자'), B = await join_(61, '받는이'), C = await join_(62, '다른이');
    const asDirect = async (uid, sql, params) => { await as(uid); const r = await q(sql, params); await su(); return r.length; };
    await call(A, 'public.send_friend_request($1)', [B]);
    const fid = await friendId(A, B);
    const pendingDirect = [
      await asDirect(B, `update public.friends set status = 'ACCEPTED', accepted_at = now() where friend_id = $1 returning 1`, [fid]),   // 받은 사람의 직접 수락
      await asDirect(B, `delete from public.friends where friend_id = $1 returning 1`, [fid]),                                           // 받은 사람의 직접 거절
      await asDirect(A, `delete from public.friends where friend_id = $1 returning 1`, [fid]),                                           // 보낸 사람의 직접 취소
    ];
    const stillPending = (await q(`select status::text as s from public.friends where friend_id = $1`, [fid]))[0]?.s;
    const accepted = await call(B, 'public.accept_friend_request($1)', [A]);
    const friendDirect = [
      await asDirect(A, `delete from public.friends where friend_id = $1 returning 1`, [fid]),                                           // 직접 끊기
      await asDirect(B, `delete from public.friends where friend_id = $1 returning 1`, [fid]),
      await asDirect(C, `delete from public.friends where friend_id = $1 returning 1`, [fid]),                                           // 남
    ];
    const stillFriends = (await q(`select status::text as s from public.friends where friend_id = $1`, [fid]))[0]?.s;
    const removed = await call(A, 'public.remove_friend($1)', [B]);
    const gone = await friendId(A, B);
    return pendingDirect.every((n) => n === 0) && stillPending === 'PENDING' && accepted.status === 'ACCEPTED'
      && friendDirect.every((n) => n === 0) && stillFriends === 'ACCEPTED' && removed.status === 'REMOVED' && gone === null
      ? true : { pendingDirect, stillPending, accepted, friendDirect, stillFriends, removed, gone };
  });

  // ---- 15-03 ~ 15-05: 로그인 없음 ---------------------------------------------------------------

  await check('15-03 · 15-05: 로그인 안 한 요청(anon)은 public 함수를 하나도 못 부름 — 모든 함수에서 anon 실행 권한이 없음', async () => {
    const open = await q(`select p.proname, pg_get_function_identity_arguments(p.oid) as args
                          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.prokind = 'f'
                            and has_function_privilege('anon', p.oid, 'execute')
                            and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
                            and p.proname !~ '^[a-z_]*decision'                 -- 회의 도구(결정 댓글 · 투표)는 웹 회의 화면이 로그인 없이 씀
                          order by 1`);
    return open.length === 0 ? true : { open: open.map((x) => `${x.proname}(${x.args})`) };
  });

  await check('15-04: anon 키로는 사람·관계 표를 읽을 수 없음 — 모든 public 표에서 anon 권한이 없음', async () => {
    const open = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
                            and c.relname !~ '^decision_'                         -- 회의 도구 표
                            and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
                                 or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))
                          order by 1`);
    await as(null, 'anon');
    const reads = [];
    for (const t of ['friends', 'groups', 'group_members', 'sharing_permissions', 'user_blocks', 'profiles', 'alarms']) {
      reads.push(await expectErr(() => q(`select * from public.${t}`), /permission denied/));
    }
    await su();
    return open.length === 0 && reads.every((x) => x === true) ? true : { open: open.map((x) => x.relname), reads };
  });

  // ---- 15-06: 입력 길이 · 형식 -------------------------------------------------------------------

  await check('15-06: 코드 · 아이디에 1만 자를 넣어도 함수 첫 줄에서 길이 검사로 거절(오류 없이 NOT_FOUND 계열) — 옛 모양 함수도 빈 결과', async () => {
    const A = await join_(8, '긴입력');
    const long = 'A'.repeat(10_000);
    const results = {
      search: await call(A, 'public.search_by_handle($1)', [long]),
      preview: await call(A, 'public.preview_group_by_code($1)', [long]),
      join: await call(A, 'public.join_group($1, false)', [long]),
    };
    await as(A);
    const old = await q(`select * from public.find_profile_by_handle($1)`, [long]);
    await su();
    const statuses = Object.values(results).map((x) => x?.status);
    return statuses.every((x) => x === 'NOT_FOUND') && old.length === 0 ? true : { results, old };
  });

  // ---- 15-07 · 15-08: 프로필 칸 직접 update ---------------------------------------------------------

  await check('15-07 · 15-08: 앱이 profiles의 handle · onboarded_at을 직접 바꾸려 하면 트리거가 거절 — 아이디 30일 규칙 · 온보딩 판정을 우회하지 못함', async () => {
    const A = await join_(9, '프로필');
    await as(A);
    const handle1 = await expectErr(() => q(`update public.profiles set handle = 'f15_changed_1' where user_id = $1`, [A]), /바꿀 수 없음|로만 바꿈|row-level security|permission denied/);
    const handle2 = await expectErr(() => q(`update public.profiles set handle = 'f15_changed_2' where user_id = $1`, [A]), /바꿀 수 없음|로만 바꿈|row-level security|permission denied/);
    const onboard = await expectErr(() => q(`update public.profiles set onboarded_at = null where user_id = $1`, [A]), /바꿀 수 없음|row-level security|permission denied/);
    await su();
    const [p] = await q(`select handle, onboarded_at is not null as onboarded from public.profiles where user_id = $1`, [A]);
    return handle1 === true && handle2 === true && onboard === true && p.handle === 'f15_user_9' && p.onboarded === true ? true : { handle1, handle2, onboard, p };
  });

  // ---- 15-12 ~ 15-14: 푸시 판정 · 서버 전용 함수 ----------------------------------------------------

  await check('15-12 · 15-13: 차단했거나 권한 없는 대상에게는 푸시 판정이 false, 서버 전용 함수(푸시 판정 · 깨우기 판정 · 계정 삭제 준비 등)는 앱이 못 부름', async () => {
    const A = await join_(10, '보냄'), B = await join_(11, '받음');
    await befriend(A, B);
    await svc();
    const noPerm = (await q(`select public.can_send_push($1, $2, 'ALARM_CHANGED') as ok`, [A, B]))[0].ok;
    await su();
    await call(B, 'public.block_user($1)', [A]);
    await svc();
    const blocked = [];
    for (const kind of ['ALARM_CHANGED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'WAKE_PING']) blocked.push((await q(`select public.can_send_push($1, $2, $3) as ok`, [A, B, kind]))[0].ok);
    await su();
    await as(A);
    const serverOnly = [
      await expectErr(() => q(`select public.can_send_push($1, $2, 'ALARM_CHANGED')`, [A, B]), /permission denied/),
      await expectErr(() => q(`select * from public.plan_wake_ping($1, $2)`, [A, B]), /permission denied/),
      await expectErr(() => q(`select * from public.claim_wake_nudges(now())`), /permission denied/),
      await expectErr(() => q(`select * from public.find_missed_wake_alarms(now(), 12)`), /permission denied/),
      await expectErr(() => q(`select public.prepare_account_delete($1)`, [A]), /permission denied/),
    ];
    await su();
    return noPerm === false && blocked.every((x) => x === false) && serverOnly.every((x) => x === true) ? true : { noPerm, blocked, serverOnly };
  });

  await check('15-14 · 15-15: 남의 푸시 토큰은 읽지도 쓰지도 못하고, 같은 토큰 문자열을 다른 계정이 등록하면 주인이 마지막 로그인 계정으로 바뀜', async () => {
    const A = await join_(12, '가'), B = await join_(13, '나');
    const token = 'ExponentPushToken[f15aaaaaaaaaaaaaaaaaaa]';
    await call(B, `public.register_push_token($1, 'android')`, [token]);
    await as(A);
    const read = await q(`select * from public.push_tokens where user_id = $1`, [B]);
    const write = await expectErr(() => q(`insert into public.push_tokens (user_id, token) values ($1, 'ExponentPushToken[f15bbbbbbbbbbbbbbbbbbb]')`, [B]), /row-level security|permission denied/);
    const del = await q(`delete from public.push_tokens where user_id = $1 returning 1`, [B]);
    await su();
    await call(A, `public.register_push_token($1, 'android')`, [token]);                      // A가 같은 폰으로 로그인
    const owner = (await q(`select user_id from public.push_tokens where token = $1`, [token]))[0]?.user_id;
    return read.length === 0 && write === true && del.length === 0 && owner === A ? true : { read, write, del, owner };
  });

  // ---- 15-17 ~ 15-20: 행 단위 권한 -----------------------------------------------------------------

  await check('15-17: 남의 공유 권한을 대신 만들 수 없음 — owner를 다른 사람으로 넣은 insert는 거절, 내 행만 만들어짐', async () => {
    const A = await join_(14, '나'), B = await join_(15, '친구'), C = await join_(16, '제3자');
    await befriend(A, B); await befriend(B, C);
    const f = await friendId(B, C);
    const fAB = await friendId(A, B);
    await as(A);
    const forged = await expectErr(() => q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [B, A, fAB]), /row-level security|violates|permission denied/);
    const foreignRelation = await expectErr(() => q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [A, B, f]), /row-level security|violates|permission denied/);
    await su();
    return forged === true && foreignRelation === true && (await count(`select 1 from public.sharing_permissions where owner_id in ($1, $2)`, [A, B])) === 0 ? true : { forged, foreignRelation };
  });

  await check('15-18 · 15-19: 그룹 비멤버는 이름 고치기 · 지우기 · 남의 멤버 행 지우기가 모두 0행, 참여 중 멤버는 이름은 고치지만 그룹 지우기는 0행 — 멤버끼리 멤버 행을 지우는 것은 5장 내보내기 규칙대로 됨(그룹장 없음)', async () => {
    const A = await join_(17, '주인'), B = await join_(18, '참여'), X = await join_(19, '비멤버');
    const g = await mkGroup(A, [B]);
    const run = async (uid, sql, params) => { await as(uid); const r = await q(sql, params); await su(); return r.length; };
    const outsiderUpdate = await run(X, `update public.groups set group_name = '해킹' where group_id = $1 returning 1`, [g]);
    const outsiderDelete = await run(X, `delete from public.groups where group_id = $1 returning 1`, [g]);
    const memberRename = await run(B, `update public.groups set group_name = '새 이름' where group_id = $1 returning 1`, [g]);
    const memberDelete = await run(B, `delete from public.groups where group_id = $1 returning 1`, [g]);
    const outsiderKick = await run(X, `delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [g, A]);
    const memberKickOwnerRow = await (async () => { await as(B); const r = await q(`delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [g, A]); await su(); return r.length; })();
    const name = (await q(`select group_name from public.groups where group_id = $1`, [g]))[0]?.group_name;
    return outsiderUpdate === 0 && outsiderDelete === 0 && memberRename === 1 && memberDelete === 0 && outsiderKick === 0 && name === '새 이름' && memberKickOwnerRow === 1
      ? true : { outsiderUpdate, outsiderDelete, memberRename, memberDelete, outsiderKick, memberKickOwnerRow, name };
  });

  await check('15-20: 권한 없는 사람이 남의 알람 약속(get_shared_alarm_appointments)을 물으면 빈 결과', async () => {
    const A = await join_(20, '주인'), X = await join_(21, '남');
    const [ap] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, null, '비밀', now() + interval '10 hours', '집') returning appointment_id`, [A]);
    const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap.appointment_id, A]);
    await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', now() + interval '8 hours')`, [pt.participant_id, A]);
    await as(X);
    const rows = await q(`select * from public.get_shared_alarm_appointments($1)`, [A]);
    const none = await q(`select * from public.get_shared_alarm_appointments($1)`, [NOBODY]);
    await su();
    return rows.length === 0 && none.length === 0 ? true : { rows, none };
  });

  // ---- 15-타: 시험 계정 초기화 ----------------------------------------------------------------------

  await check('15-타(15-27 DB): 시험 계정 초기화(dev_reset_my_data)가 내 친구 · 그룹 참여 · 공유 권한 · 차단도 지움 — 남의 계정과 남이 있는 그룹은 그대로', async () => {
    const A = await join_(22, '초기화'), B = await join_(23, '친구'), C = await join_(24, '요청만'), D = await join_(25, '차단당함'), E = await join_(26, '그룹원'), X = await join_(27, '나를차단');
    await befriend(A, B);
    await call(A, 'public.send_friend_request($1)', [C]);
    const Y = await join_(28, '내게요청'); await call(Y, 'public.send_friend_request($1)', [A]);    // 받은 요청도 지워짐
    await call(A, 'public.block_user($1)', [D]);
    await call(X, 'public.block_user($1)', [A]);                                  // 남이 나를 건 차단은 남의 선택이라 그대로
    await q(`insert into public.wake_hides (owner_id, hidden_from_id) values ($1, $2)`, [A, E]);   // 내가 숨긴 기상
    const f = await friendId(A, B);
    await as(A);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [A, B, f]);
    await su();
    await as(B);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [B, A, f]);
    await su();
    const shared = await mkGroup(A, [E]);                // 남이 있는 그룹
    const alone = await mkGroup(A, []);                  // 혼자인 그룹
    await clearLimits(A);
    await call(A, 'public.dev_reset_my_data()', []);
    const mine = {
      friends: await count(`select 1 from public.friends where requester_id = $1 or addressee_id = $1`, [A]),
      perms: await count(`select 1 from public.sharing_permissions where owner_id = $1 or grantee_id = $1`, [A]),
      blocks: await count(`select 1 from public.user_blocks where blocker_id = $1`, [A]),
      members: await count(`select 1 from public.group_members where user_id = $1`, [A]),
      hides: await count(`select 1 from public.wake_hides where owner_id = $1`, [A]),
    };
    const others = {
      bProfile: await count(`select 1 from public.profiles where user_id = $1`, [B]),
      sharedGroup: await count(`select 1 from public.groups where group_id = $1`, [shared]),
      sharedMembers: await count(`select 1 from public.group_members where group_id = $1 and user_id = $2`, [shared, E]),
      aloneGroup: await count(`select 1 from public.groups where group_id = $1`, [alone]),
      blockOnMe: await count(`select 1 from public.user_blocks where blocker_id = $1 and blocked_id = $2`, [X, A]),
    };
    return mine.friends === 0 && mine.perms === 0 && mine.blocks === 0 && mine.members === 0 && mine.hides === 0 && others.blockOnMe === 1
      && others.bProfile === 1 && others.sharedGroup === 1 && others.sharedMembers === 1 && others.aloneGroup === 0 ? true : { mine, others };
  });

  // ---- 탐색 시험 X-SEED-03: 개발용 초기화는 시드 · 시험 계정만 ----------------------------------------------

  await check('X-SEED-03: 개발용 초기화(dev_reset_my_data)는 이메일이 @example.com인 시드 · 시험 계정만 — 일반 계정(다른 주소 · 주소 없음)은 42501 "시험 계정만 쓸 수 있음", 친구 · 그룹 데이터는 그대로. 대문자 주소 · 시드 데모 주소는 통과', async () => {
    const mk = async (n, email, nickname) => {
      await as(null, 'supabase_auth_admin');
      await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), email, JSON.stringify({ name: nickname })]);
      await su();
      await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f15_user_${n}`]);
      return id(n);
    };
    const R = await mk(70, 'real.user@gmail.com', '일반'), N = await mk(71, null, '주소없음'), T = await mk(72, 'Demo-Me@Example.COM', '대문자시험'), S = await mk(74, 'e2e-reset-abc@example.com', '도구');
    const F = await join_(73, '친구');
    await befriend(R, F);
    const mkRej = async (u) => { await as(u); const r = await expectErr(() => q(`select public.dev_reset_my_data()`), /시험 계정만 쓸 수 있음/); await su(); return r; };
    const rRej = await mkRej(R), nRej = await mkRej(N);
    const stillFriends = await count(`select 1 from public.friends where requester_id = $1 or addressee_id = $1`, [R]);
    await call(T, 'public.dev_reset_my_data()', []);
    await call(S, 'public.dev_reset_my_data()', []);
    return rRej === true && nRej === true && stillFriends === 1 ? true : { rRej, nRej, stillFriends };
  });
}
