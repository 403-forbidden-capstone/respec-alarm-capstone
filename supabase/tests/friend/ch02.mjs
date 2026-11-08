// 친구 2장 — 아이디 · 친구 찾기 (친구_시험케이스.md 2장 DB · 함수 층, 11/8 확정)
//   항목 이름 앞 번호 = 시험케이스 번호. 함수 층(2-34)은 서버 함수 없이 앱이 DB 함수를 바로 부르므로 DB에서 확인
//   사람은 이 장 전용 계정(앞 검사의 A~E와 안 섞임). 이 장 끝에 아무것도 되돌리지 않아도 됨(db-check 맨 끝에서 돎)
export default async function ch02({ q, as, su, check, expectErr, PGlite, AUTH_STUBS, MIG_DIR, readFileSync, readdirSync, join }) {
  const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const HANDLE_RE = /^respec_[a-z0-9]{4}$/;

  // 가입 — auth.users에 넣으면 가입 트리거가 프로필 + 자동 아이디를 만듦. onboarded면 온보딩을 끝낸 상태로
  const join_ = async (n, nickname, { onboarded = true } = {}) => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
      [id(n), `f2-${n}@example.com`, JSON.stringify({ name: nickname })]);
    await su();
    if (onboarded) await q(`update public.profiles set onboarded_at = now() where user_id = $1`, [id(n)]);
    return id(n);
  };
  const handleOf = async (uid) => (await q(`select handle from public.profiles where user_id = $1`, [uid]))[0]?.handle;
  const setHandle = (uid, h) => q(`update public.profiles set handle = $2 where user_id = $1`, [uid, h]);   // 슈퍼유저로 바로
  // 바꾸기 시도도 검색과 같은 횟수에 세므로(2-53) 보통은 부르기 전에 내 기록을 지워 여러 번 불러도 걸리지 않게 함. 횟수를 시험하는 곳만 keep
  const change = async (uid, h, { keep = false } = {}) => {
    if (!keep) await q(`delete from public.rate_limit_events where user_id = $1`, [uid]);
    await as(uid); const [r] = await q(`select public.change_my_handle($1) as r`, [h]); await su(); return r.r;
  };
  const search = async (uid, s) => { await as(uid); const [r] = await q(`select public.search_by_handle($1) as r`, [s]); await su(); return r.r; };
  const byName = async (uid, s) => { await as(uid); const r = await q(`select * from public.search_related_by_name($1)`, [s]); await su(); return r; };
  const myLink = async (uid, renew = false) => { await as(uid); const [r] = await q(`select public.my_friend_link($1) as r`, [renew]); await su(); return r.r; };
  const openLink = async (uid, t) => { await as(uid); const [r] = await q(`select public.open_friend_link($1) as r`, [t]); await su(); return r.r; };
  const clearSearches = (uid) => q(`delete from public.rate_limit_events where user_id = $1`, [uid]);

  // ---- 자동 아이디 ---------------------------------------------------------

  await check('2-01 · 2-45: 새 계정 100개 — 아이디가 모두 respec_ + 소문자 · 숫자 4자(길이 11)이고 겹침 없음', async () => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email) select gen_random_uuid(), 'f2-bulk-' || g || '@example.com' from generate_series(1, 100) g`);
    await su();
    const r = await q(`select p.handle from public.profiles p join auth.users u on u.id = p.user_id where u.email like 'f2-bulk-%'`);
    const bad = r.filter((x) => !HANDLE_RE.test(x.handle) || x.handle.length !== 11);
    const distinct = new Set(r.map((x) => x.handle)).size;
    await q(`delete from auth.users where email like 'f2-bulk-%'`);
    return r.length === 100 && bad.length === 0 && distinct === 100 ? true : { n: r.length, bad, distinct };
  });

  await check('2-02 · 2-24: 생성기가 이미 쓰는 값을 내면 다시 만들어 다른 값 (동시 가입도 유일 색인이 한 명만 받고 나머지는 다시)', async () => {
    // 생성기를 잠깐 바꿔 처음 두 번은 같은 값을 냄 — 순번은 시퀀스(실패한 시도에서도 되돌아가지 않음)
    const [{ def }] = await q(`select pg_get_functiondef('private.auto_handle()'::regprocedure) as def`);
    await q(`create schema f2test`);
    await q(`create sequence f2test.n`);
    await q(`create or replace function private.auto_handle() returns text language plpgsql volatile set search_path = '' as $$
             begin
               if nextval('f2test.n') <= 2 then return 'respec_dupe'; end if;
               return 'respec_' || private.random_code(4, 'abcdefghijklmnopqrstuvwxyz0123456789');
             end $$`);
    try {
      const u1 = await join_(2, '첫째');
      const u2 = await join_(3, '둘째');
      const [h1, h2] = [await handleOf(u1), await handleOf(u2)];
      const [{ n }] = await q(`select last_value as n from f2test.n`);
      return h1 === 'respec_dupe' && h2 !== 'respec_dupe' && HANDLE_RE.test(h2) && Number(n) === 3 ? true : { h1, h2, n };
    } finally {
      await q(def);
      await q(`drop schema f2test cascade`);
    }
  });

  await check('2-23: 마이그레이션 전에 아이디가 비어 있던 계정은 자동 아이디로 채워지고(있던 아이디는 그대로) 빈 아이디 0 · 앞뒤 공백 닉네임은 정리', async () => {
    const staged = new PGlite();
    try {
      await staged.exec(AUTH_STUBS);
      const files = readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort();
      const i = files.findIndex((x) => x.endsWith('_friend_handle_search.sql'));
      if (i < 0) return '_friend_handle_search.sql 마이그레이션이 없음';
      for (const f of files.slice(0, i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
      const sq = async (sql, params = []) => (await staged.query(sql, params)).rows;
      await sq(`insert into auth.users (id, email, raw_user_meta_data) values
                ($1, 'old1@example.com', '{}'), ($2, 'old2@example.com', '{}'), ($3, 'old3@example.com', '{}')`, [id(31), id(32), id(33)]);
      await sq(`update public.profiles set handle = 'kept_one' where user_id = $1`, [id(31)]);
      await sq(`update public.profiles set nickname = '  공백  ' where user_id = $1`, [id(32)]);
      await sq(`update public.profiles set nickname = '   ' where user_id = $1`, [id(33)]);
      for (const f of files.slice(i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
      const r = await sq(`select user_id, handle, nickname, handle_changed_at from public.profiles order by user_id`);
      const m = Object.fromEntries(r.map((x) => [x.user_id, x]));
      const [nn] = await sq(`select count(*)::int as n from public.profiles where handle is null`);
      return m[id(31)].handle === 'kept_one' && HANDLE_RE.test(m[id(32)].handle) && HANDLE_RE.test(m[id(33)].handle)
        && m[id(32)].handle !== m[id(33)].handle && r.every((x) => x.handle_changed_at === null)
        && m[id(32)].nickname === '공백' && m[id(33)].nickname === '사용자' && nn.n === 0
        ? true : { r, nn };
    } finally {
      await staged.close();
    }
  });

  await check('2-28(가입 몫): OAuth 이름이 탭 · 줄바꿈뿐이면 가입이 실패하지 않고 다음 후보(이메일 앞부분 → "사용자")로, 앞뒤 공백은 떼고 저장', async () => {
    await as(null, 'supabase_auth_admin');
    await q(`insert into auth.users (id, email, raw_user_meta_data) values
             ($1, 'tabname@example.com', $4), ($2, null, $5), ($3, 'x@example.com', $6)`,
      [id(5), id(6), id(7), JSON.stringify({ name: '\t' }), JSON.stringify({ name: '\n \t', full_name: '  ' }), JSON.stringify({ name: '\t수연\n' })]);
    await su();
    const r = Object.fromEntries((await q(`select user_id, nickname from public.profiles where user_id = any($1::uuid[])`, [[id(5), id(6), id(7)]]))
      .map((x) => [x.user_id, x.nickname]));
    return r[id(5)] === 'tabname' && r[id(6)] === '사용자' && r[id(7)] === '수연' ? true : r;
  });

  // ---- 아이디 바꾸기 -------------------------------------------------------

  const U = await join_(10, '바꾸는사람');                      // 온보딩 끝남, 자동 아이디

  await check('2-03(앞): 지금 자동 아이디를 그대로 보내면 RESERVED가 아니라 SAME(온보딩 [다음]이 그대로 보내도 됨), 30일에도 안 셈', async () => {
    const auto = await handleOf(U);
    const same = await change(U, auto.toUpperCase());
    const [p] = await q(`select handle_changed_at, handle_next_change_at from public.profiles where user_id = $1`, [U]);
    return HANDLE_RE.test(auto) && same.status === 'SAME' && same.handle === auto && p.handle_changed_at === null && p.handle_next_change_at === null
      ? true : { auto, same, p };
  });
  const V = await join_(11, '온보딩중', { onboarded: false });   // 온보딩 중
  const W = await join_(12, '형식시험', { onboarded: false });

  await check('2-03: 자동 아이디에서 처음 바꾸면 30일에 안 셈 → 바로 한 번 더 됨(이건 셈) → 세 번째는 LIMIT', async () => {
    const a = await change(U, 'first_try');
    const b = await change(U, 'second_try');
    const c = await change(U, 'third_try');
    const [p] = await q(`select handle, handle_changed_at is not null as changed,
                                round(extract(epoch from (handle_next_change_at - handle_changed_at)) / 86400) as days
                         from public.profiles where user_id = $1`, [U]);
    return a.status === 'OK' && a.next_change_at === null && b.status === 'OK' && b.next_change_at !== null
      && c.status === 'LIMIT' && c.next_change_at === b.next_change_at
      && p.handle === 'second_try' && p.changed === true && Number(p.days) === 30 ? true : { a, b, c, p };
  });

  await check('2-48: 온보딩 안(onboarded_at 비어 있음)에서는 몇 번을 바꿔도 30일에 안 셈', async () => {
    const a = await change(V, 'onb_one');
    const b = await change(V, 'onb_two');
    const c = await change(V, 'onb_three');
    return [a, b, c].every((x) => x.status === 'OK' && x.next_change_at === null) && (await handleOf(V)) === 'onb_three' ? true : { a, b, c };
  });

  await check('2-04 · 2-25: 직접 바꾼 지 10일 · 29일 23시간은 LIMIT + 다음 가능 시각(바꾼 시각 + 30일), 30일 1분이면 성공', async () => {
    const out = {};
    for (const [k, ago] of [['d10', '10 days'], ['d29h23', '29 days 23 hours'], ['d30m1', '30 days 1 minute']]) {
      await q(`update public.profiles set handle_changed_at = now() - $2::interval, handle_next_change_at = now() - $2::interval + interval '30 days'
               where user_id = $1`, [U, ago]);
      const [{ want }] = await q(`select handle_next_change_at as want from public.profiles where user_id = $1`, [U]);
      out[k] = { r: await change(U, `try_${k}`), want: new Date(want).getTime() };
    }
    const lim = (x) => x.r.status === 'LIMIT' && new Date(x.r.next_change_at).getTime() === x.want;
    return lim(out.d10) && lim(out.d29h23) && out.d30m1.r.status === 'OK' && out.d30m1.r.handle === 'try_d30m1' ? true : out;
  });

  await check('2-05 · 2-06 · 2-09: Kim.01 · 김철수 · 2자 · 21자는 INVALID, respec_ 로 시작하는 것과 예약어 10개(대소문자 무시, 정확히 같을 때만)는 RESERVED, admin1처럼 다른 글자가 붙으면 통과, KIM_01 · " @Mix_09 "는 소문자로 저장', async () => {
    const r = {};
    for (const h of ['Kim.01', '김철수', 'ab', 'a'.repeat(21), 'respec_admin', 'RESPEC_x1y2', '', 'x'.repeat(65)]) r[h.slice(0, 12)] = (await change(W, h)).status;
    const words = ['admin', 'respec', 'support', 'help', 'official', 'system', 'root', 'operator', 'manager', 'null', 'ADMIN', ' @Root '];
    const reserved = [];
    for (const w of words) reserved.push((await change(W, w)).status);
    const near = [(await change(W, 'admin1')).status, (await change(W, 'my_root')).status, (await change(W, 'respec1')).status];   // 정확히 같을 때만 막음
    const up = await change(W, 'KIM_01');
    const mixed = await change(W, ' @Mix_09 ');
    return r['Kim.01'] === 'INVALID' && r['김철수'] === 'INVALID' && r.ab === 'INVALID' && r['aaaaaaaaaaaa'] === 'INVALID'
      && r.respec_admin === 'RESERVED' && r.RESPEC_x1y2 === 'RESERVED' && r[''] === 'INVALID' && r['xxxxxxxxxxxx'] === 'INVALID'
      && reserved.every((x) => x === 'RESERVED') && near.every((x) => x === 'OK')
      && up.status === 'OK' && up.handle === 'kim_01' && mixed.status === 'OK' && (await handleOf(W)) === 'mix_09' ? true : { r, reserved, near, up, mixed };
  });

  const X = await join_(13, '갖고있던사람', { onboarded: false });
  const Y = await join_(14, '가져갈사람', { onboarded: false });

  await check('2-07 · 2-08: 남이 쓰는 아이디는 TAKEN(대소문자 무시), 주인이 바꾸면 옛 아이디는 바로 풀려 남이 가져감', async () => {
    const own = await change(X, 'kim_77');
    const taken = await change(Y, 'KIM_77');
    const moved = await change(X, 'kim_78');
    const grab = await change(Y, 'kim_77');
    return own.status === 'OK' && taken.status === 'TAKEN' && moved.status === 'OK' && grab.status === 'OK'
      && (await handleOf(Y)) === 'kim_77' ? true : { own, taken, moved, grab };
  });

  await check('2-26: 같은 사람이 두 기기에서 같은 새 아이디로 바꾸면 한 번만 OK, 다음은 SAME(그대로)', async () => {
    const a = await change(X, 'two_devices');
    const b = await change(X, 'TWO_DEVICES');
    return a.status === 'OK' && b.status === 'SAME' && b.handle === 'two_devices' ? true : { a, b };
  });

  await check('15-라(2장 몫): 앱이 handle · 변경 시각 칸을 직접 update하면 42501, 닉네임 같은 다른 칸은 그대로 고침 · service_role은 handle을 고침(시드)', async () => {
    await as(X);
    const h = await expectErr(() => q(`update public.profiles set handle = 'direct_one' where user_id = $1`, [X]), /change_my_handle/);
    const t = await expectErr(() => q(`update public.profiles set handle_next_change_at = now() - interval '1 year' where user_id = $1`, [X]), /change_my_handle/);
    const c = await expectErr(() => q(`update public.profiles set handle_changed_at = null where user_id = $1`, [X]), /change_my_handle/);
    const nick = await q(`update public.profiles set nickname = '새닉네임' where user_id = $1 returning nickname`, [X]);
    await as(null, 'service_role');
    const seed = await q(`update public.profiles set handle = 'seed_handle' where user_id = $1 returning handle`, [X]);
    await su();
    return h === true && t === true && c === true && nick[0]?.nickname === '새닉네임' && seed[0]?.handle === 'seed_handle' ? true : { h, t, c, nick, seed };
  });

  await check('15-라(2장 몫): 앱은 onboarded_at을 비어 있을 때 한 번 채우기만 — 채운 뒤 비우거나 바꾸면 42501(30일 예외를 다시 얻는 길), 비우기 우회 뒤에도 LIMIT 그대로', async () => {
    const O = await join_(15, '온보딩채움', { onboarded: false });
    await as(O);
    const fill = await q(`update public.profiles set onboarded_at = now() where user_id = $1 returning 1`, [O]);
    const clear = await expectErr(() => q(`update public.profiles set onboarded_at = null where user_id = $1`, [O]), /온보딩을 끝낸 시각/);
    const move = await expectErr(() => q(`update public.profiles set onboarded_at = now() - interval '1 day' where user_id = $1`, [O]), /온보딩을 끝낸 시각/);
    const same = await q(`update public.profiles set onboarded_at = onboarded_at, nickname = '그대로' where user_id = $1 returning 1`, [O]);
    await su();
    // 바꾼 적 있고 30일 안 → LIMIT. 비우기가 막혀 우회 못 함
    await q(`update public.profiles set handle_changed_at = now() - interval '1 day', handle_next_change_at = now() + interval '29 days' where user_id = $1`, [O]);
    const lim = await change(O, 'escape_try');
    // dev_reset_my_data(개발용, security definer)는 지금처럼 온보딩 전으로 되돌림
    await as(O);
    await q(`select public.dev_reset_my_data()`);
    await su();
    const [{ onboarded_at: reset }] = await q(`select onboarded_at from public.profiles where user_id = $1`, [O]);
    return fill.length === 1 && clear === true && move === true && same.length === 1 && lim.status === 'LIMIT' && reset === null
      ? true : { fill, clear, move, same, lim, reset };
  });

  await check('2-28: 닉네임 — 앞뒤 공백(탭 · 줄바꿈 포함) 떼고 저장, 빈 값 · 공백만 · 31자는 거절, 같은 닉네임은 허용', async () => {
    await as(X);
    const [trim] = await q(`update public.profiles set nickname = E'  김민수\\t ' where user_id = $1 returning nickname`, [X]);
    const empty = await expectErr(() => q(`update public.profiles set nickname = '' where user_id = $1`, [X]), /profiles_nickname_trimmed/);
    const spaces = await expectErr(() => q(`update public.profiles set nickname = '   ' where user_id = $1`, [X]), /profiles_nickname_trimmed/);
    const long = await expectErr(() => q(`update public.profiles set nickname = $2 where user_id = $1`, [X, '가'.repeat(31)]), /too long|22001/);
    await as(Y);
    const same = await q(`update public.profiles set nickname = '김민수' where user_id = $1 returning nickname`, [Y]);
    await su();
    return trim.nickname === '김민수' && empty === true && spaces === true && long === true && same[0]?.nickname === '김민수'
      ? true : { trim, empty, spaces, long, same };
  });

  // ---- 아이디 검색 ---------------------------------------------------------

  const A = await join_(20, '찾는사람');
  const B = await join_(21, '찾을사람');
  const C = await join_(22, '친구신청');
  const D = await join_(23, '받은신청');
  const E = await join_(24, '친구');
  const NO = await join_(25, '온보딩전', { onboarded: false });
  for (const [u, h] of [[A, 'finder_a'], [B, 'kim_01'], [C, 'sent_c'], [D, 'recv_d'], [E, 'friend_e'], [NO, 'not_yet']]) await setHandle(u, h);
  await q(`insert into public.friends (requester_id, addressee_id, status) values ($1, $2, 'PENDING'), ($3, $1, 'PENDING')`, [A, C, D]);
  await q(`insert into public.friends (requester_id, addressee_id, status, accepted_at) values ($1, $2, 'ACCEPTED', now())`, [A, E]);

  await check('2-10 · 2-12 · 2-31 · 2-32 · 2-49: 정확 일치 — 앞뒤 공백 · @ · 대문자는 정리해 찾고, 결과는 공개 4칸(user_id · nickname · profile_image_url · handle) + 친구 상태', async () => {
    const b = await search(A, ' @KIM_01 ');
    const keys = Object.keys(b.profile ?? {}).sort().join(',');
    const rel = {};
    for (const h of ['sent_c', 'recv_d', 'friend_e', 'kim_01']) rel[h] = (await search(A, h)).relation;
    const wide = await search(A, 'ＫＩＭ＿０１');   // 전각은 못 찾음
    await clearSearches(A);
    return b.status === 'FOUND' && b.profile.user_id === B && b.profile.handle === 'kim_01' && b.profile.nickname === '찾을사람'
      && keys === 'handle,nickname,profile_image_url,user_id' && Object.keys(b).sort().join(',') === 'profile,relation,status'
      && rel.sent_c === 'REQUEST_SENT' && rel.recv_d === 'REQUEST_RECEIVED' && rel.friend_e === 'FRIEND' && rel.kim_01 === 'NONE'
      && wide.status === 'NOT_FOUND' ? true : { b, rel, wide };
  });

  await check('2-11 · 2-13(DB 몫): 아이디 일부만은 NOT_FOUND(정확 일치만), 내 아이디는 SELF + 내 공개 4칸', async () => {
    const part = await search(A, 'kim');
    const part2 = await search(A, 'kim_0');
    const self = await search(A, 'FINDER_A');
    await clearSearches(A);
    return part.status === 'NOT_FOUND' && part2.status === 'NOT_FOUND' && self.status === 'SELF' && self.profile.user_id === A
      && self.relation === undefined ? true : { part, part2, self };
  });

  await check('2-14 · 2-15 · 2-34 · 2-38: 차단(어느 쪽이 걸었든) · 탈퇴 · 온보딩 전 · 없는 아이디 · 형식 밖 입력은 응답이 글자 그대로 같은 {"status":"NOT_FOUND"}', async () => {
    const BL = await join_(26, '차단한사람');
    const GONE = await join_(27, '탈퇴할사람');
    await setHandle(BL, 'blocker');
    await setHandle(GONE, 'gone_soon');
    await q(`insert into public.friends (requester_id, addressee_id, status) values ($1, $2, 'BLOCKED')`, [A, BL]);   // 지금 차단 모양(4장에서 user_blocks로)
    const before = await search(A, 'gone_soon');
    await q(`delete from auth.users where id = $1`, [GONE]);
    const shapes = {
      blockedByMe: await search(A, 'blocker'),
      blockedMe: await search(BL, 'finder_a'),
      gone: await search(A, 'gone_soon'),
      notOnboarded: await search(A, 'not_yet'),
      missing: await search(A, 'nobody_here'),
      badFormat: await search(A, '김철수'),
      tooLong: await search(A, 'x'.repeat(100)),
      nul: await search(A, null),
    };
    await clearSearches(A);
    await clearSearches(BL);
    const same = Object.values(shapes).every((x) => JSON.stringify(x) === '{"status": "NOT_FOUND"}' || JSON.stringify(x) === '{"status":"NOT_FOUND"}');
    return before.status === 'FOUND' && same ? true : { before, shapes };
  });

  await check('2-16 · 2-35 · 2-36: 1분 10회 — 못 찾은 검색도 셈(폰 · 웹 합쳐 사람 단위), 11번째는 LIMIT + 남은 초, 1분 지나면 다시 됨', async () => {
    await clearSearches(A);
    const ten = [];
    for (let i = 0; i < 10; i++) ten.push((await search(A, i % 2 ? 'kim_01' : `none_${i}`)).status);
    const eleventh = await search(A, 'kim_01');
    const [{ n }] = await q(`select count(*)::int as n from public.rate_limit_events where user_id = $1 and action = 'HANDLE_SEARCH'`, [A]);
    await q(`update public.rate_limit_events set created_at = created_at - interval '61 seconds' where user_id = $1`, [A]);
    const later = await search(A, 'kim_01');
    await clearSearches(A);
    return ten.filter((s) => s === 'FOUND').length === 5 && ten.filter((s) => s === 'NOT_FOUND').length === 5
      && eleventh.status === 'LIMIT' && eleventh.retry_after_seconds >= 1 && eleventh.retry_after_seconds <= 60
      && Object.keys(eleventh).sort().join(',') === 'retry_after_seconds,status'
      && n === 10 && later.status === 'FOUND' ? true : { ten, eleventh, n, later };
  });

  await check('2-17 · 2-37(DB 몫): A가 제한에 걸려도 B는 검색됨(사람별), 걸린 A는 누구를 찾든 같은 LIMIT', async () => {
    for (let i = 0; i < 10; i++) await search(A, 'kim_01');
    const aFound = await search(A, 'kim_01');
    const aMissing = await search(A, 'nobody_here');
    const aSelf = await search(A, 'finder_a');
    const b = await search(B, 'finder_a');
    await clearSearches(A);
    await clearSearches(B);
    return [aFound, aMissing, aSelf].every((x) => x.status === 'LIMIT') && b.status === 'FOUND' ? true : { aFound, aMissing, aSelf, b };
  });

  await check('2-52: 하루 100번 — 101번째 검색은 LIMIT(남은 시간은 그 사람 시간대 다음 0시까지), 걸린 호출은 기록에 안 남고 날이 바뀌면(어제 기록은 안 셈) 다시 됨', async () => {
    const S = await join_(28, '하루검색');
    // 시험을 돌리는 시각과 상관없이 그 사람 시간대에서 지금이 낮 12시쯤이 되게 고정 시간대(Etc/GMT±N)를 고름 — 자정 근처에 돌아도 흔들리지 않게
    const [{ tz }] = await q(`select 'Etc/GMT' || case when h >= 12 then '+' || (h - 12) else '-' || (12 - h) end as tz
                              from (select extract(hour from now() at time zone 'UTC')::int as h) x`);
    await q(`update public.profiles set timezone = $2 where user_id = $1`, [S, tz]);
    // 오늘 100번(그 시간대 0시 1시간 뒤 = 지금보다 한참 전이라 1분 제한에는 안 걸림)
    await q(`insert into public.rate_limit_events (user_id, action, created_at)
             select $1, 'HANDLE_SEARCH', ((now() at time zone $2)::date::timestamp at time zone $2) + interval '1 hour' from generate_series(1, 100)`, [S, tz]);
    const over = await search(S, 'kim_01');
    const [{ n }] = await q(`select count(*)::int as n from public.rate_limit_events where user_id = $1`, [S]);
    await q(`update public.rate_limit_events set created_at = created_at - interval '1 day' where user_id = $1`, [S]);
    const nextDay = await search(S, 'kim_01');
    return over.status === 'LIMIT' && over.retry_after_seconds > 60 && over.retry_after_seconds <= 86400 && n === 100 && nextDay.status === 'FOUND' ? true : { over, n, nextDay };
  });

  await check('2-53: 아이디 바꾸기 시도도 검색과 같은 횟수에 셈 — 검색 6번 + 바꾸기(TAKEN) 4번 = 10번, 11번째는 바꾸기도 검색도 LIMIT(+ 남은 초), 걸린 호출은 아이디를 안 바꾸고 기록에 안 남음', async () => {
    const S = await join_(29, '바꾸기시도', { onboarded: false });
    const six = [];
    for (let i = 0; i < 6; i++) six.push((await search(S, i % 2 ? 'kim_01' : `none_${i}`)).status);
    const four = [];
    for (let i = 0; i < 4; i++) four.push((await change(S, 'kim_01', { keep: true })).status);   // kim_01은 B가 씀
    const eleventh = await change(S, 'kim_02x', { keep: true });
    const searchLimited = await search(S, 'kim_01');
    const [{ n }] = await q(`select count(*)::int as n from public.rate_limit_events where user_id = $1 and action = 'HANDLE_SEARCH'`, [S]);
    const kept = await handleOf(S);
    await q(`update public.rate_limit_events set created_at = created_at - interval '61 seconds' where user_id = $1`, [S]);
    const later = await change(S, 'kim_03x', { keep: true });
    return six.every((x) => x === 'FOUND' || x === 'NOT_FOUND') && four.every((x) => x === 'TAKEN')
      && eleventh.status === 'LIMIT' && eleventh.retry_after_seconds >= 1 && eleventh.retry_after_seconds <= 60
      && Object.keys(eleventh).sort().join(',') === 'retry_after_seconds,status' && searchLimited.status === 'LIMIT'
      && n === 10 && HANDLE_RE.test(kept) && later.status === 'OK' ? true : { six, four, eleventh, searchLimited, n, kept, later };
  });

  await check('옛 모양 find_profile_by_handle: 같은 검색 · 같은 제한을 거침 — 찾으면 공개 4칸 한 행, 온보딩 전 · 제한이면 빈 결과', async () => {
    await as(A);
    const one = await q(`select * from public.find_profile_by_handle('@KIM_01')`);
    const none = await q(`select * from public.find_profile_by_handle('not_yet')`);
    for (let i = 0; i < 8; i++) await q(`select public.search_by_handle('kim_01')`);
    const limited = await q(`select * from public.find_profile_by_handle('kim_01')`);
    await su();
    await clearSearches(A);
    return one.length === 1 && one[0].user_id === B && Object.keys(one[0]).sort().join(',') === 'handle,nickname,profile_image_url,user_id'
      && none.length === 0 && limited.length === 0 ? true : { one, none, limited };
  });

  await check('2-33: 로그인 정보가 없으면 바꾸기 · 검색 · 이름 검색 · 링크 함수가 모두 42501(빈 결과), anon은 실행 권한부터 없음', async () => {
    await as(null);
    const errs = [];
    for (const sql of [`select public.change_my_handle('abc_1')`, `select public.search_by_handle('kim_01')`,
                       `select public.my_friend_link()`, `select public.open_friend_link('ABCDEFGHJKLM')`]) {
      errs.push(await expectErr(() => q(sql), /로그인이 필요함/));
    }
    const name = await q(`select * from public.search_related_by_name('찾을')`);
    await as(null, 'anon');
    const anon = await expectErr(() => q(`select public.search_by_handle('kim_01')`), /permission denied/);
    await su();
    return errs.every((x) => x === true) && name.length === 0 && anon === true ? true : { errs, name, anon };
  });

  await check('제한 기록 표(rate_limit_events): 서버 전용 — 앱은 읽지도 쓰지도 못함(자기 기록도), 제한 판정 함수는 앱이 직접 못 부름', async () => {
    await search(A, 'kim_01');
    await as(A);
    const read = await expectErr(() => q(`select * from public.rate_limit_events`), /permission denied/);
    const write = await expectErr(() => q(`insert into public.rate_limit_events (user_id, action) values ($1, 'HANDLE_SEARCH')`, [A]), /permission denied/);
    const del = await expectErr(() => q(`delete from public.rate_limit_events where user_id = $1`, [A]), /permission denied/);
    const fn = await expectErr(() => q(`select private.take_rate_slot($1, 'HANDLE_SEARCH', 10)`, [A]), /permission denied/);
    await su();
    await clearSearches(A);
    return read === true && write === true && del === true && fn === true ? true : { read, write, del, fn };
  });

  // ---- 이름 검색 -----------------------------------------------------------

  await check('2-46 · 2-47: 이름 검색 — 친구 · 같은 그룹(둘 다 참여 중)만 닉네임 부분 일치, 관계 없는 사람 · 초대만 받은 사람은 빠지고, 차단 · 탈퇴하면 빠짐, 동명이인은 handle로 구분', async () => {
    const N = await join_(40, '나');
    const NB = await join_(41, '김민수');   // 친구
    const NC = await join_(42, '김민수');   // 같은 그룹(참여 중)
    const ND = await join_(43, '김민수');   // 관계 없음
    const NE = await join_(44, '김민수');   // 같은 그룹 초대만
    const NF = await join_(45, '이민수');   // 친구이면서 같은 그룹
    await q(`insert into public.friends (requester_id, addressee_id, status, accepted_at) values ($1, $2, 'ACCEPTED', now()), ($3, $1, 'ACCEPTED', now())`, [N, NB, NF]);
    const [{ group_id: g }] = await q(`insert into public.groups (group_name, owner_id) values ('캡스톤팀', $1) returning group_id`, [N]);
    await q(`insert into public.group_members (group_id, user_id, invite_status, joined_at) values ($1, $2, 'JOINED', now()), ($1, $3, 'JOINED', now())`, [g, NC, NF]);
    await q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'INVITED')`, [g, NE]);
    const first = await byName(N, ' 민수 ');
    const ids = (rows) => rows.map((r) => r.user_id).sort();
    const rel = Object.fromEntries(first.map((r) => [r.user_id, r.relation]));
    const handles = new Set(first.map((r) => r.handle)).size;
    // 차단(지금 모양 = 친구 행 BLOCKED) · 탈퇴. 3장부터 update로는 차단 못 하니 행을 지우고 BLOCKED로 다시 넣음
    await q(`delete from public.friends where requester_id = $1 and addressee_id = $2`, [N, NB]);
    await q(`insert into public.friends (requester_id, addressee_id, status) values ($1, $2, 'BLOCKED')`, [N, NB]);
    await q(`delete from auth.users where id = $1`, [NC]);
    const after = await byName(N, '민수');
    const wild = await byName(N, '%');
    const blank = await byName(N, '   ');
    return JSON.stringify(ids(first)) === JSON.stringify([NB, NC, NF].sort()) && rel[NB] === 'FRIEND' && rel[NC] === 'GROUP' && rel[NF] === 'FRIEND'
      && handles === 3 && JSON.stringify(ids(after)) === JSON.stringify([NF]) && wild.length === 0 && blank.length === 0
      ? true : { first, after, wild, blank, ND, NE };
  });

  // ---- 친구 링크 -----------------------------------------------------------

  const L = await join_(50, '링크주인');
  const LB = await join_(51, '받는사람');
  const LC = await join_(52, '또받는사람');

  await check('my_friend_link: 처음엔 새 토큰(헷갈리는 글자 뺀 12자 · 7일), 다시 부르면 같은 토큰, p_renew면 새 토큰', async () => {
    const a = await myLink(L);
    const b = await myLink(L);
    const c = await myLink(L, true);
    const days = (new Date(a.expires_at) - Date.now()) / 86400000;
    return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/.test(a.token) && days > 6.99 && days <= 7
      && b.token === a.token && c.token !== a.token ? true : { a, b, c, days };
  });

  await check('2-51 · 2-21(DB 몫): 7일 안 링크는 두 명 모두 열림(주인 공개 4칸 + 친구 상태, 여는 것만으로는 요청 행 없음), 다시 만들면 옛 링크는 EXPIRED, 소문자 · 공백 입력도 열림', async () => {
    const t = (await myLink(L)).token;
    const b = await openLink(LB, t);
    const c = await openLink(LC, ` ${t.toLowerCase()} `);
    const [{ n }] = await q(`select count(*)::int as n from public.friends where $1 in (requester_id, addressee_id)`, [L]);
    const t2 = (await myLink(L, true)).token;
    const old = await openLink(LB, t);
    const fresh = await openLink(LB, t2);
    return b.status === 'OK' && b.profile.user_id === L && b.relation === 'NONE'
      && Object.keys(b.profile).sort().join(',') === 'handle,nickname,profile_image_url,user_id'
      && c.status === 'OK' && n === 0 && JSON.stringify(old) === JSON.stringify({ status: 'EXPIRED' }) && fresh.status === 'OK' ? true : { b, c, n, old, fresh };
  });

  await check('2-40: 만든 지 6일 23시간은 열림, 7일 1분은 EXPIRED(만료면 my_friend_link가 새 토큰)', async () => {
    const t = (await myLink(L)).token;
    await q(`update public.friend_links set created_at = now() - interval '6 days 23 hours', expires_at = now() + interval '1 hour' where owner_id = $1`, [L]);
    const early = await openLink(LB, t);
    await q(`update public.friend_links set created_at = now() - interval '7 days 1 minute', expires_at = now() - interval '1 minute' where owner_id = $1`, [L]);
    const late = await openLink(LB, t);
    const renewed = await myLink(L);
    return early.status === 'OK' && late.status === 'EXPIRED' && renewed.token !== t ? true : { early, late, renewed };
  });

  await check('2-41 · 2-42 · 2-22(DB 몫): 주인이 받는 사람을 차단했거나 받는 쪽이 차단했으면 EXPIRED, 내 링크는 SELF, 주인이 탈퇴하면 EXPIRED, 없는 · 형식 밖 토큰도 EXPIRED', async () => {
    const t = (await myLink(L)).token;
    await q(`insert into public.friends (requester_id, addressee_id, status) values ($1, $2, 'BLOCKED')`, [LC, L]);
    const blocked = await openLink(LC, t);
    const self = await openLink(L, t);
    const missing = await openLink(LB, 'ZZZZZZZZZZZZ');
    const bad = await openLink(LB, 'x'.repeat(200));
    const ok = await openLink(LB, t);
    await q(`delete from auth.users where id = $1`, [L]);
    const gone = await openLink(LB, t);
    const exp = JSON.stringify({ status: 'EXPIRED' });
    return [blocked, missing, bad, gone].every((x) => JSON.stringify(x) === exp) && self.status === 'SELF' && self.profile.user_id === L
      && ok.status === 'OK' ? true : { blocked, self, missing, bad, ok, gone };
  });

  await check('친구 링크 표(friend_links): 서버 전용 — 앱은 자기 링크 행도 직접 읽거나 고치지 못함', async () => {
    await myLink(LB);
    await as(LB);
    const read = await expectErr(() => q(`select * from public.friend_links`), /permission denied/);
    const upd = await expectErr(() => q(`update public.friend_links set expires_at = now() + interval '1 year' where owner_id = $1`, [LB]), /permission denied/);
    await su();
    return read === true && upd === true ? true : { read, upd };
  });
}
