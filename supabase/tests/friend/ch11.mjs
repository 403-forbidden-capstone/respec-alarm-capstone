// 친구 11장 — 푸시 바탕 (친구_시험케이스.md 11장 DB 층 + 15-14 · 15-15, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호
//   이 장 DB에 없는 것: 11-05 ~ 11-09 · 11-18 ~ 11-22(서버 함수 시험 — supabase/functions/_shared/notify.test.ts · wake.test.ts), 11-23 ~ 11-29(실기기 · 앱 · 대본)
//   깨우기(WAKE_PING) 허용 조건은 8장, 알람 바꾸기(ALARM_CHANGED) 내용은 10장, 공동 약속 변경을 부르는 곳은 9장 — 여기선 종류 · 받는 사람 고르기 바탕까지
//   사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch11({ q, as, su, svc, check, expectErr }) {
  const id = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const NOBODY = 'a0000000-0000-4000-8000-999999999999';
  const T = (c) => `ExponentPushToken[${c.repeat(22)}]`;

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f11-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f11_user_${n}`]);
    return id(n);
  };
  const call = async (uid, sql, params = []) => { await as(uid); const [r] = await q(`select ${sql} as r`, params); await su(); return r.r; };
  const clearLimits = (...uids) => q(`delete from public.rate_limit_events where user_id = any($1::uuid[])`, [uids]);
  const request = (a, b) => call(a, 'public.send_friend_request($1)', [b]);
  const accept = (b, a) => call(b, 'public.accept_friend_request($1)', [a]);
  const befriend = async (a, b) => { await request(a, b); await accept(b, a); await clearLimits(a, b); };
  const tokensOf = async (u) => (await q(`select token from public.push_tokens where user_id = $1 order by token`, [u])).map((x) => x.token);
  const register = (u, token, platform = 'android') => call(u, 'public.register_push_token($1, $2)', [token, platform]);
  const canPush = async (s, t, k) => { await svc(); const r = (await q(`select public.can_send_push($1, $2, $3) as ok`, [s, t, k]))[0].ok; await su(); return r; };
  const planGroup = async (s, g, k, ap = null) => { await svc(); const r = (await q(`select public.plan_group_push($1, $2, $3, $4) as r`, [s, g, k, ap]))[0].r; await su(); return r; };
  const mkGroup = async (owner, others = [], name = '푸시그룹') => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ($1, $2) returning group_id`, [name, owner]);
    await su();
    for (const u of others) await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now())`, [g.group_id, u]);
    return g.group_id;
  };
  const ids = (r) => (r.recipients ?? []).slice().sort();
  const sorted = (...x) => x.slice().sort();

  // ---- 토큰 ----------------------------------------------------------------------

  await check('11-01 · 11-03: 토큰 등록 — 로그인한 사람은 1행(플랫폼 기록), 로그인 정보가 없으면 거절, Expo 토큰 모양이 아니거나 플랫폼이 android · ios가 아니면 거절', async () => {
    const A = await join_(1, '에이');
    await register(A, T('a'), 'android');
    const rows = await q(`select user_id, token, platform from public.push_tokens where user_id = $1`, [A]);
    await as(null);
    const noLogin = await expectErr(() => q(`select public.register_push_token($1, 'android')`, [T('b')]), /로그인이 필요함/);
    await as(A);
    const badShape = await expectErr(() => q(`select public.register_push_token('not-a-token', 'android')`), /푸시 토큰/);
    const empty = await expectErr(() => q(`select public.register_push_token('', 'android')`), /푸시 토큰/);
    const long = await expectErr(() => q(`select public.register_push_token($1, 'android')`, [`ExponentPushToken[${'z'.repeat(300)}]`]), /푸시 토큰/);
    const badPlatform = await expectErr(() => q(`select public.register_push_token($1, 'web')`, [T('c')]), /플랫폼/);
    const nullPlatform = await expectErr(() => q(`select public.register_push_token($1, null)`, [T('c')]), /플랫폼/);
    await su();
    await register(A, T('d'), 'ios');
    const total = (await tokensOf(A)).length;
    // 경계: 옛 이름(ExpoPushToken[...])도 받고, 길이 200자까지는 되고 201자부터 거절, 같은 토큰을 다시 등록하면 플랫폼도 새 값으로
    const oldName = `ExpoPushToken[${'q'.repeat(22)}]`;
    const at200 = `ExponentPushToken[${'r'.repeat(200 - 'ExponentPushToken[]'.length)}]`;
    const at201 = `ExponentPushToken[${'s'.repeat(201 - 'ExponentPushToken[]'.length)}]`;
    await register(A, oldName);
    await register(A, at200);
    await as(A);
    const over = await expectErr(() => q(`select public.register_push_token($1, 'android')`, [at201]), /푸시 토큰/);
    await su();
    await register(A, T('d'), 'android');
    const [{ platform: pf }] = await q(`select platform from public.push_tokens where token = $1`, [T('d')]);
    const stored = await tokensOf(A);
    return rows.length === 1 && rows[0].token === T('a') && rows[0].platform === 'android' && noLogin === true
      && badShape === true && empty === true && long === true && badPlatform === true && nullPlatform === true && total === 2
      && at200.length === 200 && over === true && stored.includes(oldName) && stored.includes(at200) && !stored.includes(at201) && pf === 'android' ? true : { rows, noLogin, badShape, empty, long, badPlatform, nullPlatform, total, over, stored, pf };
  });

  await check('11-01(상한): 한 사람이 등록할 수 있는 기기는 10대 — 넘으면 가장 오래 전에 등록한 것부터 지워지고 최근 10대가 남음, 같은 토큰을 다시 등록하면 새것으로 침, 남의 토큰은 안 지워짐', async () => {
    const A = await join_(33, '에이'), B = await join_(34, '비');
    await register(B, T('B'));
    const letters = 'abcdefghijkl'.split('');
    for (const c of letters) await register(A, T(c));
    const afterTwelve = await tokensOf(A);
    await register(A, T('c'));      // 오래된 것을 다시 등록하면 최근 쪽으로
    await register(A, T('m'));
    const afterMore = await tokensOf(A);
    return afterTwelve.join() === sorted(...letters.slice(2).map((c) => T(c))).join()
      && afterMore.length === 10 && afterMore.includes(T('c')) && afterMore.includes(T('m')) && !afterMore.includes(T('d'))
      && (await tokensOf(B)).join() === T('B') ? true : { afterTwelve, afterMore };
  });

  await check('11-01(직접 쓰기): 앱 역할은 push_tokens에 직접 넣거나 고칠 수 없음(permission denied) — 입력 검사 · 개수 상한을 못 피함, 읽기와 지우기만 됨', async () => {
    const A = await join_(35, '에이');
    await register(A, T('n'));
    await as(A);
    const ins = await expectErr(() => q(`insert into public.push_tokens (user_id, token, platform) values ($1, 'junk', 'web')`, [A]), /permission denied for table push_tokens/);
    await su();
    await as(A);
    const upd = await expectErr(() => q(`update public.push_tokens set token = 'junk' where user_id = $1`, [A]), /permission denied for table push_tokens/);
    await su();
    await as(A);
    const seen = await q(`select token from public.push_tokens`);
    const del = await q(`delete from public.push_tokens where token = $1 returning 1`, [T('n')]);
    await su();
    return ins === true && upd === true && seen.length === 1 && del.length === 1 ? true : { ins, upd, seen, del };
  });

  await check('11-02 · 15-14: 로그아웃 때 내 토큰을 지우고(본인 행만), 남의 토큰은 읽기 · 고치기 · 지우기가 0행', async () => {
    const A = await join_(2, '에이'), B = await join_(3, '비');
    await register(A, T('e')); await register(B, T('f'));
    await as(A);
    const seen = await q(`select token from public.push_tokens`);
    await su(); await as(A);
    const updB = await expectErr(() => q(`update public.push_tokens set platform = 'ios' where token = $1`, [T('f')]), /permission denied for table push_tokens/);
    await su(); await as(A);
    const delB = await q(`delete from public.push_tokens where token = $1 returning 1`, [T('f')]);
    const delMine = await q(`delete from public.push_tokens where token = $1 returning 1`, [T('e')]);
    await su();
    const hasB = seen.some((x) => x.token === T('f'));
    return !hasB && updB === true && delB.length === 0 && delMine.length === 1 && (await tokensOf(A)).length === 0 && (await tokensOf(B)).join() === T('f') ? true : { seen, updB, delB, delMine };
  });

  await check('11-04 · 15-15: 같은 폰에서 A → B로 로그인하면 토큰 주인이 마지막 로그인 계정 B로 바뀌고(A는 0행), 폰 2대면 둘 다 받음 · 다시 등록하면 마지막 본 시각만 갱신', async () => {
    const A = await join_(4, '에이'), B = await join_(5, '비');
    await register(A, T('g'));
    await register(B, T('g'));
    const aNow = await tokensOf(A), bNow = await tokensOf(B);
    await register(B, T('h'));
    const two = await tokensOf(B);
    const [{ t1 }] = await q(`select last_seen_at as t1 from public.push_tokens where token = $1`, [T('h')]);
    await new Promise((r) => setTimeout(r, 15));
    await register(B, T('h'));
    const [{ t2 }] = await q(`select last_seen_at as t2 from public.push_tokens where token = $1`, [T('h')]);
    const same = (await tokensOf(B)).length;
    return aNow.length === 0 && bNow.join() === T('g') && two.join() === sorted(T('g'), T('h')).join() && new Date(t2).getTime() > new Date(t1).getTime() && same === 2 ? true : { aNow, bNow, two, t1, t2, same };
  });

  await check('11-06 · 11-07(DB 몫): 푸시 영수증 표 push_tickets는 서버 전용 — 앱은 읽기 · 쓰기가 막히고, 서버 역할은 넣고 지우고, 사람이 탈퇴하면 같이 지워짐', async () => {
    const A = await join_(6, '에이');
    await svc();
    await q(`insert into public.push_tickets (ticket_id, user_id, token, kind) values ('t-1', $1, $2, 'FRIEND_REQUEST')`, [A, T('i')]);
    const own = await q(`select ticket_id, kind, created_at is not null as at from public.push_tickets where user_id = $1`, [A]);
    await as(A);
    const app = await expectErr(() => q(`select * from public.push_tickets`), /permission denied/);
    const appIns = await expectErr(() => q(`insert into public.push_tickets (ticket_id, user_id, token, kind) values ('t-2', $1, $2, 'WAKE_PING')`, [A, T('j')]), /permission denied/);
    await su();
    await q(`delete from auth.users where id = $1`, [A]);
    const left = await q(`select 1 from public.push_tickets where user_id = $1`, [A]);
    return own.length === 1 && own[0].ticket_id === 't-1' && own[0].kind === 'FRIEND_REQUEST' && own[0].at === true && app === true && appIns === true && left.length === 0 ? true : { own, app, appIns, left };
  });

  // ---- 보내도 되는지 (한 사람에게) ---------------------------------------------------------

  await check('11-12 · 11-13: 친구 요청 푸시는 보낸 사람 → 받는 사람(대기 요청이 있을 때만), 수락 푸시는 수락한 사람 → 요청했던 사람(수락 1시간 안만) — 거꾸로 · 관계 없음 · 수락 뒤의 요청 푸시 · 오래된 수락 · 차단 쌍은 거절', async () => {
    const A = await join_(7, '요청자'), B = await join_(8, '받는이'), C = await join_(9, '남');
    await request(A, B);
    const pending = { reqAB: await canPush(A, B, 'FRIEND_REQUEST'), reqBA: await canPush(B, A, 'FRIEND_REQUEST'), reqAC: await canPush(A, C, 'FRIEND_REQUEST'), accBA: await canPush(B, A, 'FRIEND_ACCEPTED') };
    await accept(B, A);
    const accepted = { acc: await canPush(B, A, 'FRIEND_ACCEPTED'), accReverse: await canPush(A, B, 'FRIEND_ACCEPTED'), reqAfter: await canPush(A, B, 'FRIEND_REQUEST') };
    // 오래전에 수락된 친구(서버가 넣은 행 — 수락 시각은 서버만 정하므로 새 쌍을 직접 넣음)
    const A2 = await join_(31, '오래전요청자'), B2 = await join_(32, '오래전수락자');
    await q(`insert into public.friends (requester_id, addressee_id, status, accepted_at) values ($1, $2, 'ACCEPTED', now() - interval '2 hours')`, [A2, B2]);
    const old = await canPush(B2, A2, 'FRIEND_ACCEPTED');
    await call(A, 'public.block_user($1)', [B]);
    const blocked = { acc: await canPush(B, A, 'FRIEND_ACCEPTED'), accAB: await canPush(A, B, 'FRIEND_ACCEPTED') };
    const nulls = [await canPush(null, B, 'FRIEND_REQUEST'), await canPush(A, null, 'FRIEND_REQUEST')];
    return pending.reqAB === true && pending.reqBA === false && pending.reqAC === false && pending.accBA === false
      && accepted.acc === true && accepted.accReverse === false && accepted.reqAfter === false && old === false
      && blocked.acc === false && blocked.accAB === false && nulls.every((x) => x === false) ? true : { pending, accepted, old, blocked, nulls };
  });

  await check('11-17(DB): can_send_push는 없는 id · 탈퇴한 사람 · 권한 없는 사람 · 차단한 사람 모두 오류 없이 같은 false — 한 사람 종류 전부(서버 함수가 권한 판정을 먼저 하고 모두 같은 403을 돌려주는 바탕)', async () => {
    const A = await join_(60, '보낸이'), B = await join_(61, '없는권한'), W = await join_(62, '탈퇴'), K = await join_(63, '차단');
    await request(A, W); await accept(W, A);                          // 탈퇴하기 전에는 친구
    await q(`delete from auth.users where id = $1`, [W]);
    await befriend(A, K); await call(K, 'public.block_user($1)', [A]);
    const kinds = ['ALARM_CHANGED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'WAKE_PING'];
    const out = {};
    for (const k of kinds) out[k] = [await canPush(A, NOBODY, k), await canPush(A, W, k), await canPush(A, B, k), await canPush(A, K, k)];
    return kinds.every((k) => out[k].every((x) => x === false)) ? true : out;
  });

  await check('11-12(변형): 깨우기는 8장 전까지 거절, 모르는 종류 · 서버 전용 종류(미확인 본인)는 앱 요청으로 거절 — 대기 요청이 있어도 마찬가지', async () => {
    const A = await join_(10, '에이'), B = await join_(11, '비');
    await request(A, B);
    const r = [await canPush(A, B, 'WAKE_PING'), await canPush(A, B, 'WAKE_MISSED'), await canPush(A, B, 'GROUP_MEMBER_JOINED'), await canPush(A, B, 'SOMETHING'), await canPush(A, B, null)];
    return r.every((x) => x === false) ? true : r;
  });

  // ---- 보내도 되는지 (그룹) · 받는 사람은 서버가 고름 ------------------------------------------

  await check('11-14 · 11-15 · 11-16: 새 멤버 알림 — 받는 사람은 서버가 고름: 가입자 · 알림 끈 멤버 · 나간 사람 · 초대만 받은 사람 · 가입자와 차단 쌍인 멤버는 빠지고, 그룹 이름만 돌려줌(사람 이름 없음)', async () => {
    const J = await join_(12, '가입자'), M1 = await join_(13, '멤버1'), M2 = await join_(14, '알림끔'), M3 = await join_(15, '차단됨'), L = await join_(16, '나감'), Iv = await join_(17, '초대만');
    const g = await mkGroup(M1, [M2, M3, L, J], '푸시 확인 그룹');
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g, Iv]);
    await q(`update public.group_members set notifications_off = true where group_id = $1 and user_id = $2`, [g, M2]);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, L]);
    await call(M3, 'public.block_user($1)', [J]);
    const r = await planGroup(J, g, 'GROUP_MEMBER_JOINED');
    // 모양: 받는 사람은 id 배열, 앱이 넘긴 어떤 대상도 반영할 자리가 없음
    return r.status === 'OK' && r.group_name === '푸시 확인 그룹' && ids(r).join() === [M1].join() && Object.keys(r).sort().join() === 'appointment_title,group_name,recipients,status' && r.appointment_title === null ? true : r;
  });

  await check('11-14(조건): 새 멤버 알림은 참여 중인 보낸 사람이 들어온 지 10분 안일 때만 — 오래된 멤버 · 초대만 받은 사람 · 나간 사람 · 그룹 밖 사람 · 없는 그룹 · 모르는 종류는 모두 같은 FORBIDDEN', async () => {
    const O = await join_(18, '오래된'), N = await join_(19, '새멤버'), Iv = await join_(20, '초대만'), Lf = await join_(21, '나감'), X = await join_(22, '밖');
    const g = await mkGroup(O, [N, Lf]);
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g, Iv]);
    await q(`update public.group_members set joined_at = now() - interval '1 day' where group_id = $1 and user_id = $2`, [g, O]);
    await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [g, Lf]);
    const ok = await planGroup(N, g, 'GROUP_MEMBER_JOINED');
    await q(`update public.group_members set joined_at = now() - interval '11 minutes' where group_id = $1 and user_id = $2`, [g, N]);
    const late = await planGroup(N, g, 'GROUP_MEMBER_JOINED');
    const forbidden = [await planGroup(O, g, 'GROUP_MEMBER_JOINED'), await planGroup(Iv, g, 'GROUP_MEMBER_JOINED'), await planGroup(Lf, g, 'GROUP_MEMBER_JOINED'), await planGroup(X, g, 'GROUP_MEMBER_JOINED'),
                       await planGroup(N, NOBODY, 'GROUP_MEMBER_JOINED'), await planGroup(N, g, 'FRIEND_REQUEST'), await planGroup(N, g, null), await planGroup(null, g, 'GROUP_MEMBER_JOINED'), await planGroup(N, null, 'GROUP_MEMBER_JOINED')];
    return ok.status === 'OK' && late.status === 'FORBIDDEN' && forbidden.every((x) => x.status === 'FORBIDDEN' && Object.keys(x).join() === 'status') ? true : { ok, late, forbidden };
  });

  await check('11-15(약속): 공동 약속 변경 알림 — 그 그룹의 아직 안 지난 약속을 만든 사람이 보낼 때만(다른 그룹 약속 · 개인 일정 · 없는 약속 · 지난 약속 · 만든 사람이 아닌 멤버는 FORBIDDEN), 받는 사람은 그 약속의 참여자에서 보낸 사람 · 알림 끈 멤버 · 차단 쌍 제외, 약속 제목을 같이 돌려줌', async () => {
    const S = await join_(23, '보낸이'), M1 = await join_(24, '참여자'), M2 = await join_(25, '알림끔'), M3 = await join_(26, '차단함'), O = await join_(27, '다른그룹주인'), M4 = await join_(36, '참여안함');
    const g = await mkGroup(S, [M1, M2, M3, M4]);
    const g2 = await mkGroup(O, [], '다른 그룹');
    await q(`update public.group_members set notifications_off = true where group_id = $1 and user_id = $2`, [g, M2]);
    await call(M3, 'public.block_user($1)', [S]);
    const [{ appointment_id: ap }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '팀 회의', now() + interval '1 day', '학교') returning appointment_id`, [S, g]);
    const [{ appointment_id: ap2 }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '다른 약속', now() + interval '1 day', '학교') returning appointment_id`, [O, g2]);
    const [{ appointment_id: personal }] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '개인', now() + interval '1 day', '학교') returning appointment_id`, [S]);
    const [{ appointment_id: past }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '지난 약속', now() - interval '1 minute', '학교') returning appointment_id`, [S, g]);
    const [{ appointment_id: byM1 }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '참여자가 만든 약속', now() + interval '1 day', '학교') returning appointment_id`, [M1, g]);
    for (const [apId, users] of [[ap, [S, M1, M2, M3]], [past, [S, M1]], [byM1, [M1, S]]]) {
      for (const u of users) await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2)`, [apId, u]);
    }
    const ok = await planGroup(S, g, 'GROUP_APPT_CHANGED', ap);
    const other = await planGroup(S, g, 'GROUP_APPT_CHANGED', ap2), per = await planGroup(S, g, 'GROUP_APPT_CHANGED', personal), none = await planGroup(S, g, 'GROUP_APPT_CHANGED', NOBODY), missing = await planGroup(S, g, 'GROUP_APPT_CHANGED', null);
    const outsider = await planGroup(O, g, 'GROUP_APPT_CHANGED', ap);
    const notCreator = [await planGroup(M1, g, 'GROUP_APPT_CHANGED', ap), await planGroup(M4, g, 'GROUP_APPT_CHANGED', ap)];   // 참여자도 · 참여 안 한 멤버도 남의 약속은 못 보냄
    const pastOne = await planGroup(S, g, 'GROUP_APPT_CHANGED', past);
    const byParticipant = await planGroup(M1, g, 'GROUP_APPT_CHANGED', byM1);                                                   // 자기가 만든 약속이면 받는 사람 = 다른 참여자(S)
    const wrongKind = [await planGroup(S, g, 'FRIEND_REQUEST', ap), await planGroup(S, g, 'WAKE_PING', ap)];   // 그룹 알림 종류가 아니면 약속이 맞아도 FORBIDDEN
    return ok.status === 'OK' && ok.appointment_title === '팀 회의' && ok.group_name === '푸시그룹' && ids(ok).join() === [M1].join()
      && [other, per, none, missing, outsider, ...notCreator, pastOne, ...wrongKind].every((x) => x.status === 'FORBIDDEN')
      && byParticipant.status === 'OK' && ids(byParticipant).join() === [S].join() ? true : { ok, other, per, none, missing, outsider, notCreator, pastOne, byParticipant, wrongKind };
  });

  await check('11-12(창): 요청 푸시는 요청한 지 1시간 안(59분 O · 61분 X), 수락 푸시는 수락한 지 1시간 안(59분 O · 61분 X) — 오래된 대기 요청 · 오래된 수락으로 다시 보내지 못함', async () => {
    const A1 = await join_(37, '요청59'), B1 = await join_(38, '받음59'), A2 = await join_(39, '요청61'), B2 = await join_(40, '받음61');
    const A3 = await join_(41, '수락59'), B3 = await join_(42, '수락받음59'), A4 = await join_(43, '수락61'), B4 = await join_(44, '수락받음61');
    await q(`insert into public.friends (requester_id, addressee_id, status, requested_at) values ($1, $2, 'PENDING', now() - interval '59 minutes'), ($3, $4, 'PENDING', now() - interval '61 minutes')`, [A1, B1, A2, B2]);
    await q(`insert into public.friends (requester_id, addressee_id, status, accepted_at) values ($1, $2, 'ACCEPTED', now() - interval '59 minutes'), ($3, $4, 'ACCEPTED', now() - interval '61 minutes')`, [A3, B3, A4, B4]);
    const r = [await canPush(A1, B1, 'FRIEND_REQUEST'), await canPush(A2, B2, 'FRIEND_REQUEST'), await canPush(B3, A3, 'FRIEND_ACCEPTED'), await canPush(B4, A4, 'FRIEND_ACCEPTED')];
    return JSON.stringify(r) === JSON.stringify([true, false, true, false]) ? true : r;
  });

  await check('11-14(창): 새 멤버 알림은 들어온 지 10분 안(9분 O · 11분 X) — 1초 안만이 아님', async () => {
    const O = await join_(45, '주인'), N = await join_(46, '새멤버');
    const g = await mkGroup(O, [N]);
    await q(`update public.group_members set joined_at = now() - interval '9 minutes' where group_id = $1 and user_id = $2`, [g, N]);
    const nine = await planGroup(N, g, 'GROUP_MEMBER_JOINED');
    await q(`update public.group_members set joined_at = now() - interval '11 minutes' where group_id = $1 and user_id = $2`, [g, N]);
    const eleven = await planGroup(N, g, 'GROUP_MEMBER_JOINED');
    return nine.status === 'OK' && eleven.status === 'FORBIDDEN' ? true : { nine, eleven };
  });

  await check('11-16(바탕): 받는 사람이 아무도 안 남아도 OK(빈 배열) — 혼자인 그룹 · 모두 알림을 끈 그룹', async () => {
    const S = await join_(28, '혼자'), M = await join_(29, '알림끔');
    const solo = await mkGroup(S, []);
    const g = await mkGroup(S, [M]);
    await q(`update public.group_members set notifications_off = true where group_id = $1 and user_id = $2`, [g, M]);
    await q(`update public.group_members set joined_at = now() where group_id in ($1, $2) and user_id = $3`, [solo, g, S]);
    const a = await planGroup(S, solo, 'GROUP_MEMBER_JOINED'), b = await planGroup(S, g, 'GROUP_MEMBER_JOINED');
    return a.status === 'OK' && a.recipients.length === 0 && b.status === 'OK' && b.recipients.length === 0 ? true : { a, b };
  });

  await check('11장 실행 권한: plan_group_push · can_send_push는 서버 역할만 부를 수 있음(앱 · anon은 permission denied), 토큰 등록은 anon 거절', async () => {
    const A = await join_(30, '에이');
    await as(A);
    const app = [await expectErr(() => q(`select public.plan_group_push($1, $2, 'GROUP_MEMBER_JOINED', null)`, [A, NOBODY]), /permission denied/),
                 await expectErr(() => q(`select public.can_send_push($1, $2, 'FRIEND_REQUEST')`, [A, NOBODY]), /permission denied/)];
    await as(null, 'anon');
    const anon = [await expectErr(() => q(`select public.plan_group_push($1, $2, 'GROUP_MEMBER_JOINED', null)`, [A, NOBODY]), /permission denied/),
                  await expectErr(() => q(`select public.register_push_token($1, 'android')`, [T('k')]), /permission denied/)];
    await su();
    return app.every((x) => x === true) && anon.every((x) => x === true) ? true : { app, anon };
  });
}
