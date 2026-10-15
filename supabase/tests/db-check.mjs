// Supabase 마이그레이션 검사 — Docker 없이 PGlite(WASM Postgres)로 돌림
//   1) Supabase 흉내: auth 스키마 · auth.uid() · anon / authenticated / service_role 역할 · 새 객체 자동 GRANT
//   2) supabase/migrations/*.sql을 이름 순서대로 적용 (CLI처럼 파일 하나 = 트랜잭션 하나)
//   3) RLS · 권한 · 함수 동작을 확인하고 항목마다 PASS / FAIL을 찍음. 하나라도 FAIL이면 종료 코드 1
// 실행: npm ci && npm test   (다른 마이그레이션 폴더를 보려면 node db-check.mjs <폴더>)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIG_DIR = process.argv[2] ?? fileURLToPath(new URL('../migrations/', import.meta.url));
const db = new PGlite();
const results = [];

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

// 슈퍼유저로 돌아가고 로그인 정보(JWT sub)를 비움
const su = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
};

// uid로 로그인한 요청처럼 역할을 바꿈 (PostgREST가 하는 것과 같음)
const as = async (uid, role = 'authenticated') => {
  await su();
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  await db.exec(`set role ${role}`);
};

// 항목 하나를 돌려 true면 PASS, 아니면 받은 값을 함께 FAIL로 남김
async function check(name, fn) {
  try {
    const r = await fn();
    results.push([r === true ? 'PASS' : 'FAIL', name, r === true ? '' : JSON.stringify(r)]);
  } catch (e) {
    results.push(['FAIL', name, '예외: ' + e.message]);
  } finally {
    await su();
  }
}

// 오류가 나야 하는 동작 — 메시지가 맞으면 true
async function expectErr(fn, re) {
  try {
    await fn();
    return '오류가 나야 하는데 성공함';
  } catch (e) {
    return re.test(e.message) ? true : '다른 오류: ' + e.message;
  }
}

function report() {
  for (const [s, n, d] of results) console.log(`${s}  ${n}${d ? '  -- ' + d : ''}`);
  const fails = results.filter((r) => r[0] !== 'PASS').length;
  console.log(`\n통과 ${results.length - fails} / ${results.length}`);
  process.exit(fails ? 1 : 0);
}


// ---------------------------------------------------------------------
// 1. Supabase 흉내
// ---------------------------------------------------------------------

await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;
  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
  grant select, insert, update, delete on auth.users to supabase_auth_admin;
  -- 클라우드 기본값처럼 public에 새로 만든 객체를 API 역할에 자동으로 열어 둠 (마이그레이션의 회수가 먹는지 보려고)
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);
const [{ version }] = await q('select version()');
console.log(version.split(' on ')[0] + '\n');


// ---------------------------------------------------------------------
// 2. 마이그레이션 적용
// ---------------------------------------------------------------------

for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
  try {
    await db.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
    results.push(['PASS', `적용: ${f}`, '']);
  } catch (e) {
    results.push(['FAIL', `적용: ${f}`, e.message]);
    report();
  }
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const KST0 = `((now() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul')`;  // 오늘 0시(한국)
const TODAY = `(now() at time zone 'Asia/Seoul')::date`;


// ---------------------------------------------------------------------
// 3. 구조
// ---------------------------------------------------------------------

// 회의 도구 테이블(결정 안건 페이지 /decisions — 의견 · 투표 · 상태)은 앱 데이터가 아니라 anon 규칙의 예외 — 아래 "회의 의견"에서 따로 확인
const MEETING = ['decision_comments', 'decision_votes', 'decision_states'];

await check('모든 public 테이블(앱 16개 + 회의 도구 3개)에 RLS가 켜져 있음', async () => {
  const r = await q(`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relkind = 'r' order by 1`);
  const off = r.filter((x) => !x.relrowsecurity).map((x) => x.relname);
  const app = r.filter((x) => !MEETING.includes(x.relname)).length;
  return app === 16 && r.length === 19 && off.length === 0 ? true : { count: r.length, app, off };
});
await check('모든 앱 테이블에 정책이 있고 anon용 정책은 없음', async () => {
  const r = await q(`select c.relname, count(p.polname) as n,
                       bool_or(p.polroles @> array['anon'::regrole::oid]) as has_anon
                     from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     left join pg_policy p on p.polrelid = c.oid
                     where n.nspname = 'public' and c.relkind = 'r' group by 1`);
  const bad = r.filter((x) => !MEETING.includes(x.relname) && (Number(x.n) === 0 || x.has_anon));
  return bad.length === 0 ? true : bad;
});
await check('anon은 앱 테이블 · 뷰 권한이 없음', async () => {
  const r = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relkind in ('r', 'v')
                       and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
                         or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))`);
  const bad = r.filter((x) => !MEETING.includes(x.relname));
  return bad.length === 0 ? true : bad;
});
await check('public · private 함수는 모두 search_path가 비어 있음', async () => {
  const r = await q(`select n.nspname || '.' || p.proname as fn, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname in ('public', 'private')`);
  const bad = r.filter((x) => !(x.proconfig || []).some((c) => c === 'search_path=""' || c === 'search_path='));
  return bad.length === 0 && r.length > 0 ? true : bad;
});
await check('anon은 함수를 실행할 수 없음', async () => {
  const r = await q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')`);
  return r.length === 0 ? true : r;
});
await check('ENUM 19개 값이 4장과 같음 (NORMAL · DEPARTURE · FEEDBACK) + ACKNOWLEDGED', async () => {
  const r = await q(`select t.typname, array_agg(e.enumlabel order by e.enumsortorder)::text as v
                     from pg_type t join pg_enum e on e.enumtypid = t.oid group by 1`);
  const m = Object.fromEntries(r.map((x) => [x.typname, x.v]));
  const ok = Object.keys(m).length === 19
    && m.importance_level === '{LOW,NORMAL,HIGH}'
    && m.alarm_type === '{WAKE,PREPARE,DEPARTURE,ARRIVE,ROUTINE}'
    && m.alarm_intensity === '{SOFT,NORMAL,STRONG}'
    && m.alarm_event_type === '{TRIGGERED,SNOOZED,DISMISSED,WAKE_CONFIRMED,ARRIVAL_CONFIRMED,MISSED,FEEDBACK,ACKNOWLEDGED}';
  return ok ? true : m;
});


// ---------------------------------------------------------------------
// 4. 가입 · 프로필
// ---------------------------------------------------------------------

await check('auth.users에 넣으면 profiles가 생기고 OAuth 메타데이터에서 닉네임 · 사진을 가져옴', async () => {
  await as(null, 'supabase_auth_admin');
  await q(`insert into auth.users (id, email, raw_user_meta_data) values
    ($1, 'a@example.com', '{"name":"김지형","avatar_url":"https://img/a.png"}'),
    ($2, 'b@example.com', '{"full_name":"이수연","picture":"https://img/b.png"}'),
    ($3, 'cuser@example.com', '{}'),
    ($4, 'd@example.com', '{"nickname":"준성"}'),
    ($5, null, '{"preferred_username":"범준"}')`, [A, B, C, D, E]);
  await su();
  const r = await q(`select user_id, nickname, profile_image_url from public.profiles order by user_id`);
  const m = Object.fromEntries(r.map((x) => [x.user_id, x]));
  const ok = r.length === 5 && m[A].nickname === '김지형' && m[A].profile_image_url === 'https://img/a.png'
    && m[B].nickname === '이수연' && m[B].profile_image_url === 'https://img/b.png'
    && m[C].nickname === 'cuser' && m[D].nickname === '준성' && m[E].nickname === '범준';
  return ok ? true : r;
});
await check('트리거 함수는 실행 권한이 없어도 트리거로는 돎 (supabase_auth_admin · authenticated)', async () => {
  const [r] = await q(`select has_function_privilege('supabase_auth_admin', 'public.handle_new_user()', 'execute') as x,
                              has_function_privilege('authenticated', 'public.set_updated_at()', 'execute') as y`);
  return r.x === false && r.y === false ? true : r;
});
await check('A는 자기 프로필 행만 봄', async () => {
  await as(A);
  const r = await q(`select user_id from public.profiles`);
  return r.length === 1 && r[0].user_id === A ? true : r;
});
await check('anon은 profiles를 못 읽음', async () => {
  await as(null, 'anon');
  return expectErr(() => q(`select * from public.profiles`), /permission denied/);
});


// ---------------------------------------------------------------------
// 5. 기본 데이터 — 사람마다 개인 일정 · 참여 조건 · 오늘 기상 알람
// ---------------------------------------------------------------------

const ids = {};
for (const [u, hhmm] of [[A, '07:00'], [B, '07:30'], [C, '07:00'], [D, '06:50']]) {
  await as(u);
  const [ap] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name)
                        values ($1, '개인 일정', ${KST0} + interval '10 hours', '세종대학교') returning appointment_id`, [u]);
  const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id)
                        values ($1, $2) returning participant_id`, [ap.appointment_id, u]);
  const [al] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at)
                        values ($1, $2, 'WAKE', ${KST0} + interval '${hhmm}') returning alarm_id`, [pt.participant_id, u]);
  ids[u] = { appt: ap.appointment_id, part: pt.participant_id, alarm: al.alarm_id };
}
await su();


// ---------------------------------------------------------------------
// 6. 본인 범위
// ---------------------------------------------------------------------

await check('A는 자기 알람만 보고 B 알람은 못 봄 (권한 없음)', async () => {
  await as(A);
  const r = await q(`select user_id from public.alarms`);
  return r.length === 1 && r[0].user_id === A ? true : r;
});
await check('A는 B의 참여 조건에 알람을 못 붙임', async () => {
  await as(A);
  return expectErr(() => q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at)
                            values ($1, $2, 'PREPARE', now())`, [ids[B].part, A]), /row-level security/);
});
await check('A는 B 알람에 반응 이력을 못 씀', async () => {
  await as(A);
  return expectErr(() => q(`insert into public.alarm_events (alarm_id, user_id, event_type) values ($1, $2, 'TRIGGERED')`,
    [ids[B].alarm, A]), /row-level security/);
});


// ---------------------------------------------------------------------
// 7. 친구
// ---------------------------------------------------------------------

let fAB;
await check('친구 요청: 요청자는 스스로 수락 못 함 · B→A 역방향 중복 거부 · 받은 사람이 수락 · 주인 칼럼 못 바꿈', async () => {
  await as(A);
  [{ friend_id: fAB }] = await q(`insert into public.friends (requester_id, addressee_id) values ($1, $2) returning friend_id`, [A, B]);
  const selfAccept = await q(`update public.friends set status = 'ACCEPTED' where friend_id = $1 returning 1`, [fAB]);
  await as(B);
  const dup = await expectErr(() => q(`insert into public.friends (requester_id, addressee_id) values ($1, $2)`, [B, A]),
    /duplicate key|friends_pair_key/);
  const acc = await q(`update public.friends set status = 'ACCEPTED', accepted_at = now() where friend_id = $1 returning status`, [fAB]);
  const keyChange = await expectErr(() => q(`update public.friends set requester_id = $1 where friend_id = $2`, [C, fAB]),
    /바꿀 수 없음/);
  return selfAccept.length === 0 && dup === true && acc.length === 1 && keyChange === true
    ? true : { selfAccept, dup, acc, keyChange };
});


// ---------------------------------------------------------------------
// 8. 친구 권한 — 알람 조회 · 설정
// ---------------------------------------------------------------------

let pFriendBA;
await check('친구 조회 권한을 받으면 A가 B 알람을 봄', async () => {
  await as(B);
  [{ permission_id: pFriendBA }] = await q(`insert into public.sharing_permissions
    (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true) returning permission_id`, [B, A, fAB]);
  await as(A);
  const r = await q(`select user_id from public.alarms order by user_id`);
  return r.length === 2 && r.some((x) => x.user_id === B) ? true : r;
});
await check('가짜 출처로는 권한을 만들 수 없음', async () => {
  await as(B);
  return expectErr(() => q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm)
                            values ($1, $2, 'FRIEND', gen_random_uuid(), true)`, [B, C]), /row-level security/);
});
await check('조회 권한만으로는 못 고침 · 설정 권한이면 고침 · 알람 주인은 못 바꿈 · 남의 알람은 못 지움', async () => {
  await as(A);
  const before = await q(`update public.alarms set is_enabled = false where alarm_id = $1 returning 1`, [ids[B].alarm]);
  await as(B);
  await q(`update public.sharing_permissions set can_edit_alarm = true where permission_id = $1`, [pFriendBA]);
  await as(A);
  const after = await q(`update public.alarms set scheduled_at = scheduled_at - interval '5 minutes' where alarm_id = $1 returning 1`, [ids[B].alarm]);
  const steal = await expectErr(() => q(`update public.alarms set user_id = $1 where alarm_id = $2`, [A, ids[B].alarm]), /바꿀 수 없음/);
  const del = await q(`delete from public.alarms where alarm_id = $1 returning 1`, [ids[B].alarm]);
  await as(B);  // 뒤 기상 검사를 위해 B 알람 시각을 되돌림
  await q(`update public.alarms set scheduled_at = scheduled_at + interval '5 minutes' where alarm_id = $1`, [ids[B].alarm]);
  return before.length === 0 && after.length === 1 && steal === true && del.length === 0
    ? true : { before, after, steal, del };
});
await check('설정 권한만 있고 조회 권한이 없으면 0행 수정 (UPDATE ... WHERE에도 조회 정책이 걸림)', async () => {
  await as(B);
  await q(`update public.sharing_permissions set can_view_alarm = false, can_edit_alarm = true where permission_id = $1`, [pFriendBA]);
  await as(A);
  const r = await q(`update public.alarms set is_enabled = false where alarm_id = $1 returning 1`, [ids[B].alarm]);
  await as(B);
  await q(`update public.sharing_permissions set can_view_alarm = true where permission_id = $1`, [pFriendBA]);
  return r.length === 0 ? true : r;
});


// ---------------------------------------------------------------------
// 9. 그룹
// ---------------------------------------------------------------------

let G, code;
await check('그룹 만들기: 만든 사람 자동 JOINED · 초대 코드 생성', async () => {
  await as(A);
  [{ group_id: G, invite_code: code }] = await q(`insert into public.groups (group_name, owner_id) values ('캡스톤팀', $1)
                                                  returning group_id, invite_code`, [A]);
  const m = await q(`select user_id, invite_status from public.group_members where group_id = $1`, [G]);
  return /^[A-Z0-9]{8}$/.test(code) && m.length === 1 && m[0].user_id === A && m[0].invite_status === 'JOINED'
    ? true : { code, m };
});
await check('초대: 만든 사람은 INVITED로 초대 · JOINED로 바로 넣기 거부 · 외부인은 초대 못 하고 그룹도 못 봄', async () => {
  await as(A);
  await q(`insert into public.group_members (group_id, user_id) values ($1, $2)`, [G, B]);
  const direct = await expectErr(() => q(`insert into public.group_members (group_id, user_id, invite_status) values ($1, $2, 'JOINED')`, [G, D]),
    /row-level security/);
  await as(E);
  const outsider = await expectErr(() => q(`insert into public.group_members (group_id, user_id) values ($1, $2)`, [G, E]),
    /row-level security/);
  const seen = await q(`select 1 from public.groups where group_id = $1`, [G]);
  return direct === true && outsider === true && seen.length === 0 ? true : { direct, outsider, seen };
});
await check('초대받은 B는 그룹을 보고 수락 · group_id 변경 거부 · 남의 기상 공유 동의는 못 바꿈', async () => {
  await as(B);
  const seen = await q(`select group_name from public.groups where group_id = $1`, [G]);
  const acc = await q(`update public.group_members set invite_status = 'JOINED', joined_at = now()
                       where group_id = $1 and user_id = $2 returning 1`, [G, B]);
  const move = await expectErr(() => q(`update public.group_members set group_id = gen_random_uuid() where group_id = $1 and user_id = $2`, [G, B]),
    /바꿀 수 없음/);
  const other = await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2 returning 1`, [G, A]);
  return seen.length === 1 && acc.length === 1 && move === true && other.length === 0 ? true : { seen, acc, move, other };
});
await check('초대 코드로 참여 (대소문자 · 공백 무시) · 틀린 코드 거부', async () => {
  await as(C);
  const [g1] = await q(`select public.join_group_by_invite_code($1) as g`, [code.toLowerCase()]);
  await as(D);
  const [g2] = await q(`select public.join_group_by_invite_code($1) as g`, [' ' + code + ' ']);
  await as(E);
  const wrong = await expectErr(() => q(`select public.join_group_by_invite_code('ZZZZZZZZ')`), /초대 코드가 맞지 않음/);
  await su();
  const m = await q(`select count(*)::int as n from public.group_members where group_id = $1 and invite_status = 'JOINED'`, [G]);
  return g1.g === G && g2.g === G && wrong === true && m[0].n === 4 ? true : { g1, g2, wrong, m };
});


// ---------------------------------------------------------------------
// 10. 그룹 권한 · 합집합
// ---------------------------------------------------------------------

let pGroupBA;
await check('친구 권한을 지우면 안 보이고, 그룹 권한을 주면 다시 보임', async () => {
  await as(B);
  await q(`delete from public.sharing_permissions where permission_id = $1`, [pFriendBA]);
  await as(A);
  const none = await q(`select 1 from public.alarms where user_id = $1`, [B]);
  await as(B);
  [{ permission_id: pGroupBA }] = await q(`insert into public.sharing_permissions
    (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'GROUP', $3, true) returning permission_id`, [B, A, G]);
  await as(A);
  const some = await q(`select 1 from public.alarms where user_id = $1`, [B]);
  return none.length === 0 && some.length === 1 ? true : { none, some };
});
await check('최종 권한 = 친구 ∪ 그룹 (그룹을 끄고 친구를 켜면 보임, 둘 다 꺼지면 안 보임)', async () => {
  await as(B);
  await q(`update public.sharing_permissions set can_view_alarm = false where permission_id = $1`, [pGroupBA]);
  const [{ permission_id: pf }] = await q(`insert into public.sharing_permissions
    (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true) returning permission_id`, [B, A, fAB]);
  await as(A);
  const viaFriend = await q(`select 1 from public.alarms where user_id = $1`, [B]);
  await as(B);
  await q(`delete from public.sharing_permissions where permission_id = $1`, [pf]);
  await as(A);
  const neither = await q(`select 1 from public.alarms where user_id = $1`, [B]);
  return viaFriend.length === 1 && neither.length === 0 ? true : { viaFriend, neither };
});


// ---------------------------------------------------------------------
// 11. 그룹원 기상 상태 (get_group_wake_status)
// ---------------------------------------------------------------------
// 오늘(한국) 이벤트: B는 울림 · 미루기 · 해제 · 기상 확인, C는 울림만, D는 울림 · 기상 확인
// B는 그룹 권한 + 동의, C는 그룹 권한만, D는 동의만

await as(B);
await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at, snooze_minutes) values
  ($1, $2, 'TRIGGERED', ${KST0} + interval '07:30', null),
  ($1, $2, 'SNOOZED',   ${KST0} + interval '07:31', 5),
  ($1, $2, 'DISMISSED', ${KST0} + interval '07:40', null),
  ($1, $2, 'WAKE_CONFIRMED', ${KST0} + interval '07:42', null)`, [ids[B].alarm, B]);
await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [G, B]);
await q(`update public.sharing_permissions set can_view_wake = true where permission_id = $1`, [pGroupBA]);
await as(C);
await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values ($1, $2, 'TRIGGERED', ${KST0} + interval '07:00')`, [ids[C].alarm, C]);
await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_wake) values ($1, $2, 'GROUP', $3, true)`, [C, A, G]);
await as(D);
await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values
  ($1, $2, 'TRIGGERED', ${KST0} + interval '06:50'), ($1, $2, 'WAKE_CONFIRMED', ${KST0} + interval '06:55')`, [ids[D].alarm, D]);
await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [G, D]);
await su();

const wake = async (uid, withDate = true) => {
  await as(uid);
  return q(withDate ? `select * from public.get_group_wake_status($1, ${TODAY})` : `select * from public.get_group_wake_status($1)`, [G]);
};

await check('A에게는 본인 + B만 나옴 (C는 권한만 · D는 동의만 있어서 안 나옴)', async () => {
  const r = await wake(A);
  const users = r.map((x) => x.user_id);
  const b = r.find((x) => x.user_id === B);
  const ok = r.length === 2 && users[0] === A && r[0].is_me === true && b
    && b.wake_status === 'CONFIRMED' && b.snooze_count === 1 && b.rang_at && b.dismissed_at && b.wake_confirmed_at
    && new Date(b.wake_alarm_at).getTime() === new Date(b.rang_at).getTime()
    && !users.includes(C) && !users.includes(D);
  return ok ? true : r;
});
await check('날짜를 안 주면 호출자 시간대의 오늘', async () => {
  const a = await wake(A, true);
  const b = await wake(A, false);
  return JSON.stringify(a) === JSON.stringify(b) ? true : { a, b };
});
await check('C가 그룹에서 기상 공유에 동의하면 나오고(RINGING) 끄면 사라짐', async () => {
  await as(C);
  await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [G, C]);
  const r = await wake(A);
  const c = r.find((x) => x.user_id === C);
  await as(C);
  await q(`update public.group_members set wake_share_opt_in = false where group_id = $1 and user_id = $2`, [G, C]);
  const r2 = await wake(A);
  return c && c.wake_status === 'RINGING' && !r2.some((x) => x.user_id === C) ? true : { r, r2 };
});
await check('친구로 받은 기상 권한은 그룹 동의 없이도 인정 (합집합)', async () => {
  await as(C);
  const [{ friend_id: fCA }] = await q(`insert into public.friends (requester_id, addressee_id) values ($1, $2) returning friend_id`, [C, A]);
  await as(A);
  await q(`update public.friends set status = 'ACCEPTED', accepted_at = now() where friend_id = $1`, [fCA]);
  await as(C);
  await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_wake) values ($1, $2, 'FRIEND', $3, true)`, [C, A, fCA]);
  const r = await wake(A);
  return r.some((x) => x.user_id === C) ? true : r;
});
await check('비구성원은 빈 결과 · 다른 구성원은 자기가 받은 권한만큼만 봄', async () => {
  const e = await wake(E);
  const b = await wake(B);
  return e.length === 0 && b.length === 1 && b[0].user_id === B ? true : { e, b };
});
await check('함수 밖에서는 B의 alarm_events · daily_records를 못 읽음', async () => {
  await as(B);
  await q(`insert into public.daily_records (user_id, record_date, wake_confirmed_at) values ($1, ${TODAY}, now())`, [B]);
  await as(A);
  const ev = await q(`select 1 from public.alarm_events where user_id = $1`, [B]);
  const dr = await q(`select 1 from public.daily_records where user_id = $1`, [B]);
  return ev.length === 0 && dr.length === 0 ? true : { ev, dr };
});
await check('하루 경계는 호출자 시간대 (한국 자정 1분 전 이벤트는 빼고 1분 뒤는 셈)', async () => {
  await as(A);
  await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values ($1, $2, 'TRIGGERED', ${KST0} - interval '1 minute')`, [ids[A].alarm, A]);
  const r1 = (await wake(A)).find((x) => x.user_id === A);
  await as(A);
  await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values ($1, $2, 'TRIGGERED', ${KST0} + interval '1 minute')`, [ids[A].alarm, A]);
  const r2 = (await wake(A)).find((x) => x.user_id === A);
  const [{ exp }] = await q(`select ${KST0} + interval '1 minute' as exp`);
  return r1.rang_at === null && r1.wake_status === 'SCHEDULED'
    && new Date(r2.rang_at).getTime() === new Date(exp).getTime() && r2.wake_status === 'RINGING'
    ? true : { r1, r2, exp };
});
await check('WAKE_CONFIRMED 이벤트가 없으면 daily_records의 기상 확인 시각을 씀', async () => {
  await as(C);
  await q(`insert into public.daily_records (user_id, record_date, wake_confirmed_at) values ($1, ${TODAY}, ${KST0} + interval '07:05')`, [C]);
  const c = (await wake(A)).find((x) => x.user_id === C);
  return c && c.wake_status === 'CONFIRMED' && c.wake_confirmed_at ? true : c;
});


// ---------------------------------------------------------------------
// 12. 공동 약속
// ---------------------------------------------------------------------

await check('공동 약속: 그룹원 조회 · 수정 · 삭제는 등록자만 · 등록자 · 그룹 변경 거부 · 개인 일정 비공개 · 참여 조건은 본인 행만', async () => {
  await as(A);
  const [{ appointment_id: GA }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name)
     values ($1, $2, '팀 주간회의', ${KST0} + interval '10 hours', '세종대학교') returning appointment_id`, [A, G]);
  await as(B);
  const read = await q(`select 1 from public.appointments where appointment_id = $1`, [GA]);
  const upd = await q(`update public.appointments set memo = '자료 챙기기' where appointment_id = $1 returning 1`, [GA]);
  const del = await q(`delete from public.appointments where appointment_id = $1 returning 1`, [GA]);
  const steal = await expectErr(() => q(`update public.appointments set creator_id = $1 where appointment_id = $2`, [B, GA]), /바꿀 수 없음/);
  const moveGroup = await expectErr(() => q(`update public.appointments set group_id = gen_random_uuid() where appointment_id = $1`, [GA]), /바꿀 수 없음/);
  const personal = await q(`select 1 from public.appointments where appointment_id = $1`, [ids[A].appt]);
  const join = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning 1`, [GA, B]);
  const joinPersonal = await expectErr(() => q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2)`, [ids[A].appt, B]),
    /row-level security/);
  await as(A);
  const parts = await q(`select user_id from public.appointment_participants where appointment_id = $1`, [GA]);
  await as(E);
  const outsider = await q(`select 1 from public.appointments where appointment_id = $1`, [GA]);
  return read.length === 1 && upd.length === 1 && del.length === 0 && steal === true && moveGroup === true && personal.length === 0
    && join.length === 1 && joinPersonal === true && parts.length === 0 && outsider.length === 0
    ? true : { read, upd, del, steal, moveGroup, personal, join, joinPersonal, parts, outsider };
});
await check('등록자도 약속을 다른 그룹으로 못 옮김 (group_id 고정)', async () => {
  await as(E);
  const [{ group_id: G2 }] = await q(`insert into public.groups (group_name, owner_id) values ('남의 그룹', $1) returning group_id`, [E]);
  await as(A);
  return expectErr(() => q(`update public.appointments set group_id = $1 where appointment_id = $2`, [G2, ids[A].appt]), /바꿀 수 없음/);
});


// ---------------------------------------------------------------------
// 13. 초대 · 내보내기 · 초대 코드
// ---------------------------------------------------------------------

await check('구성원도 초대함 · 초대 상태면 기상 결과 없음 · 구성원은 남을 못 내보내고 만든 사람은 내보냄', async () => {
  await as(C);
  const inv = await q(`insert into public.group_members (group_id, user_id) values ($1, $2) returning 1`, [G, E]);
  const kick = await q(`delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [G, D]);
  const ew = await wake(E);
  await as(E);
  const seen = await q(`select 1 from public.groups where group_id = $1`, [G]);
  await as(A);
  const ownerKick = await q(`delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [G, E]);
  return inv.length === 1 && kick.length === 0 && ew.length === 0 && seen.length === 1 && ownerKick.length === 1
    ? true : { inv, kick, ew, seen, ownerKick };
});
await check('만든 사람이 내보내면 코드가 바뀌어 내보내진 사람은 옛 코드로 못 들어옴 · 스스로 나가면 코드 그대로', async () => {
  await as(A);
  const [{ invite_code: now1 }] = await q(`select invite_code from public.groups where group_id = $1`, [G]);
  await as(E);
  const old = await expectErr(() => q(`select public.join_group_by_invite_code($1)`, [code]), /초대 코드가 맞지 않음/);
  await q(`select public.join_group_by_invite_code($1)`, [now1]);
  const selfLeave = await q(`delete from public.group_members where group_id = $1 and user_id = $2 returning 1`, [G, E]);
  await as(A);
  const [{ invite_code: now2 }] = await q(`select invite_code from public.groups where group_id = $1`, [G]);
  const rotated = now1 !== code && /^[A-Z0-9]{8}$/.test(now1);
  code = now1;
  return rotated && old === true && selfLeave.length === 1 && now2 === now1 ? true : { rotated, old, selfLeave, now1, now2 };
});
await check('regenerate_invite_code: 만든 사람만 새 코드를 받고 옛 코드는 바로 막힘 · 구성원은 거부', async () => {
  await as(C);
  const member = await expectErr(() => q(`select public.regenerate_invite_code($1)`, [G]), /만든 사람만/);
  await as(A);
  const [{ c: fresh }] = await q(`select public.regenerate_invite_code($1) as c`, [G]);
  const [{ invite_code: stored }] = await q(`select invite_code from public.groups where group_id = $1`, [G]);
  await as(E);
  const old = await expectErr(() => q(`select public.join_group_by_invite_code($1)`, [code]), /초대 코드가 맞지 않음/);
  const ok = member === true && fresh !== code && fresh === stored && old === true;
  code = fresh;
  return ok ? true : { member, fresh, stored, old };
});


// ---------------------------------------------------------------------
// 14. 푸시 토큰
// ---------------------------------------------------------------------

await check('push_tokens는 본인만 · register_push_token은 같은 폰 토큰을 새 계정으로 옮김 · 이상한 platform 거부', async () => {
  await as(A);
  await q(`insert into public.push_tokens (user_id, token) values ($1, 'ExponentPushToken[aaa]')`, [A]);
  await as(B);
  const seen = await q(`select 1 from public.push_tokens`);
  const upd = await q(`update public.push_tokens set platform = 'web' where token = 'ExponentPushToken[aaa]' returning 1`);
  const forge = await expectErr(() => q(`insert into public.push_tokens (user_id, token) values ($1, 'x')`, [A]), /row-level security/);
  await q(`select public.register_push_token('ExponentPushToken[aaa]')`);
  const mine = await q(`select user_id from public.push_tokens`);
  await as(A);
  const aNow = await q(`select 1 from public.push_tokens`);
  const badPlatform = await expectErr(() => q(`insert into public.push_tokens (user_id, token, platform) values ($1, 'y', 'symbian')`, [A]),
    /push_tokens_platform_check/);
  return seen.length === 0 && upd.length === 0 && forge === true && mine.length === 1 && mine[0].user_id === B
    && aNow.length === 0 && badPlatform === true ? true : { seen, upd, forge, mine, aNow, badPlatform };
});


// ---------------------------------------------------------------------
// 15. 아이디 · 공개 프로필
// ---------------------------------------------------------------------

await check('아이디: 형식 · 대소문자 무시 유일 · 검색 결과는 공개 4칸만', async () => {
  await as(A);
  await q(`update public.profiles set handle = 'vmgfh' where user_id = $1`, [A]);
  await as(B);
  const upper = await expectErr(() => q(`update public.profiles set handle = 'VMGFH' where user_id = $1`, [B]), /profiles_handle_format/);
  const dup = await expectErr(() => q(`update public.profiles set handle = 'vmgfh' where user_id = $1`, [B]), /profiles_handle_key|duplicate/);
  await q(`update public.profiles set handle = 'etion' where user_id = $1`, [B]);
  await as(E);
  const r = await q(`select * from public.find_profile_by_handle('@VmGfH')`);
  const cols = r.length ? Object.keys(r[0]).sort().join(',') : '';
  return upper === true && dup === true && r.length === 1 && r[0].user_id === A
    && cols === 'handle,nickname,profile_image_url,user_id' ? true : { upper, dup, r };
});
await check('get_public_profiles: 친구 · 그룹원은 보이고 모르는 사람은 안 보임', async () => {
  await as(A);
  const r = await q(`select user_id from public.get_public_profiles()`);
  const s = new Set(r.map((x) => x.user_id));
  await as(E);
  const e = await q(`select user_id from public.get_public_profiles()`);
  const filt = await q(`select user_id from public.get_public_profiles($1::uuid[])`, [[A, E]]);
  return s.has(A) && s.has(B) && s.has(C) && s.has(D) && !s.has(E) && e.length === 1 && e[0].user_id === E
    && filt.length === 1 && filt[0].user_id === E ? true : { r, e, filt };
});


// ---------------------------------------------------------------------
// 16. 이벤트 · 제약 · 뷰 · 트리거
// ---------------------------------------------------------------------

await check('ACKNOWLEDGED를 쓸 수 있음 · FEEDBACK은 평가 유형이 필수이고 알람당 1건', async () => {
  await as(A);
  const ack = await q(`insert into public.alarm_events (alarm_id, user_id, event_type) values ($1, $2, 'ACKNOWLEDGED') returning 1`, [ids[A].alarm, A]);
  const noType = await expectErr(() => q(`insert into public.alarm_events (alarm_id, user_id, event_type) values ($1, $2, 'FEEDBACK')`, [ids[A].alarm, A]),
    /feedback_type_only_on_feedback/);
  await q(`insert into public.alarm_events (alarm_id, user_id, event_type, feedback_type) values ($1, $2, 'FEEDBACK', 'TOO_LOUD')`, [ids[A].alarm, A]);
  const twice = await expectErr(() => q(`insert into public.alarm_events (alarm_id, user_id, event_type, feedback_type) values ($1, $2, 'FEEDBACK', 'GOOD')`, [ids[A].alarm, A]),
    /idx_alarm_events_one_feedback|duplicate/);
  return ack.length === 1 && noType === true && twice === true ? true : { ack, noType, twice };
});
await check('4장 CHECK 제약 (알람 출처 · 루틴 단계 · 제안 결과 · 범위)', async () => {
  await su();
  const noSrc = await expectErr(() => q(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'WAKE', now())`, [A]), /alarms_one_source/);
  const [{ routine_id: rt }] = await q(`insert into public.routines (user_id, title) values ($1, 't') returning routine_id`, [A]);
  const both = await expectErr(() => q(`insert into public.alarms (participant_id, routine_id, step_order, user_id, alarm_type, scheduled_at)
     values ($1, $2, 1, $3, 'ROUTINE', now())`, [ids[A].part, rt, A]), /alarms_one_source/);
  const noStep = await expectErr(() => q(`insert into public.alarms (routine_id, user_id, alarm_type, scheduled_at)
     values ($1, $2, 'ROUTINE', now())`, [rt, A]), /alarms_routine_step_required/);
  const sugg = await expectErr(() => q(`insert into public.alarm_suggestions (user_id, suggestion_type, suggested_value, status, responded_at)
     values ($1, 'SOUND', 'theme_calm', 'APPLIED', now())`, [A]), /suggestion_result_required/);
  const resp = await expectErr(() => q(`insert into public.alarm_suggestions (user_id, suggestion_type, suggested_value, status)
     values ($1, 'SOUND', 'theme_calm', 'IGNORED')`, [A]), /suggestion_responded_required/);
  const off = await expectErr(() => q(`update public.profiles set intensity_offset = 2 where user_id = $1`, [A]), /profiles_intensity_offset_range/);
  const steps = await expectErr(() => q(`insert into public.routines (user_id, title, steps) values ($1, 't', '{}'::jsonb)`, [A]), /routines_steps_is_array/);
  const sat = await expectErr(() => q(`insert into public.daily_records (user_id, record_date, sleep_satisfaction) values ($1, '2026-01-01', 6)`, [A]),
    /daily_records_sleep_satisfaction_range/);
  return [noSrc, both, noStep, sugg, resp, off, steps, sat].every((x) => x === true)
    ? true : { noSrc, both, noStep, sugg, resp, off, steps, sat };
});
await check('v_prepare_time_stats는 본인 통계만 보임 (security_invoker)', async () => {
  for (const [u, mins] of [[A, [40, 50, 60]], [B, [30]]]) {
    await as(u);
    for (let i = 0; i < mins.length; i++) {
      await q(`insert into public.daily_records (user_id, record_date, actual_prepare_minutes) values ($1, $2::date, $3)
               on conflict (user_id, record_date) do update set actual_prepare_minutes = excluded.actual_prepare_minutes`,
        [u, `2026-09-0${i + 1}`, mins[i]]);
    }
  }
  await as(A);
  const r = await q(`select user_id, sample_count::int as n from public.v_prepare_time_stats`);
  return r.length === 1 && r[0].user_id === A && r[0].n === 3 ? true : r;
});
await check('updated_at 트리거가 authenticated 요청에서도 돎', async () => {
  await su();
  await q(`update public.profiles set updated_at = now() - interval '1 day' where user_id = $1`, [A]);
  await as(A);
  await q(`update public.profiles set home_name = '집' where user_id = $1`, [A]);
  await su();
  const [r] = await q(`select updated_at > now() - interval '1 minute' as fresh from public.profiles where user_id = $1`, [A]);
  return r.fresh === true ? true : r;
});
await check('모르는 시간대는 거부하고(Mars/Phobos · 빈 값) 아는 시간대는 받음 — 기상 함수가 멈추지 않게', async () => {
  await as(A);
  const bad = await expectErr(() => q(`update public.profiles set timezone = 'Mars/Phobos' where user_id = $1`, [A]), /알 수 없는 시간대/);
  const empty = await expectErr(() => q(`update public.profiles set timezone = '' where user_id = $1`, [A]), /알 수 없는 시간대/);
  const good = await q(`update public.profiles set timezone = 'America/New_York' where user_id = $1 returning timezone`, [A]);
  await q(`update public.profiles set timezone = 'Asia/Seoul' where user_id = $1`, [A]);
  const after = await wake(A);
  return bad === true && empty === true && good.length === 1 && after.length > 0 ? true : { bad, empty, good, after };
});
await check('service_role은 RLS를 무시함 (Edge Function용)', async () => {
  await as(null, 'service_role');
  const r = await q(`select count(distinct user_id)::int as n from public.alarms`);
  return r[0].n >= 4 ? true : r;
});


// ---------------------------------------------------------------------
// 17. 관계가 끝날 때 · 탈퇴
// ---------------------------------------------------------------------

await check('차단: 그 친구 관계의 권한 행이 지워짐 · 차단당한 요청자는 차단을 못 지움 · 아이디 검색에서 숨김', async () => {
  await as(B);
  await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm) values ($1, $2, 'FRIEND', $3, true)`, [B, A, fAB]);
  await q(`update public.friends set status = 'BLOCKED' where friend_id = $1`, [fAB]);
  await su();
  const left = await q(`select 1 from public.sharing_permissions where source_type = 'FRIEND' and source_id = $1`, [fAB]);
  await as(A);
  const del = await q(`delete from public.friends where friend_id = $1 returning 1`, [fAB]);
  const found = await q(`select * from public.find_profile_by_handle('etion')`);
  return left.length === 0 && del.length === 0 && found.length === 0 ? true : { left, del, found };
});
await check('그룹 나가기(LEFT): 그 그룹에서 받은 · 준 권한 행이 지워지고 기상판에서 사라짐', async () => {
  await as(B);
  await q(`update public.group_members set invite_status = 'LEFT' where group_id = $1 and user_id = $2`, [G, B]);
  await su();
  const left = await q(`select 1 from public.sharing_permissions where source_type = 'GROUP' and source_id = $1 and $2 in (owner_id, grantee_id)`, [G, B]);
  const r = await wake(A);
  return left.length === 0 && !r.some((x) => x.user_id === B) ? true : { left, r };
});
await check('나간 사람이 코드로 다시 들어오면 JOINED이고 기상 공유 동의는 꺼짐', async () => {
  await as(B);
  const [g] = await q(`select public.join_group_by_invite_code($1) as g`, [code]);
  const [m] = await q(`select invite_status, wake_share_opt_in, joined_at is not null as j from public.group_members where group_id = $1 and user_id = $2`, [G, B]);
  return g.g === G && m.invite_status === 'JOINED' && m.wake_share_opt_in === false && m.j ? true : { g, m };
});
await check('탈퇴(auth 계정 삭제)는 CASCADE로 지워지고 초대 코드는 그대로', async () => {
  await su();
  await q(`delete from auth.users where id = $1`, [D]);
  const r = await q(`select (select count(*) from public.profiles where user_id = $1)::int as p,
                            (select count(*) from public.group_members where user_id = $1)::int as m,
                            (select count(*) from public.alarms where user_id = $1)::int as a,
                            (select invite_code from public.groups where group_id = $2) as code`, [D, G]);
  return r[0].p === 0 && r[0].m === 0 && r[0].a === 0 && r[0].code === code ? true : r;
});
await check('그룹 삭제: 그 그룹에서 나온 권한 행이 모두 지워지고 코드 교체 트리거도 오류 없이 넘어감', async () => {
  await su();
  const [before] = await q(`select count(*)::int as n from public.sharing_permissions where source_type = 'GROUP' and source_id = $1`, [G]);
  await as(A);
  const del = await q(`delete from public.groups where group_id = $1 returning 1`, [G]);
  await su();
  const [after] = await q(`select count(*)::int as n from public.sharing_permissions where source_type = 'GROUP' and source_id = $1`, [G]);
  return before.n > 0 && del.length === 1 && after.n === 0 ? true : { before, del, after };
});


// ---------------------------------------------------------------------
// 회의 의견 (결정 안건 페이지 /decisions) — 링크를 아는 사람은 로그인 없이 읽고 남김, 고치기 · 지우기 X
// ---------------------------------------------------------------------

const addComment = (id, author, body) => q(
  `insert into public.decision_comments (decision_id, author, body) values ($1, $2, $3) returning id, created_at`, [id, author, body]);

await check('회의 의견: anon이 안건마다 의견을 남기고 모두 읽음 (번호 · 시각은 서버)', async () => {
  await as(null, 'anon');
  await addComment('D35', '지형', '±1시간 내외');
  await addComment('D35', '수연', '30분이면 충분할 듯');
  await addComment('_meeting', '지형', '10/13 회의');
  const r = await q(`select decision_id, author, body, created_at is not null as t from public.decision_comments order by id`);
  return r.length === 3 && r[1].author === '수연' && r.every((x) => x.t) ? true : r;
});
await check('회의 의견: anon은 시각 · 번호를 직접 못 넣고, 고치거나 지우지 못함', async () => {
  await as(null, 'anon');
  const at = await expectErr(() => q(`insert into public.decision_comments (decision_id, author, body, created_at) values ('D1', 'x', 'y', now() - interval '1 day')`), /permission denied/);
  const upd = await expectErr(() => q(`update public.decision_comments set body = '바꿈'`), /permission denied/);
  const del = await expectErr(() => q(`delete from public.decision_comments`), /permission denied/);
  return at === true && upd === true && del === true ? true : { at, upd, del };
});
await check('회의 의견: 안건 번호가 아니거나 이름 · 내용이 비면 못 남김', async () => {
  await as(null, 'anon');
  const badId = await expectErr(() => addComment('profiles', '지형', 'x'), /check constraint/);
  const noName = await expectErr(() => addComment('D1', '  ', 'x'), /check constraint/);
  const noBody = await expectErr(() => addComment('D1', '지형', ' '), /check constraint/);
  return badId === true && noName === true && noBody === true ? true : { badId, noName, noBody };
});

// 투표 · 정한 것 상태
const vote = (id, voter, key, block = 0) => q(
  `insert into public.decision_votes (decision_id, block, voter, option_key) values ($1, $2, $3, $4)
   on conflict (decision_id, block, voter) do update set option_key = excluded.option_key`, [id, block, voter, key]);
const stateOf = async (id) => (await q(`select status, choice, via, decided_by, result, decided_at is not null as decided, code_status, code_ref from public.decision_states where decision_id = $1`, [id]))[0];
const autoLines = async (id) => (await q(`select body from public.decision_comments where decision_id = $1 and author = '자동' order by id`, [id])).map((x) => x.body);

await check('투표: 한 안이 3표가 되면 자동으로 정한 것 + 의견 목록에 [정한 것] 한 줄', async () => {
  await as(null, 'anon');
  await vote('D2', '지형', 'A');
  await vote('D2', '수연', 'B');
  await vote('D2', '준성', 'A');
  const before = await stateOf('D2');
  await vote('D2', '범준', 'A');
  const after = await stateOf('D2');
  const lines = await autoLines('D2');
  return !before && after.status === '정한 것' && after.choice === 'A' && after.via === '투표' && after.decided
    && ['지형', '준성', '범준'].every((v) => after.decided_by.includes(v)) && !after.decided_by.includes('수연')
    && lines.length === 1 && lines[0] === `[정한 것] A안 · 투표 (${after.decided_by})`
    ? true : { before, after, lines };
});
await check('투표: 이미 정한 뒤 표를 바꿔도 결과는 그대로, 다시 정할 것으로 돌리면 표가 비워짐', async () => {
  await as(null, 'anon');
  await vote('D2', '수연', 'A');
  await vote('D2', '수연', 'B');
  const kept = await stateOf('D2');
  await q(`update public.decision_states set status = '정할 것', choice = null, updated_by = '지형' where decision_id = 'D2'`);
  const reopened = await stateOf('D2');
  const [{ n }] = await q(`select count(*)::int as n from public.decision_votes where decision_id = 'D2'`);
  const lines = await autoLines('D2');
  return kept.choice === 'A' && reopened.status === '정할 것' && !reopened.decided && n === 0 && lines[lines.length - 1] === '[다시 정할 것] 지형'
    ? true : { kept, reopened, n, lines };
});
await check('투표: 질문이 여러 개인 안건(block 1 이상)은 3표여도 자동으로 안 정함', async () => {
  await as(null, 'anon');
  for (const v of ['지형', '수연', '준성']) await vote('D29', v, 'A', 1);
  return !(await stateOf('D29')) ? true : await stateOf('D29');
});
await check('직접 정함: 고른 안 · 결과가 남고, 코드 반영 라벨을 바꾸면 [코드] 한 줄', async () => {
  await as(null, 'anon');
  await q(`insert into public.decision_states (decision_id, status, choice, result, via, decided_by, updated_by)
           values ('D5', '정한 것', 'B', '분만 기록', '직접', '수연', '수연')`);
  await q(`update public.decision_states set code_status = '반영됨', code_ref = 'PR #150', updated_by = '지형' where decision_id = 'D5'`);
  const st = await stateOf('D5');
  const lines = await autoLines('D5');
  return st.decided && st.code_status === '반영됨' && lines[0] === '[정한 것] B안 · 수연 — 분만 기록' && lines[1] === '[코드] 반영됨 · PR #150 · 지형'
    ? true : { st, lines };
});
await check('문서에서 정한 안건에 코드 라벨만 붙이면 [코드] 한 줄만 (상태 줄 없음) · upsert 됨', async () => {
  await as(null, 'anon');
  await q(`insert into public.decision_states (decision_id, status, via, code_status, code_ref, updated_by)
           values ('D14', '정한 것', '문서', '반영됨', 'PR #137', '지형')
           on conflict (decision_id) do update set code_status = excluded.code_status, code_ref = excluded.code_ref, updated_by = excluded.updated_by`);
  await q(`insert into public.decision_states (decision_id, status, via, code_status, code_ref, updated_by)
           values ('D14', '정한 것', '문서', '반영됨', 'PR #138', '지형')
           on conflict (decision_id) do update set decision_id = excluded.decision_id, code_ref = excluded.code_ref, updated_by = excluded.updated_by`);
  const lines = await autoLines('D14');
  return lines.length === 2 && lines[0] === '[코드] 반영됨 · PR #137 · 지형' && lines[1] === '[코드] 반영됨 · PR #138 · 지형' ? true : lines;
});
await check('투표 · 상태: anon은 시각을 직접 못 넣고, 상태를 지우지 못함', async () => {
  await as(null, 'anon');
  const at = await expectErr(() => q(`insert into public.decision_states (decision_id, status, decided_at) values ('D6', '정한 것', now())`), /permission denied/);
  const del = await expectErr(() => q(`delete from public.decision_states where decision_id = 'D5'`), /permission denied/);
  const badKey = await expectErr(() => vote('D6', '지형', 'AB'), /check constraint/);
  return at === true && del === true && badKey === true ? true : { at, del, badKey };
});

report();
