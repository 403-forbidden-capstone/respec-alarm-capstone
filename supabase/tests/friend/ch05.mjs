// 친구 5장 — 그룹 · 초대, 그룹장 없음 (친구_시험케이스.md 5장 DB 층, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호
//   이 장에 없는 것: 5-09의 GROUP_MEMBER_JOINED 푸시 · 5-42 · 5-43 · 5-50(알림, 11장), 5-04 · 5-05 · 5-06 · 5-07 · 5-30 · 5-41 · 5-46(앱)
//   진짜 동시 호출(5-32 · 5-35 · 5-39)은 PGlite로 못 겹쳐서 순서대로 부른 시험 + 잠금 확인, 겹침은 실제 Postgres 두 세션으로 따로 확인
//   사람은 이 장 전용 계정. db-check 맨 끝에서 돎
export default async function ch05({ q, as, su, check, expectErr, PGlite, AUTH_STUBS, MIG_DIR, readFileSync, readdirSync, join }) {
  const id = (n) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
  const NOBODY = '60000000-0000-4000-8000-999999999999';

  const join_ = async (n, nickname) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id(n), `f5-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    await q(`update public.profiles set onboarded_at = now(), handle = $2 where user_id = $1`, [id(n), `f5_user_${n}`]);
    return id(n);
  };
  const call = async (uid, sql, params = []) => { await as(uid); const [r] = await q(`select ${sql} as r`, params); await su(); return r.r; };
  // 앱이 하듯 직접 insert로 그룹 만들기 (만든 사람이 자동으로 JOINED)
  const mkGroup = async (owner, name = '캡스톤') => {
    await as(owner);
    const [g] = await q(`insert into public.groups (group_name, owner_id) values ($1, $2) returning group_id, invite_code`, [name, owner]);
    await su();
    return { g: g.group_id, code: g.invite_code };
  };
  const addMember = (g, u, { optIn = false, status = 'JOINED' } = {}) =>
    q(`insert into public.group_members (group_id, user_id, invite_status, joined_at, wake_share_opt_in)
       values ($1, $2, $3::public.invite_status, case when $3::text = 'JOINED' then now() end, $4)
       on conflict (group_id, user_id) do update set invite_status = excluded.invite_status`, [g, u, status, optIn]);
  const preview = (u, code) => call(u, 'public.preview_group_by_code($1)', [code]);
  const joinGroup = (u, code, share = false) => call(u, 'public.join_group($1, $2)', [code, share]);
  const accept = (u, g, share = false) => call(u, 'public.accept_group_invite($1, $2)', [g, share]);
  const inviteTo = (u, g, t) => call(u, 'public.invite_to_group($1, $2)', [g, t]);
  const regen = (u, g) => call(u, 'public.regenerate_invite_code($1)', [g]);
  const codeRow = async (g) => (await q(`select invite_code, invite_code_expires_at, owner_id from public.groups where group_id = $1`, [g]))[0] ?? null;
  const member = async (g, u) => (await q(`select invite_status::text as st, wake_share_opt_in as opt, notifications_off as off, joined_at, invited_by from public.group_members where group_id = $1 and user_id = $2`, [g, u]))[0] ?? null;
  const countJoined = async (g) => (await q(`select count(*)::int as n from public.group_members where group_id = $1 and invite_status = 'JOINED'`, [g]))[0].n;
  const leave = async (u, g) => { await as(u); const r = await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2 returning 1`, [g, u]); await su(); return r.length; };
  const clearFails = (...uids) => q(`delete from public.rate_limit_events where user_id = any($1::uuid[]) and action = 'GROUP_CODE_FAIL'`, [uids]);
  const failCount = async (u) => (await q(`select count(*)::int as n from public.rate_limit_events where user_id = $1 and action = 'GROUP_CODE_FAIL'`, [u]))[0].n;
  const befriend = async (a, b) => {
    await call(a, 'public.send_friend_request($1)', [b]);
    await call(b, 'public.accept_friend_request($1)', [a]);
    await q(`delete from public.rate_limit_events where user_id = any($1::uuid[])`, [[a, b]]);
  };
  const days = (ts) => (new Date(ts).getTime() - Date.now()) / 86400000;

  const A = await join_(1, '에이');
  const B = await join_(2, '비');
  const C = await join_(3, '씨');

  // ---- 만들기 · 이름 · 코드 ------------------------------------------------------

  await check('5-01 · 5-02: 그룹 이름 — 50자 OK(앞뒤 공백이 붙어도), 앞뒤 공백은 잘림, 같은 이름 · 이모지 허용, 51자 · 빈칸 · 공백만 거절, 설명은 200자까지', async () => {
    const N = await join_(10, '이름시험');
    const ins = async (name, desc = null) => { await as(N); const [r] = await q(`insert into public.groups (group_name, description, owner_id) values ($1, $2, $3) returning group_name`, [name, desc, N]); await su(); return r.group_name; };
    const bad = async (name, desc = null) => { await as(N); const r = await expectErr(() => q(`insert into public.groups (group_name, description, owner_id) values ($1, $2, $3)`, [name, desc, N]), /.*/); await su(); return r; };
    const r50 = await ins('가'.repeat(50));
    const r50sp = await ins(` ${'나'.repeat(50)} `);
    const trimmed = await ins('  팀플  ');
    const same1 = await ins('같은이름'), same2 = await ins('같은이름');
    const emoji = await ins('🔥캡스톤🔥');
    const d200 = await ins('설명있음', 'ㅁ'.repeat(200));
    const rejects = [await bad('다'.repeat(51)), await bad(''), await bad('   '), await bad('\t\n '), await bad('설명넘침', 'ㅁ'.repeat(201))];
    // 이름 바꾸기도 같은 검사
    const [{ group_id: g }] = await q(`select group_id from public.groups where group_name = '팀플' and owner_id = $1`, [N]);
    await as(N);
    const rename = await q(`update public.groups set group_name = '  새이름  ' where group_id = $1 returning group_name`, [g]);
    const renameBad = await expectErr(() => q(`update public.groups set group_name = '   ' where group_id = $1`, [g]), /.*/);
    await su();
    await q(`delete from public.groups where owner_id = $1`, [N]);
    return r50 === '가'.repeat(50) && r50sp === '나'.repeat(50) && trimmed === '팀플' && same1 === same2 && emoji === '🔥캡스톤🔥' && d200 === '설명있음'
      && rejects.every((x) => x === true) && rename[0].group_name === '새이름' && renameBad === true ? true : { r50: r50.length, r50sp: r50sp.length, trimmed, rejects, rename, renameBad };
  });

  await check('5-03: 만든 직후 — 만든 사람 = A(기록), A는 JOINED + 참여 일시, 코드는 헷갈리는 글자(0 O 1 I)를 뺀 8자, 만료 7일, 알림 끄기 꺼짐', async () => {
    const { g, code } = await mkGroup(A, '새그룹');
    const row = await codeRow(g);
    const m = await member(g, A);
    const nobad = !/[01OI]/.test(code);
    const d = days(row.invite_code_expires_at);
    await q(`delete from public.groups where group_id = $1`, [g]);
    return ALPHABET.test(code) && nobad && row.owner_id === A && m.st === 'JOINED' && m.joined_at !== null && m.off === false && d > 6.99 && d < 7.01 ? true : { code, row, m, d };
  });

  // ---- 코드 미리보기 · 참여 ----------------------------------------------------------

  const G = await mkGroup(A, '프리뷰');

  await check('5-08 · 5-09 · 5-10 · 5-11: 미리보기는 그룹 이름 · 인원(참여 중)만 보이고 참여는 안 시킴, 참여는 동의 선택대로(JOINED + 참여 일시), 이미 참여 중이면 그대로(ALREADY_JOINED)', async () => {
    const p = await preview(B, G.code);
    const noJoin = await member(G.g, B);
    const j1 = await joinGroup(B, G.code, true);
    const j2 = await joinGroup(C, G.code, false);
    const mB = await member(G.g, B), mC = await member(G.g, C);
    await new Promise((r) => setTimeout(r, 20));
    const again = await joinGroup(B, G.code, false);
    const mB2 = await member(G.g, B);
    const p2 = await preview(B, G.code);
    return p.status === 'FOUND' && p.group_name === '프리뷰' && p.member_count === 1 && p.full === false && p.already_joined === false && noJoin === null
      && Object.keys(p).sort().join() === 'already_joined,expires_at,full,group_name,member_count,status'
      && j1.status === 'JOINED' && j1.group_id === G.g && mB.st === 'JOINED' && mB.opt === true && mB.joined_at !== null
      && j2.status === 'JOINED' && mC.opt === false
      && again.status === 'ALREADY_JOINED' && mB2.opt === true && new Date(mB2.joined_at).getTime() === new Date(mB.joined_at).getTime()
      && p2.already_joined === true && p2.member_count === 3 ? true : { p, noJoin, j1, j2, mB, mC, again, mB2, p2 };
  });

  await check('5-12 · 5-13: 7일 지난 코드는 EXPIRED(참여 안 됨), 소문자 · 공백 섞인 입력은 맞춰서 찾고 O/0은 보정 없이 NOT_FOUND', async () => {
    const D = await join_(11, '코드입력');
    const lowerSpaced = ` ${G.code.slice(0, 4).toLowerCase()} ${G.code.slice(4).toLowerCase()} `;
    const okForm = await preview(D, lowerSpaced);
    const withO = await preview(D, 'O' + G.code.slice(1)), withZero = await preview(D, '0' + G.code.slice(1));
    await q(`update public.groups set invite_code_expires_at = now() - interval '1 minute' where group_id = $1`, [G.g]);
    const exp = await preview(D, G.code);
    const expJoin = await joinGroup(D, G.code, true);
    const none = await member(G.g, D);
    await q(`update public.groups set invite_code_expires_at = now() + interval '7 days' where group_id = $1`, [G.g]);
    await clearFails(D);
    return okForm.status === 'FOUND' && withO.status === 'NOT_FOUND' && withZero.status === 'NOT_FOUND'
      && exp.status === 'EXPIRED' && expJoin.status === 'EXPIRED' && none === null ? true : { okForm, withO, withZero, exp, expJoin, none };
  });

  await check('5-14 · 5-15 · 5-16: 틀린 코드 10번까지 기록(예외로 되돌려지지 않음) → 11번째는 LIMIT + 남은 초, 막힌 동안은 맞는 코드도 LIMIT(미리보기 · 참여 모두), 1시간 뒤 다시 됨', async () => {
    const L = await join_(12, '틀리는사람');
    const wrong = [];
    for (let i = 0; i < 9; i++) wrong.push((await preview(L, i % 2 ? 'ZZZZZZZZ' : 'abc')).status);   // 없는 코드 · 형식 밖 입력 모두 실패로 셈
    const nine = await failCount(L);
    wrong.push((await joinGroup(L, 'YYYYYYYY')).status);
    const ten = await failCount(L);
    const eleventh = await preview(L, 'XXXXXXXX');
    const rightWhileBlocked = await preview(L, G.code);
    const joinWhileBlocked = await joinGroup(L, G.code, true);
    const after = await failCount(L);
    await q(`update public.rate_limit_events set created_at = created_at - interval '61 minutes' where user_id = $1`, [L]);
    const later = await preview(L, G.code);
    await clearFails(L);
    return wrong.every((x) => x === 'NOT_FOUND') && nine === 9 && ten === 10
      && eleventh.status === 'LIMIT' && eleventh.retry_after_seconds >= 1 && eleventh.retry_after_seconds <= 3600
      && rightWhileBlocked.status === 'LIMIT' && joinWhileBlocked.status === 'LIMIT' && (await member(G.g, L)) === null && after === 10
      && later.status === 'FOUND' ? true : { wrong, nine, ten, eleventh, rightWhileBlocked, joinWhileBlocked, after, later };
  });

  await check('5-17 · 5-49: 새 코드 — 만든 사람이 아닌 멤버도 받을 수 있고(옛 코드는 바로 거절, 새 코드 7일), 코드 시트를 열 때 만료면 서버가 새 코드 + 7일로 바꿔 보여 줌(참여 중 멤버만)', async () => {
    const X = await mkGroup(A, '새코드');
    await addMember(X.g, B);
    const E = await join_(13, '코드확인');
    const fresh = await regen(B, X.g);
    const oldCode = await preview(E, X.code);
    const newCode = await preview(E, fresh);
    const d1 = days((await codeRow(X.g)).invite_code_expires_at);
    // 만료되면 시트를 여는 순간 다시 발급 (누가 열든)
    await q(`update public.groups set invite_code_expires_at = now() - interval '2 days' where group_id = $1`, [X.g]);
    const sheet = await call(B, 'public.my_group_code($1)', [X.g]);
    const stored = await codeRow(X.g);
    const sheet2 = await call(A, 'public.my_group_code($1)', [X.g]);
    const outsider = await call(E, 'public.my_group_code($1)', [X.g]);
    await as(E);
    const nonMember = await expectErr(() => q(`select public.regenerate_invite_code($1)`, [X.g]), /참여 중인 멤버만/);
    await su();
    await clearFails(E);
    return oldCode.status === 'NOT_FOUND' && newCode.status === 'FOUND' && d1 > 6.99 && d1 < 7.01
      && sheet.status === 'OK' && sheet.code !== fresh && ALPHABET.test(sheet.code) && stored.invite_code === sheet.code && days(sheet.expires_at) > 6.99
      && sheet2.code === sheet.code && outsider.status === 'NOT_FOUND' && !('code' in outsider) && nonMember === true ? true : { oldCode, newCode, d1, sheet, stored, sheet2, outsider, nonMember };
  });

  // ---- 그룹장 없음 ----------------------------------------------------------------

  await check('5-18 · 5-19 · 5-20 · 5-21: 만든 사람이 아닌 멤버도 이름 바꾸기 · 새 코드 · 초대 · 내보내기를 하고 그룹 행은 지울 수 없음 / 내보내면 코드가 바뀌고 그 사람 행 · 권한(양방향)이 지워지며 옛 코드는 거절, 새 코드로는 처음 상태로 다시 들어옴 / 스스로 나가면 코드 그대로', async () => {
    const K = await mkGroup(A, '그룹장없음');
    const Bm = await join_(14, '멤버B'), Cm = await join_(15, '멤버C'), Dm = await join_(16, '멤버D'), Ef = await join_(17, '친구E');
    await addMember(K.g, Bm, { optIn: true }); await addMember(K.g, Cm, { optIn: true }); await addMember(K.g, Dm);
    await befriend(Bm, Ef);
    await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_wake) values ($1, $2, 'GROUP', $3, true), ($2, $1, 'GROUP', $3, true)`, [A, Cm, K.g]);
    await as(Bm);
    const renamed = await q(`update public.groups set group_name = '바뀐 이름' where group_id = $1 returning group_name`, [K.g]);
    const del = await q(`delete from public.groups where group_id = $1 returning 1`, [K.g]);
    const codeEdit = await expectErr(() => q(`update public.groups set invite_code = 'AAAAAAAA' where group_id = $1`, [K.g]), /42501|새 코드|코드/);
    const ownerEdit = await expectErr(() => q(`update public.groups set owner_id = $2 where group_id = $1`, [K.g, Bm]), /42501|만든 사람|바꿀 수 없음/);
    await su();
    const oldCode = (await codeRow(K.g)).invite_code;
    const invited = await inviteTo(Bm, K.g, Ef);
    // 멤버 B가 C를 내보냄 (다른 사람 행 삭제)
    await as(Bm);
    const kicked = await q(`delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [K.g, Cm]);
    await su();
    const afterKick = await codeRow(K.g);
    const permLeft = (await q(`select count(*)::int as n from public.sharing_permissions where source_type = 'GROUP' and source_id = $1 and $2 in (owner_id, grantee_id)`, [K.g, Cm]))[0].n;
    const gone = await member(K.g, Cm);
    const oldTry = await preview(Cm, oldCode);
    const newJoin = await joinGroup(Cm, afterKick.invite_code, false);
    const fresh = await member(K.g, Cm);
    // 스스로 나가면 코드 그대로
    const before = (await codeRow(K.g)).invite_code;
    const left = await leave(Dm, K.g);
    const stay = (await codeRow(K.g)).invite_code;
    await clearFails(Cm);
    return renamed[0].group_name === '바뀐 이름' && del.length === 0 && codeEdit === true && ownerEdit === true && invited.status === 'INVITED'
      && kicked.length === 1 && afterKick.invite_code !== oldCode && gone === null && permLeft === 0
      && oldTry.status === 'NOT_FOUND' && newJoin.status === 'JOINED' && fresh.opt === false && fresh.off === false
      && left === 1 && stay === before ? true : { renamed, del, codeEdit, ownerEdit, invited, kicked, afterKick, permLeft, gone, oldTry, newJoin, fresh, left };
  });

  await check('5-22 · 5-23: 나간 사람(LEFT)은 코드로 다시 들어와도 처음 상태(동의 · 알림 끄기 처음 값, 참여 일시 새로)이고, 자기 행을 직접 JOINED로 되돌릴 수는 없음(42501) · 초대 수락 · 나가기 말고 상태를 직접 바꿀 수 없음', async () => {
    const R = await mkGroup(A, '재참여');
    const Bm = await join_(18, '나갔다옴'), Cm = await join_(19, '구경');
    await addMember(R.g, Bm, { optIn: true });
    await q(`update public.group_members set notifications_off = true where group_id = $1 and user_id = $2`, [R.g, Bm]);
    const first = await member(R.g, Bm);
    await leave(Bm, R.g);
    const lefted = await member(R.g, Bm);
    await as(Bm);
    const direct = await expectErr(() => q(`update public.group_members set invite_status = 'JOINED' where group_id = $1 and user_id = $2`, [R.g, Bm]), /42501|상태|직접/);
    await su();
    await new Promise((r) => setTimeout(r, 20));
    const back = await joinGroup(Bm, (await codeRow(R.g)).invite_code, false);
    const again = await member(R.g, Bm);
    // 다른 직접 바꾸기: 참여 중이 아닌데 초대로 되돌리기 · 초대 중에 직접 참여 · 참여 일시 바꾸기 · 참여 중 동의 / 알림 끄기는 됨
    await addMember(R.g, Cm, { status: 'INVITED' });
    await as(Cm);
    const acceptDirect = await expectErr(() => q(`update public.group_members set invite_status = 'JOINED', joined_at = now() where group_id = $1 and user_id = $2`, [R.g, Cm]), /42501|상태|직접|수락/);
    await su();
    await as(Bm);
    const toInvited = await expectErr(() => q(`update public.group_members set invite_status = 'INVITED' where group_id = $1 and user_id = $2`, [R.g, Bm]), /42501|상태|직접/);
    const joinedAt = await expectErr(() => q(`update public.group_members set joined_at = now() - interval '1 year' where group_id = $1 and user_id = $2`, [R.g, Bm]), /42501|참여 일시|직접/);
    const consent = await q(`update public.group_members set wake_share_opt_in = true, notifications_off = true where group_id = $1 and user_id = $2 returning 1`, [R.g, Bm]);
    await su();
    return first.opt === true && first.off === true && lefted.st === 'LEFT' && direct === true
      && back.status === 'JOINED' && again.st === 'JOINED' && again.opt === false && again.off === false && new Date(again.joined_at) > new Date(first.joined_at)
      && acceptDirect === true && toInvited === true && joinedAt === true && consent.length === 1 ? true : { first, lefted, direct, back, again, acceptDirect, toInvited, joinedAt, consent };
  });

  await check('5-24: 만든 사람이 탈퇴해도 멤버가 남아 있으면 그룹은 그대로(코드도 그대로), 만든 사람 칸만 비음', async () => {
    const O = await join_(20, '탈퇴할사람'), Rm = await join_(21, '남는멤버');
    const T = await mkGroup(O, '남는그룹');
    await addMember(T.g, Rm);
    await q(`delete from auth.users where id = $1`, [O]);
    const row = await codeRow(T.g);
    return row && row.invite_code === T.code && row.owner_id === null && (await member(T.g, Rm)).st === 'JOINED' && (await countJoined(T.g)) === 1 ? true : { row };
  });

  // ---- 직접 초대 -------------------------------------------------------------------

  await check('5-25 · 5-31: 직접 초대 — 초대 대기(INVITED, 초대한 사람 기록, 동의 꺼짐) → 수락하면 JOINED + 동의 선택, 두 번 눌러도 한 번, 거절(자기 행 삭제)은 조용하고 다시 초대할 수 있음, 코드로 들어오면 같은 행이 JOINED로', async () => {
    const I = await mkGroup(A, '초대그룹');
    const F1 = await join_(22, '초대받음1'), F2 = await join_(23, '초대받음2'), F3 = await join_(24, '초대받음3');
    for (const f of [F1, F2, F3]) await befriend(A, f);
    const inv1 = await inviteTo(A, I.g, F1);
    const dup = await inviteTo(A, I.g, F1);
    const row = await member(I.g, F1);
    const a1 = await accept(F1, I.g, true);
    const a2 = await accept(F1, I.g, false);
    const joined = await member(I.g, F1);
    // 거절
    await inviteTo(A, I.g, F2);
    await as(F2);
    const decl = await q(`delete from public.group_members where group_id = $1 and user_id = $2 and invite_status = 'INVITED' returning 1`, [I.g, F2]);
    await su();
    const reinv = await inviteTo(A, I.g, F2);
    // 코드 참여 = 초대 수락
    await inviteTo(A, I.g, F3);
    const byCode = await joinGroup(F3, I.code, true);
    const rows = (await q(`select count(*)::int as n from public.group_members where group_id = $1 and user_id = $2`, [I.g, F3]))[0].n;
    const cardsLeft = await call(F3, '(select count(*)::int from public.my_group_invites())');
    return inv1.status === 'INVITED' && dup.status === 'ALREADY_INVITED' && row.st === 'INVITED' && row.invited_by === A && row.opt === false && row.joined_at === null
      && a1.status === 'JOINED' && a2.status === 'ALREADY_JOINED' && joined.st === 'JOINED' && joined.opt === true
      && decl.length === 1 && reinv.status === 'INVITED' && byCode.status === 'JOINED' && rows === 1 && cardsLeft === 0 ? true : { inv1, dup, row, a1, a2, joined, decl, reinv, byCode, rows, cardsLeft };
  });

  await check('5-26 · 5-27 · 5-28: 직접 insert 초대 — 친구 사이만(친구 아님 · 차단 · 남의 친구는 거절), 멤버 누구나 자기 친구를, 멤버가 아닌 사람은 거절 / 함수로도 같은 결과(친구 아님 · 멤버 아님은 NOT_FOUND)', async () => {
    const Gx = await mkGroup(A, '초대규칙');
    const Mm = await join_(25, '멤버'), Mf = await join_(26, '멤버친구'), Af = await join_(27, '만든이친구'), St = await join_(28, '남남'), Bk = await join_(29, '차단당함'), Out = await join_(30, '밖');
    await addMember(Gx.g, Mm);
    await befriend(Mm, Mf); await befriend(A, Af);
    await call(A, 'public.block_user($1)', [Bk]);
    const ins = async (inviter, target) => {
      await as(inviter);
      const r = await expectErr(() => q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [Gx.g, target]), /row-level security/);
      await su();
      return r;
    };
    const okIns = async (inviter, target) => { const r = await inviteTo(inviter, Gx.g, target); return r.status === 'INVITED' ? (await member(Gx.g, target)).invited_by : r; };   // 초대는 함수로만 — 앱의 직접 insert 정책은 15장에서 닫힘
    const nonFriend = await ins(A, St);                 // 5-26
    const blocked = await ins(A, Bk);
    const othersFriend = await ins(Mm, Af);             // 만든 사람의 친구는 멤버 B의 친구가 아님
    const outsider = await ins(Out, Mf);                // 5-28: 멤버 아닌 사람이 남을 초대
    const f7 = await inviteTo(Mm, Gx.g, Af);            // 5-26: 만든 사람의 친구는 멤버 Mm의 친구가 아니므로 Mm은 초대 못 함 (직접 insert 정책이 닫혀 위 insert는 늘 거절되니 함수로 규칙을 봄. 만든 사람이 Af를 초대하기 전에 불러야 함)
    const memberOwn = await okIns(Mm, Mf);              // 5-27
    const creatorOwn = await okIns(A, Af);
    const f1 = await inviteTo(A, Gx.g, St), f2 = await inviteTo(A, Gx.g, Bk), f3 = await inviteTo(Out, Gx.g, Mf), f4 = await inviteTo(A, Gx.g, A), f5 = await inviteTo(A, Gx.g, Mm), f6 = await inviteTo(A, Gx.g, NOBODY);
    return nonFriend === true && blocked === true && othersFriend === true && outsider === true && memberOwn === Mm && creatorOwn === A
      && [f1, f2, f3, f6, f7].every((x) => JSON.stringify(x) === JSON.stringify({ status: 'NOT_FOUND' })) && f4.status === 'SELF' && f5.status === 'ALREADY_MEMBER' ? true : { nonFriend, blocked, othersFriend, outsider, memberOwn, creatorOwn, f1, f2, f3, f4, f5, f6 };
  });

  await check('5-29 · 5-30: 초대만 받은 사람은 그룹 표 · 멤버 목록 · 공개 프로필에서 그룹을 못 읽고(코드 포함), 받은 초대 카드로 그룹 이름 · 인원(참여 중만) · 초대한 사람만 봄', async () => {
    const P = await mkGroup(A, '초대카드');
    const Inv = await join_(31, '초대받은사람'), Mem = await join_(32, '멤버');
    await addMember(P.g, Mem, { optIn: true });
    await befriend(A, Inv);
    await inviteTo(A, P.g, Inv);
    await as(Inv);
    const groups = await q(`select * from public.groups`);
    const members = await q(`select user_id from public.group_members where group_id = $1`, [P.g]);
    const pubs = await q(`select user_id from public.get_public_profiles() where user_id <> $1`, [Inv]);
    const cards = await q(`select * from public.my_group_invites()`);
    await su();
    const mine = members.map((x) => x.user_id);
    return groups.length === 0 && mine.length === 1 && mine[0] === Inv && !pubs.some((x) => x.user_id === Mem)
      && cards.length === 1 && cards[0].group_id === P.g && cards[0].group_name === '초대카드' && cards[0].member_count === 2 && cards[0].invited_by === A && cards[0].invited_by_nickname === '에이'
      && Object.keys(cards[0]).sort().join() === 'group_id,group_name,invited_at,invited_by,invited_by_nickname,member_count' ? true : { groups, mine, pubs, cards };
  });

  // ---- 상한 · 잠금 -----------------------------------------------------------------------

  await check('5-33: 한 사람 그룹 10개 — 11번째 만들기 · 코드 참여 · 초대 수락은 거절(TOO_MANY_GROUPS), 하나 나가면 다시 됨', async () => {
    const M = await join_(33, '열개'), Oth = await join_(34, '다른주인');
    for (let i = 0; i < 10; i++) await mkGroup(M, `그룹${i}`);
    const extra = await mkGroup(Oth, '열한번째');
    await as(M);
    const create = await expectErr(() => q(`insert into public.groups (group_name, owner_id) values ('초과', $1)`, [M]), /10개|54000|그룹/);
    await su();
    const byCode = await joinGroup(M, extra.code, false);
    await befriend(Oth, M);
    await inviteTo(Oth, extra.g, M);
    const byInvite = await accept(M, extra.g, false);
    const [{ group_id: one }] = await q(`select group_id from public.groups where owner_id = $1 limit 1`, [M]);
    await leave(M, one);
    const retry = await joinGroup(M, extra.code, false);
    return create === true && byCode.status === 'TOO_MANY_GROUPS' && byInvite.status === 'TOO_MANY_GROUPS' && retry.status === 'JOINED' ? true : { create, byCode, byInvite, retry };
  });

  await check('5-34 · 5-35: 한 그룹 20명 — 21번째 코드 참여 · 초대 수락은 FULL, 미리보기에 full, 19명일 때 두 명이 차례로 오면 한 명만 들어오고, 참여 중이 아닌 초대 · 나간 사람은 인원에 안 셈', async () => {
    const Hx = await mkGroup(A, '스무명');
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email) select ('61000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'f5-bulk-' || g || '@example.com' from generate_series(1, 17) g`);
    await su();
    await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at)
             select $1, u.id, 'JOINED', now() from auth.users u where u.email like 'f5-bulk-%'`, [Hx.g]);
    await addMember(Hx.g, B);                  // 만든 사람 + 17 + B = 19
    const n19 = await countJoined(Hx.g);
    const Q1 = await join_(35, '스무번째후보'), Q2 = await join_(36, '스물한번째후보'), Q3 = await join_(37, '초대후보');
    await addMember(Hx.g, Q3, { status: 'INVITED' });   // 초대 중은 인원에 안 셈
    const full0 = await preview(Q1, Hx.code);
    const j1 = await joinGroup(Q1, Hx.code, false);
    const full1 = await preview(Q2, Hx.code);
    const j2 = await joinGroup(Q2, Hx.code, false);
    const acc = await accept(Q3, Hx.g, false);
    const n = await countJoined(Hx.g);
    await q(`delete from auth.users where email like 'f5-bulk-%'`);
    return n19 === 19 && full0.full === false && j1.status === 'JOINED' && full1.status === 'FOUND' && full1.full === true && j2.status === 'FULL' && acc.status === 'FULL' && n === 20
      && (await member(Hx.g, Q2)) === null ? true : { n19, full0, j1, full1, j2, acc, n };
  });

  await check('5-32 · 5-35(바탕): 같은 그룹 · 같은 사람에게 거는 잠금이 있어 참여가 한 줄씩 — 한 사람이 두 번 참여해도 행 1개, 참여 함수가 그룹 잠금을 건 채로 인원을 셈', async () => {
    const Jx = await mkGroup(A, '한줄씩');
    const U = await join_(38, '두기기');
    const r1 = await joinGroup(U, Jx.code, false), r2 = await joinGroup(U, Jx.code, true);
    const n = (await q(`select count(*)::int as n from public.group_members where group_id = $1 and user_id = $2`, [Jx.g, U]))[0].n;
    // 잠금 확인: 한 트랜잭션 안에서 join_group을 부르고 쥔 잠금 수를 셈 (그룹 하나 + 사람 하나 이상)
    await q(`create function pg_temp.f5_locks(uid uuid, code text) returns integer language plpgsql as $$
             declare n integer;
             begin
               perform set_config('request.jwt.claim.sub', uid::text, true);
               perform public.join_group(code, false);
               select count(*)::integer into n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid();
               return n;
             end $$`);
    const U2 = await join_(39, '잠금확인');
    const [{ n: locks }] = await q(`select pg_temp.f5_locks($1, $2) as n`, [U2, Jx.code]);
    return r1.status === 'JOINED' && r2.status === 'ALREADY_JOINED' && n === 1 && locks >= 2 ? true : { r1, r2, n, locks };
  });

  // ---- 마지막 멤버 나감 · 나갈 때 정리 ------------------------------------------------------

  await check('5-48 · 5-39: 참여 중 멤버 3명이 한 명씩 나가면 첫째 · 둘째까지는 그룹 유지, 셋째(마지막)가 나가면 그룹이 지워짐 — 둘이 연달아 나가도 남지 않음', async () => {
    const Lx = await mkGroup(A, '하나씩나감');
    const L2 = await join_(40, '둘째'), L3 = await join_(41, '셋째');
    await addMember(Lx.g, L2); await addMember(Lx.g, L3);
    await leave(L2, Lx.g);
    const after1 = await codeRow(Lx.g);
    await leave(L3, Lx.g);
    const after2 = await codeRow(Lx.g);
    await leave(A, Lx.g);
    const after3 = await codeRow(Lx.g);
    const rows = (await q(`select count(*)::int as n from public.group_members where group_id = $1`, [Lx.g]))[0].n;
    // 두 명이 연달아
    const Ly = await mkGroup(A, '둘이나감');
    await addMember(Ly.g, L2);
    await leave(A, Ly.g);
    const mid = await codeRow(Ly.g);
    await leave(L2, Ly.g);
    const end = await codeRow(Ly.g);
    return after1 !== null && after2 !== null && after3 === null && rows === 0 && mid !== null && end === null ? true : { after1: !!after1, after2: !!after2, after3, rows, mid: !!mid, end };
  });

  await check('5-44 · 5-47: 마지막 참여 멤버가 나가면 그룹 · 그 그룹 공동 약속 · 참여 · 알람 · 초대 · 코드가 지워지고(초대만 받은 사람의 초대도) 각자 지난 기상 기록(daily_records)은 남음', async () => {
    const Z = await join_(42, '마지막'), Z2 = await join_(43, '먼저나간'), Zi = await join_(44, '초대만');
    const Mx = await mkGroup(Z, '사라질그룹');
    await addMember(Mx.g, Z2); await addMember(Mx.g, Zi, { status: 'INVITED' });
    const [{ appointment_id: ap }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '약속', now() + interval '1 day', '학교') returning appointment_id`, [Z, Mx.g]);
    for (const u of [Z, Z2]) {
      const [{ participant_id: pt }] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, u]);
      await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', now() + interval '20 hours')`, [pt, u]);
      await q(`insert into public.daily_records (user_id, record_date, wake_confirmed_at) values ($1, current_date - 3, now() - interval '3 days')`, [u]);
    }
    await leave(Z2, Mx.g);
    const mid = { g: await codeRow(Mx.g), p: (await q(`select count(*)::int as n from public.appointment_participants where appointment_id = $1`, [ap]))[0].n };
    await leave(Z, Mx.g);
    const left = {
      g: await codeRow(Mx.g),
      ap: (await q(`select count(*)::int as n from public.appointments where appointment_id = $1`, [ap]))[0].n,
      pt: (await q(`select count(*)::int as n from public.appointment_participants where appointment_id = $1`, [ap]))[0].n,
      al: (await q(`select count(*)::int as n from public.alarms where user_id = any($1::uuid[])`, [[Z, Z2]]))[0].n,
      gm: (await q(`select count(*)::int as n from public.group_members where group_id = $1`, [Mx.g]))[0].n,
      dr: (await q(`select count(*)::int as n from public.daily_records where user_id = any($1::uuid[])`, [[Z, Z2]]))[0].n,
      card: (await call(Zi, '(select count(*)::int from public.my_group_invites())')),
    };
    return mid.g !== null && mid.p === 1 && left.g === null && left.ap === 0 && left.pt === 0 && left.al === 0 && left.gm === 0 && left.dr === 2 && left.card === 0 ? true : { mid, left };
  });

  await check('9-파(5장 몫) · 4-17(DB 몫): 나가거나 내보내지면 그 그룹 공동 약속의 내 참여 · 알람이 지워지고 다른 사람 것은 그대로, 같은 그룹이 아닌 약속은 그대로', async () => {
    const Wx = await mkGroup(A, '약속정리');
    const W2 = await join_(45, '나가는사람'), W3 = await join_(46, '내보낼사람');
    await addMember(Wx.g, W2); await addMember(Wx.g, W3);
    const [{ appointment_id: ap }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values ($1, $2, '공동', now() + interval '1 day', '학교') returning appointment_id`, [A, Wx.g]);
    const [{ appointment_id: own }] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '개인', now() + interval '1 day', '집') returning appointment_id`, [W2]);
    const pt = {};
    for (const [k, u, a] of [['A', A, ap], ['W2', W2, ap], ['W3', W3, ap], ['own', W2, own]]) {
      const [{ participant_id }] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [a, u]);
      await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', now() + interval '20 hours')`, [participant_id, u]);
      pt[k] = participant_id;
    }
    await leave(W2, Wx.g);
    await as(A);
    await q(`delete from public.group_members where group_id = $1 and user_id = $2`, [Wx.g, W3]);
    await su();
    const left = async (k) => (await q(`select count(*)::int as n from public.appointment_participants where participant_id = $1`, [pt[k]]))[0].n;
    const alarms = async (k) => (await q(`select count(*)::int as n from public.alarms where participant_id = $1`, [pt[k]]))[0].n;
    return (await left('W2')) === 0 && (await alarms('W2')) === 0 && (await left('W3')) === 0 && (await alarms('W3')) === 0
      && (await left('A')) === 1 && (await alarms('A')) === 1 && (await left('own')) === 1 && (await alarms('own')) === 1 ? true : { w2: await left('W2'), w3: await left('W3'), a: await left('A'), own: await left('own') };
  });

  // ---- 옛 코드 · 마이그레이션 ---------------------------------------------------------------

  await check('5-52: 마이그레이션 전부터 있던 그룹의 옛 16진수 코드는 마이그레이션 시각 + 7일까지 받고 그 뒤엔 만료 문구, 기존 그룹 이름 앞뒤 공백은 정리 · 빈 이름은 채움', async () => {
    const staged = new PGlite();
    try {
      await staged.exec(AUTH_STUBS);
      const files = readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort();
      const i = files.findIndex((x) => x.endsWith('_friend_groups.sql'));
      if (i < 0) return '_friend_groups.sql 마이그레이션이 없음';
      for (const f of files.slice(0, i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
      const sq = async (sql, params = []) => (await staged.query(sql, params)).rows;
      const u = (n) => id(200 + n);
      for (let n = 1; n <= 3; n++) await sq(`insert into auth.users (id, email) values ($1, $2)`, [u(n), `f5-old-${n}@example.com`]);
      await sq(`insert into public.groups (group_name, owner_id) values ('  옛 그룹  ', $1), ('   ', $1)`, [u(1)]);
      const [{ invite_code: oldCode }] = await sq(`select invite_code from public.groups where group_name = '  옛 그룹  '`);
      for (const f of files.slice(i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
      const names = (await sq(`select group_name from public.groups order by created_at, group_name`)).map((x) => x.group_name);
      const [{ d }] = await sq(`select extract(epoch from (invite_code_expires_at - now())) / 86400 as d from public.groups where invite_code = $1`, [oldCode]);
      await sq(`select set_config('request.jwt.claim.sub', $1, false)`, [u(2)]);
      const inTime = (await sq(`select public.join_group($1, false) as r`, [oldCode]))[0].r;
      await sq(`update public.groups set invite_code_expires_at = now() - interval '1 minute' where invite_code = $1`, [oldCode]);
      await sq(`select set_config('request.jwt.claim.sub', $1, false)`, [u(3)]);
      const late = (await sq(`select public.join_group($1, false) as r`, [oldCode]))[0].r;
      return /^[0-9A-F]{8}$/.test(oldCode) && Number(d) > 6.99 && Number(d) < 7.01 && inTime.status === 'JOINED' && late.status === 'EXPIRED'
        && names.includes('옛 그룹') && names.every((x) => x === x.trim() && x.length >= 1) ? true : { oldCode, d, inTime, late, names };
    } finally {
      await staged.close();
    }
  });

  // ---- 리뷰 고침(#387 1번째 리뷰) -------------------------------------------------------

  await check('5-19(리뷰 1): 만든 사람의 "방금 만든" 읽기 예외는 만든 같은 트랜잭션뿐 — created_at을 바꾸거나 만들 때 미래로 지정해도 영구가 안 되고, 내보내진 · 스스로 나간 만든 사람은 그룹(새 코드)을 못 읽음', async () => {
    const O = await join_(50, '만든사람'), M = await join_(51, '남은멤버');
    const K = await mkGroup(O, '예외');
    await addMember(K.g, M);
    await as(O);
    const forge = await expectErr(() => q(`update public.groups set created_at = '2999-01-01' where group_id = $1`, [K.g]), /바꿀 수 없음/);
    const [mk] = await q(`insert into public.groups (group_name, owner_id, created_at) values ('미래', $1, '2999-01-01') returning created_at < now() + interval '1 day' as ok`, [O]);
    await su();
    await as(M);
    const kicked = await q(`delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [K.g, O]);
    await su();
    await as(O);
    const readAfterKick = await q(`select invite_code from public.groups where group_id = $1`, [K.g]);
    await su();
    // 스스로 나간 경우
    const K2 = await mkGroup(O, '스스로나감');
    await addMember(K2.g, M);
    await leave(O, K2.g);
    await as(O);
    const readAfterLeave = await q(`select invite_code from public.groups where group_id = $1`, [K2.g]);
    await su();
    await q(`delete from public.groups where owner_id = $1`, [O]);
    return forge === true && mk.ok === true && kicked.length === 1 && readAfterKick.length === 0 && readAfterLeave.length === 0 ? true : { forge, mk, kicked, readAfterKick, readAfterLeave };
  });

  await check('5-35(리뷰 3 · 바탕): 참여 · 수락은 그룹 잠금과 사람 잠금을, 앱이 직접 그룹을 만드는 길은 만드는 사람 잠금을 건 채로 일함 — 열쇠 이름까지 확인(10개 상한이 겹쳐도 넘지 않게)', async () => {
    const O = await join_(52, '잠금주인'), Iv = await join_(53, '초대받음'), J = await join_(54, '코드참여'), W = await join_(55, '만드는이');
    const K = await mkGroup(O, '잠금');
    await befriend(O, Iv);
    await inviteTo(O, K.g, Iv);
    await q(`create function pg_temp.f5_held(uid uuid, op text, arg text, keys text[]) returns integer language plpgsql as $$
             declare n integer;
             begin
               perform set_config('request.jwt.claim.sub', uid::text, true);
               if op = 'join' then
                 perform public.join_group(arg, false);
               elsif op = 'accept' then
                 perform public.accept_group_invite(arg::uuid, false);
               else
                 set local role authenticated;
                 insert into public.groups (group_name, owner_id) values ('잠금확인', uid);
               end if;
               select count(*)::integer into n
               from unnest(keys) as k
               join pg_locks l on l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 1
                              and l.classid = ((hashtextextended(k, 0) >> 32) & 4294967295)::bigint::oid
                              and l.objid = (hashtextextended(k, 0) & 4294967295)::bigint::oid;
               return n;
             end $$`);
    const held = async (uid, op, arg, keys) => (await q(`select pg_temp.f5_held($1, $2, $3, $4::text[]) as n`, [uid, op, arg, keys]))[0].n;
    const joinHeld = await held(J, 'join', K.code, [`group:${K.g}`, `group_user:${J}`]);
    const acceptHeld = await held(Iv, 'accept', K.g, [`group:${K.g}`, `group_user:${Iv}`]);
    const insertHeld = await held(W, 'insert', '', [`group_user:${W}`]);
    return joinHeld === 2 && acceptHeld === 2 && insertHeld === 1 ? true : { joinHeld, acceptHeld, insertHeld };
  });

  await check('5-39(리뷰 2 · 바탕): 마지막 멤버가 나가는 일과 겹쳐도 수락 · 참여가 가짜 성공을 못 내게 그룹 행을 키 공유로 잡고 다시 확인함 — 두 함수 모두 (실제 두 세션 겹침은 PGlite로 못 해서 손으로 확인)', async () => {
    const defs = await q(`select p.proname, pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname in ('join_group', 'accept_group_invite') order by 1`);
    return defs.length === 2 && defs.every((x) => /for key share/i.test(x.d)) ? true : defs.map((x) => [x.proname, /for key share/i.test(x.d)]);
  });

  await check('5-마 · 5-d6(리뷰 4): 정책 · 가드 분기 — 비멤버는 이름을 못 바꾸고(0행) 남의 멤버 행을 못 지우고, 친구여도 비멤버는 초대를 못 넣고, 초대 행의 기록(초대한 사람 · 알림 끄기)은 서버가 정하고, 참여 일시 · 동의를 미리 넣을 수 없고, 초대 · 나간 상태에서는 동의 · 알림 끄기를 못 바꾸고, 코드는 직접 지정 · 만료 변경이 안 됨', async () => {
    const O = await join_(56, '멤버'), F = await join_(57, '친구'), X = await join_(58, '비멤버'), Y = await join_(59, '다른친구'), F2 = await join_(64, '친구2');
    const K = await mkGroup(O, '분기');
    await befriend(O, F); await befriend(O, F2); await befriend(X, Y);
    // (a) 비멤버 수정 · (b) 비멤버 삭제 · (d) 비멤버 초대
    await as(X);
    const rename = await q(`update public.groups set group_name = '뺏김' where group_id = $1 returning 1`, [K.g]);
    const kick = await q(`delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [K.g, O]);
    const outsiderInvite = await expectErr(() => q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [K.g, Y]), /row-level security/);
    await su();
    // 멤버의 초대 행: 위조한 초대한 사람 · 알림 끄기는 서버 값으로
    await as(O);
    await q(`select public.invite_to_group($1, $2)`, [K.g, F]);        // 초대 행의 기록(초대한 사람 · 알림 끄기)은 함수가 정함 — 직접 insert 정책은 15장에서 닫힘
    const preJoin = await expectErr(() => q(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'INVITED', now())`, [K.g, F2]), /row-level security/);
    const preOpt = await expectErr(() => q(`insert into public.group_members (group_id, user_id, invite_status, wake_share_opt_in) values ($1, $2, 'INVITED', true)`, [K.g, F2]), /row-level security/);
    await su();
    const inv = await member(K.g, F);
    // 초대받은 상태에서 동의 · 알림 끄기 · 초대 기록 바꾸기는 거절
    await as(F);
    const optInvited = await expectErr(() => q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [K.g, F]), /참여 중일 때만/);
    const offInvited = await expectErr(() => q(`update public.group_members set notifications_off = true where group_id = $1 and user_id = $2`, [K.g, F]), /참여 중일 때만/);
    const byInvited = await expectErr(() => q(`update public.group_members set invited_by = $3 where group_id = $1 and user_id = $2`, [K.g, F, Y]), /초대 기록/);
    await su();
    const acc = await accept(F, K.g, false);
    const joined = await member(K.g, F);
    await leave(F, K.g);
    await as(F);
    const optLeft = await expectErr(() => q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [K.g, F]), /참여 중일 때만/);
    await su();
    // 코드 직접 지정 · 만료 변경
    await as(O);
    const [mine] = await q(`insert into public.groups (group_name, owner_id, invite_code) values ('코드지정', $1, 'AAAAAAAA') returning invite_code, invite_code_expires_at > now() + interval '6 days' as week`, [O]);
    const expEdit = await expectErr(() => q(`update public.groups set invite_code_expires_at = now() + interval '99 days' where group_id = $1`, [K.g]), /새 코드 함수로만/);
    await su();
    await q(`delete from public.groups where group_name = '코드지정' and owner_id = $1`, [O]);
    return rename.length === 0 && kick.length === 0 && outsiderInvite === true
      && inv.st === 'INVITED' && inv.off === false && inv.invited_by === O && preJoin === true && preOpt === true
      && optInvited === true && offInvited === true && byInvited === true
      && acc.status === 'JOINED' && joined.joined_at !== null && optLeft === true
      && mine.invite_code !== 'AAAAAAAA' && mine.week === true && expEdit === true
      ? true : { rename, kick, outsiderInvite, inv, preJoin, preOpt, optInvited, offInvited, byInvited, acc, joined, optLeft, mine, expEdit };
  });

  await check('4-17 · 4-20(5장 몫): 차단한 사이여도 같은 그룹 멤버 누구나 상대를 내보낼 수 있고(행이 지워짐), 제3자가 차단 쌍의 한쪽을 직접 초대하면 막지 않아 수락하면 참여 중이 됨', async () => {
    const P = await join_(60, '차단함'), Q = await join_(61, '차단당함'), R = await join_(62, '제삼자'), S = await join_(63, '초대될사람');
    const K = await mkGroup(P, '차단그룹');
    await addMember(K.g, Q); await addMember(K.g, R);
    await call(P, 'public.block_user($1)', [Q]);
    await befriend(R, S);
    await call(P, 'public.block_user($1)', [S]);
    // 4-17: 차단당한 Q가 차단한 P를 내보냄
    await as(Q);
    const kickedP = await q(`delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [K.g, P]);
    await su();
    // 4-20: P가 S를 차단했는데 R이 S를 P의 옛 그룹에 초대 (P는 나갔지만 그룹은 R · Q가 남아 있음)
    const inv = await inviteTo(R, K.g, S);
    const acc = await accept(S, K.g, false);
    return kickedP.length === 1 && (await member(K.g, P)) === null && inv.status === 'INVITED' && acc.status === 'JOINED' && (await member(K.g, S)).st === 'JOINED' ? true : { kickedP, inv, acc };
  });

  await check('5장 함수: 로그인 정보가 없으면 42501(내 초대 · 코드 시트는 빈 결과), anon은 실행 권한 없음, 판정 보조 함수는 앱이 직접 못 부름', async () => {
    await as(null);
    const errs = [];
    for (const sql of [`select public.preview_group_by_code('ABCDEFGH')`, `select public.join_group('ABCDEFGH', false)`, `select public.accept_group_invite('${NOBODY}', false)`,
                       `select public.invite_to_group('${NOBODY}', '${NOBODY}')`, `select public.regenerate_invite_code('${NOBODY}')`, `select public.my_group_code('${NOBODY}')`]) {
      errs.push(await expectErr(() => q(sql), /로그인이 필요함/));
    }
    const invites = await q(`select * from public.my_group_invites()`);
    await as(null, 'anon');
    const anon = await expectErr(() => q(`select public.join_group('ABCDEFGH', false)`), /permission denied/);
    await as(A);
    const helper = await expectErr(() => q(`select private.group_member_count('${NOBODY}')`), /permission denied/);
    await su();
    return errs.every((x) => x === true) && invites.length === 0 && anon === true && helper === true ? true : { errs, invites, anon, helper };
  });

  // ---- 탐색 시험 X-PRIV-01: 차단하면 차단 쌍의 그룹 초대 카드가 사라짐 --------------------------------

  await check('X-PRIV-01: 차단하면 둘 사이의 대기 중인 그룹 초대가 정리되고(어느 쪽이 차단해도), 정리 전 남은 행이 있어도 받은 초대 목록에는 차단 쌍이 보낸 카드가 안 나옴 — 제삼자가 보낸 초대 · 이미 들어간 그룹은 그대로', async () => {
    const Ba = await join_(70, '차단하는이'), Bb = await join_(71, '초대한이'), Bc = await join_(72, '제삼자'), Bd = await join_(73, '초대받은이'), Be = await join_(74, '남은행');
    const G1 = await mkGroup(Bb, '차단초대1'), G2 = await mkGroup(Bc, '제삼자초대'), G3 = await mkGroup(Ba, '내그룹'), G4 = await mkGroup(Bb, '같이있는그룹');
    for (const u of [Bb, Bc, Bd]) await befriend(Ba, u);
    await addMember(G4.g, Ba);
    await inviteTo(Bb, G1.g, Ba); await inviteTo(Bc, G2.g, Ba); await inviteTo(Ba, G3.g, Bd);
    const cards = async (u) => { await as(u); const r = await q(`select group_id from public.my_group_invites() order by group_name`); await su(); return r.map((x) => x.group_id); };
    const before = await cards(Ba), beforeD = await cards(Bd);
    await call(Ba, 'public.block_user($1)', [Bb]);                      // 차단한 사람 Ba의 카드(초대한 사람 Bb)
    await call(Ba, 'public.block_user($1)', [Bd]);                      // 차단한 사람이 초대한 쪽(Ba → Bd)
    const after = await cards(Ba), afterD = await cards(Bd);
    const rowsLeft = await q(`select group_id, user_id from public.group_members where invite_status = 'INVITED' and group_id = any($1::uuid[])`, [[G1.g, G2.g, G3.g]]);
    const stillJoined = await member(G4.g, Ba);
    // 정리 전부터 남아 있던 행처럼 목록 쪽 걸러내기만 따로 봄: 차단 뒤에 직접 끼워 넣은 대기 초대
    await call(Be, 'public.block_user($1)', [Bd]);
    await q(`insert into public.group_members (group_id, user_id, invite_status, invited_by) values ($1, $2, 'INVITED', $3)`, [G3.g, Be, Bd]);
    const stale = await cards(Be);
    return before.length === 2 && beforeD.length === 1 && after.length === 1 && after[0] === G2.g && afterD.length === 0
      && rowsLeft.length === 1 && rowsLeft[0].group_id === G2.g && rowsLeft[0].user_id === Ba && stillJoined?.st === 'JOINED' && stale.length === 0 ? true : { before, beforeD, after, afterD, rowsLeft, stillJoined, stale };
  });

  // ---- 탐색 시험 X-STATE-01: 차단한 사이가 보낸 초대는 수락할 수 없음 --------------------------------------

  await check('X-STATE-01: 친구를 끊고 차단한 뒤에는 차단 전에 받은 그룹 초대를 수락할 수 없음(GONE, 정리 전부터 남은 행도 그 자리에서 지워짐) — 제삼자가 보낸 초대는 그대로 수락됨', async () => {
    const Sa = await join_(75, '초대받은이'), Sb = await join_(76, '초대한이'), Sc = await join_(77, '제삼자');
    const G1 = await mkGroup(Sb, '차단된초대'), G2 = await mkGroup(Sc, '제삼자초대');
    await befriend(Sa, Sb); await befriend(Sa, Sc);
    await inviteTo(Sb, G1.g, Sa); await inviteTo(Sc, G2.g, Sa);
    await call(Sa, 'public.block_user($1)', [Sb]);                      // 친구 끊김 + 차단 — 대기 초대도 같이 지워짐
    const afterBlock = await member(G1.g, Sa);
    await q(`insert into public.group_members (group_id, user_id, invite_status, invited_by) values ($1, $2, 'INVITED', $3)`, [G1.g, Sa, Sb]);   // 정리 전부터 남아 있던 행처럼
    const blocked = await accept(Sa, G1.g);
    const afterAccept = await member(G1.g, Sa);
    const third = await accept(Sa, G2.g);
    return afterBlock === null && blocked.status === 'GONE' && afterAccept === null && third.status === 'JOINED' && (await member(G2.g, Sa)).st === 'JOINED' ? true : { afterBlock, blocked, afterAccept, third };
  });
}
