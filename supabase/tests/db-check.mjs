// Supabase 마이그레이션 검사 — Docker 없이 PGlite(WASM Postgres)로 돌림
//   1) Supabase 흉내: auth 스키마 · auth.uid() · anon / authenticated / service_role 역할 · 새 객체 자동 GRANT
//      + Realtime · pg_cron · Vault · pg_net 이름 흉내 (마이그레이션이 부르는 realtime.send · cron.schedule · vault.decrypted_secrets · net.http_post)
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
  await db.query(`select set_config('realtime.topic', '', false)`);  // Realtime 채널 흉내도 비움
};

// uid로 로그인한 요청처럼 역할을 바꿈 (PostgREST가 하는 것과 같음)
const as = async (uid, role = 'authenticated') => {
  await su();
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  await db.exec(`set role ${role}`);
};

const svc = () => as(null, 'service_role');

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

// auth 스키마 · 역할 · 기본 권한
const AUTH_STUBS = `
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
`;

// Realtime · pg_cron · Vault · pg_net 흉내 — 마이그레이션이 부르는 이름 · 인자만 실제 Supabase와 같게 만듦
//   realtime.send(payload, event, topic, private) · realtime.topic() · realtime.messages(extension 칸)
//   cron.schedule(job_name, schedule, command) · vault.decrypted_secrets(name, decrypted_secret) · net.http_post(url, body, params, headers, timeout_milliseconds)
//   불러 간 기록이 realtime.messages · cron.job · net.calls에 남아 아래 검사가 읽음
const PLATFORM_STUBS = `
  create schema realtime;
  create table realtime.messages (
    id bigserial primary key,
    topic text not null,
    extension text not null,
    payload jsonb,
    event text,
    private boolean default false,
    inserted_at timestamptz not null default now()
  );
  alter table realtime.messages enable row level security;
  create function realtime.topic() returns text language sql stable
    as $$ select nullif(current_setting('realtime.topic', true), '') $$;
  create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql
    as $$ insert into realtime.messages (topic, extension, payload, event, private) values (topic, 'broadcast', payload, event, private) $$;
  grant usage on schema realtime to anon, authenticated, service_role;
  grant select, insert on realtime.messages to anon, authenticated, service_role;
  grant usage, select on sequence realtime.messages_id_seq to anon, authenticated, service_role;

  create schema cron;
  create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql
    as $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
          on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;

  create schema vault;
  create table vault.decrypted_secrets (name text primary key, decrypted_secret text);

  create schema net;
  create table net.calls (id bigserial primary key, url text, headers jsonb, body jsonb);
  create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
    returns bigint language sql
    as $$ insert into net.calls (url, headers, body) values (url, headers, body) returning id $$;
`;

await db.exec(AUTH_STUBS + PLATFORM_STUBS);
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
// 서버 전용 표 — RLS는 켜고 정책은 없음 (앱은 못 읽고 못 씀, service_role만). 아래 "반복 다음 회차"에서 따로 확인
const SERVER_ONLY = ['roll_attempts'];

await check('모든 public 테이블(앱 20개 — 서버 전용 1개 포함 + 회의 도구 3개)에 RLS가 켜져 있음', async () => {
  const r = await q(`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relkind = 'r' order by 1`);
  const off = r.filter((x) => !x.relrowsecurity).map((x) => x.relname);
  const app = r.filter((x) => !MEETING.includes(x.relname)).length;
  return app === 20 && r.length === 23 && off.length === 0 ? true : { count: r.length, app, off };
});
await check('모든 앱 테이블에 정책이 있고(서버 전용 표 제외) anon용 정책은 없음', async () => {
  const r = await q(`select c.relname, count(p.polname) as n,
                       bool_or(p.polroles @> array['anon'::regrole::oid]) as has_anon
                     from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     left join pg_policy p on p.polrelid = c.oid
                     where n.nspname = 'public' and c.relkind = 'r' group by 1`);
  const bad = r.filter((x) => !MEETING.includes(x.relname) && ((Number(x.n) === 0 && !SERVER_ONLY.includes(x.relname)) || x.has_anon));
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
// 회의 도구 함수(의견 지우기)만 anon 예외 — 아래 "회의 의견"에서 따로 확인
const MEETING_FN = ['delete_decision_comment'];
await check('anon은 함수를 실행할 수 없음 (회의 의견 지우기 하나만 예외)', async () => {
  const r = await q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')`);
  const bad = r.filter((x) => !MEETING_FN.includes(x.proname));
  return bad.length === 0 && r.length === MEETING_FN.length ? true : r;
});
await check('ENUM 21개 값이 4장과 같음 (NORMAL · DEPARTURE · FEEDBACK) + ACKNOWLEDGED + 값 출처 · 기록 출처', async () => {
  const r = await q(`select t.typname, array_agg(e.enumlabel order by e.enumsortorder)::text as v
                     from pg_type t join pg_enum e on e.enumtypid = t.oid group by 1`);
  const m = Object.fromEntries(r.map((x) => [x.typname, x.v]));
  const ok = Object.keys(m).length === 21
    && m.importance_level === '{LOW,NORMAL,HIGH}'
    && m.alarm_type === '{WAKE,PREPARE,DEPARTURE,ARRIVE,ROUTINE}'
    && m.alarm_intensity === '{SOFT,NORMAL,STRONG}'
    && m.alarm_event_type === '{TRIGGERED,SNOOZED,DISMISSED,WAKE_CONFIRMED,ARRIVAL_CONFIRMED,MISSED,FEEDBACK,ACKNOWLEDGED}'
    && m.alarm_value_source === '{AUTO,MANUAL}'
    && m.event_input_source === '{BUTTON,LOCATION,VOICE,MANUAL,USAGE}';
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
// 그룹 기상 상태는 그 그룹에 약속이 있는 날에만 나옴 (F4) → 오늘 10시 그룹 약속을 먼저 만들어 둠

await as(A);
await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name)
         values ($1, $2, '팀 모임(오늘)', ${KST0} + interval '10 hours', '세종대학교')`, [A, G]);
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

// F4: 그 그룹에 약속이 있는 날에만 그룹원 기상 상태가 나옴 (전체작업계획 8.1 F4 · D57)
const wakeOn = async (uid, groupId, dateExpr) => {
  await as(uid);
  return q(`select * from public.get_group_wake_status($1, ${dateExpr})`, [groupId]);
};
await check('F4: 그 그룹에 약속이 없는 날(어제 · 내일)은 빈 결과, 약속을 만들면 그날부터 나옴', async () => {
  const yesterday = await wakeOn(A, G, `${TODAY} - 1`);
  const tomorrowBefore = await wakeOn(A, G, `${TODAY} + 1`);
  await as(A);
  await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name)
           values ($1, $2, '팀 모임(내일)', ${KST0} + interval '1 day 15 hours', '세종대학교')`, [A, G]);
  const tomorrowAfter = await wakeOn(A, G, `${TODAY} + 1`);
  const today = await wakeOn(A, G, TODAY);
  return yesterday.length === 0 && tomorrowBefore.length === 0
    && tomorrowAfter.some((x) => x.user_id === A && x.is_me) && today.some((x) => x.user_id === B)
    ? true : { yesterday, tomorrowBefore, tomorrowAfter, today };
});
await check('F4: 약속이 한 번도 없는 그룹 · 다른 그룹의 약속만 있는 날도 빈 결과', async () => {
  await as(A);
  const [{ group_id: G2 }] = await q(`insert into public.groups (group_name, owner_id) values ('약속 없는 그룹', $1) returning group_id`, [A]);
  const none = await wakeOn(A, G2, TODAY);
  await as(A);
  await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name)
           values ($1, $2, '다른 그룹 약속', ${KST0} + interval '3 days 10 hours', '세종대학교')`, [A, G2]);
  const otherGroupOnly = await wakeOn(A, G, `${TODAY} + 3`);
  const own = await wakeOn(A, G2, `${TODAY} + 3`);
  await as(A);
  await q(`delete from public.groups where group_id = $1`, [G2]);
  return none.length === 0 && otherGroupOnly.length === 0 && own.length === 1 && own[0].wake_status === 'NO_ALARM'
    ? true : { none, otherGroupOnly, own };
});
await check('F4: 약속 날짜는 호출자 시간대 기준 (한국 자정 직전 약속은 그날, 직후 약속은 다음날)', async () => {
  await as(A);
  await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name) values
    ($1, $2, '밤 약속', ${KST0} + interval '5 days 23 hours 59 minutes', 's'),
    ($1, $2, '새벽 약속', ${KST0} + interval '7 days 1 minute', 's')`, [A, G]);
  const d5 = await wakeOn(A, G, `${TODAY} + 5`);
  const d6 = await wakeOn(A, G, `${TODAY} + 6`);
  const d7 = await wakeOn(A, G, `${TODAY} + 7`);
  await as(A);
  await q(`delete from public.appointments where group_id = $1 and title in ('밤 약속', '새벽 약속')`, [G]);
  return d5.length > 0 && d6.length === 0 && d7.length > 0 ? true : { d5: d5.length, d6: d6.length, d7: d7.length };
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
// 12-2. 기상 신호 (Q3 A) — alarm_events에 기상 기록이 들어오면 약속이 있는 그룹의 채널로 "새로 고침" 신호만
// ---------------------------------------------------------------------
// 채널 group:<group_id>:wake · 이벤트 refresh · 내용은 날짜뿐. realtime.send는 흉내(realtime.messages에 쌓음)
// 보내는 조건: 기록한 사람이 그 그룹에 JOINED + 기상 공유 동의(wake_share_opt_in, D19 결정 전 보수 기본값) + 기록한 날 그 그룹에 약속이 있음
// 지금 상태: B는 G에서 동의함, C는 동의 안 함(11절에서 끔), D는 동의함 → 기록한 사람은 동의한 B로 시험하고 C는 "동의 없음" 시험에 씀

const signals = async () => {
  await su();
  return q(`select topic, event, private, extension, payload from realtime.messages order by id`);
};
const clearSignals = async () => {
  await su();
  await q(`truncate realtime.messages`);
};
const logEvent = (uid, alarm, type, at = null) => q(
  `insert into public.alarm_events (alarm_id, user_id, event_type${at ? ', event_at' : ''}) values ($1, $2, $3${at ? ', ' + at : ''})`, [alarm, uid, type]);

await check('기상 신호: 기상 알람이 울리면 오늘 약속이 있는 그룹 채널로 refresh만 보냄 (날짜만 담고 누구의 기록인지는 안 담음)', async () => {
  await clearSignals();
  await as(B);
  await logEvent(B, ids[B].alarm, 'TRIGGERED');
  const r = await signals();
  const [{ d }] = await q(`select ${TODAY}::text as d`);
  return r.length === 1 && r[0].topic === `group:${G}:wake` && r[0].event === 'refresh' && r[0].private === true
    && r[0].extension === 'broadcast' && JSON.stringify(r[0].payload) === JSON.stringify({ date: d })
    ? true : r;
});
await check('기상 신호: 기상 공유에 동의 안 한 사람의 기록은 신호가 안 가고, 동의하면 가고, 끄면 다시 안 감 (D19 결정 전 보수 기본값)', async () => {
  const fire = async () => {
    await clearSignals();
    await as(C);
    await logEvent(C, ids[C].alarm, 'TRIGGERED');
    return (await signals()).length;
  };
  const off = await fire();
  await as(C);
  await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [G, C]);
  const on = await fire();
  await as(C);
  await q(`update public.group_members set wake_share_opt_in = false where group_id = $1 and user_id = $2`, [G, C]);
  const offAgain = await fire();
  return off === 0 && on === 1 && offAgain === 0 ? true : { off, on, offAgain };
});
await check('기상 신호: 서버(service_role)가 넣은 MISSED 기록도 같은 규칙으로 신호가 감 (wake-check)', async () => {
  await clearSignals();
  await svc();
  await q(`insert into public.alarm_events (alarm_id, user_id, event_type) values ($1, $2, 'MISSED')`, [ids[B].alarm, B]);
  const dongui = await signals();
  await clearSignals();
  await svc();
  await q(`insert into public.alarm_events (alarm_id, user_id, event_type) values ($1, $2, 'MISSED')`, [ids[C].alarm, C]);   // 동의 안 한 C
  const none = await signals();
  return dongui.length === 1 && dongui[0].topic === `group:${G}:wake` && none.length === 0 ? true : { dongui, none };
});
await check('기상 신호: 동의했어도 그날 약속이 없는 그룹에는 안 가고, 약속이 없는 날의 기록에도 안 감 (매일 추적하지 않음, F4)', async () => {
  await as(B);
  const [{ group_id: G3 }] = await q(`insert into public.groups (group_name, owner_id) values ('약속 없는 그룹', $1) returning group_id`, [B]);
  await q(`update public.group_members set wake_share_opt_in = true where group_id = $1 and user_id = $2`, [G3, B]);   // 동의는 했지만 약속이 없음
  await clearSignals();
  await as(B);
  await logEvent(B, ids[B].alarm, 'DISMISSED');
  const today = await signals();
  await clearSignals();
  await as(B);
  await logEvent(B, ids[B].alarm, 'DISMISSED', `${KST0} - interval '1 hour'`);   // 어제 밤 11시 — 어제는 이 그룹에 약속이 없음
  const yesterday = await signals();
  await as(B);
  await q(`delete from public.groups where group_id = $1`, [G3]);
  return today.length === 1 && today[0].topic === `group:${G}:wake` && yesterday.length === 0 ? true : { today, yesterday };
});
await check('기상 신호: 기상 알람의 울림 · 미루기 · 해제 · 미확인과 기상 확인만 보내고, 준비 알람 · 원탭 응답 · 도착 확인은 안 보냄', async () => {
  await as(B);
  const [{ alarm_id: prep }] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at)
                                        values ($1, $2, 'PREPARE', ${KST0} + interval '08:30') returning alarm_id`, [ids[B].part, B]);
  const sent = {};
  for (const [label, alarm, type] of [
    ['WAKE 울림', ids[B].alarm, 'TRIGGERED'], ['WAKE 미루기', ids[B].alarm, 'SNOOZED'], ['WAKE 해제', ids[B].alarm, 'DISMISSED'],
    ['WAKE 미확인', ids[B].alarm, 'MISSED'], ['WAKE 기상 확인', ids[B].alarm, 'WAKE_CONFIRMED'],
    ['WAKE 원탭 응답', ids[B].alarm, 'ACKNOWLEDGED'], ['WAKE 도착 확인', ids[B].alarm, 'ARRIVAL_CONFIRMED'],
    ['PREPARE 울림', prep, 'TRIGGERED'], ['PREPARE 원탭 응답', prep, 'ACKNOWLEDGED'], ['PREPARE 해제', prep, 'DISMISSED'],
    ['PREPARE 기상 확인', prep, 'WAKE_CONFIRMED'],
  ]) {
    await clearSignals();
    await as(B);
    await logEvent(B, alarm, type);
    sent[label] = (await signals()).length;
  }
  await as(B);
  await q(`delete from public.alarms where alarm_id = $1`, [prep]);
  const expected = { 'WAKE 울림': 1, 'WAKE 미루기': 1, 'WAKE 해제': 1, 'WAKE 미확인': 1, 'WAKE 기상 확인': 1, 'WAKE 원탭 응답': 0, 'WAKE 도착 확인': 0,
    'PREPARE 울림': 0, 'PREPARE 원탭 응답': 0, 'PREPARE 해제': 0, 'PREPARE 기상 확인': 1 };   // 기상 확인은 get_group_wake_status처럼 알람 종류를 안 봄
  return JSON.stringify(sent) === JSON.stringify(expected) ? true : sent;
});
await check('기상 신호 받기: 그 그룹에 참여 중인 사람만 (비구성원 · 다른 그룹 · 이상한 채널 이름은 못 받음), 앱은 이 채널로 보낼 수 없음', async () => {
  await clearSignals();
  await as(B);
  await logEvent(B, ids[B].alarm, 'TRIGGERED');
  const seen = async (uid, topic) => {
    await as(uid);
    await q(`select set_config('realtime.topic', $1, false)`, [topic]);
    return (await q(`select id from realtime.messages`)).length;
  };
  const mine = `group:${G}:wake`;
  const member = [await seen(A, mine), await seen(B, mine), await seen(C, mine)];
  const outsider = await seen(E, mine);
  const otherGroup = await seen(A, 'group:66666666-6666-4666-8666-666666666666:wake');
  const weird = [await seen(A, 'group:not-a-uuid:wake'), await seen(A, `group:${G}`), await seen(A, 'room1'), await seen(A, '')];
  await as(A);
  await q(`select set_config('realtime.topic', $1, false)`, [mine]);
  const send = await expectErr(() => q(`insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}')`, [mine]), /row-level security/);
  return member.every((n) => n === 1) && outsider === 0 && otherGroup === 0 && weird.every((n) => n === 0) && send === true
    ? true : { member, outsider, otherGroup, weird, send };
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
await check('4장 CHECK 제약 (알람 출처 · 루틴 단계 · 제안 결과 · 범위) — 출처 없는 알람(일정 없는 알람)은 D46으로 허용, 아래 "DB 보완"에서 확인', async () => {
  await su();
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
  return [both, noStep, sugg, resp, off, steps, sat].every((x) => x === true)
    ? true : { both, noStep, sugg, resp, off, steps, sat };
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
await check('v_prepare_time_stats: 기상~출발 240분 넘는 실측은 학습 표본에서만 빠지고 기록(daily_records)은 남음 (D107)', async () => {
  await as(C);
  for (const [i, m] of [60, 240, 241, 600].entries()) {
    await q(`insert into public.daily_records (user_id, record_date, actual_prepare_minutes) values ($1, $2::date, $3)
             on conflict (user_id, record_date) do update set actual_prepare_minutes = excluded.actual_prepare_minutes`,
      [C, `2026-08-0${i + 1}`, m]);
  }
  const stat = await q(`select sample_count::int as n, p80_minutes::float8 as p80 from public.v_prepare_time_stats where user_id = $1`, [C]);
  const rec = await q(`select actual_prepare_minutes as m from public.daily_records where user_id = $1 and actual_prepare_minutes is not null order by m`, [C]);
  const kept = rec.map((x) => x.m).join(',');
  // 60 · 240 두 건만 셈 → P80 = 60 + (240 − 60) × 0.8 = 204
  return stat.length === 1 && stat[0].n === 2 && Math.abs(stat[0].p80 - 204) < 0.001 && kept === '60,240,241,600' ? true : { stat, kept };
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
// DB 보완 (10/15 작업 계획 P3) — 일정 없는 알람 · 기록 중복 방지 · 고친 값 기록 · G04 약속 정보 · 푸시 권한 · MISSED 후보 · 배치
// ---------------------------------------------------------------------

// 일정 없는 알람 (D46) — 서버(alarm-commit)만 만듦
await check('일정 없는 알람: 약속 · 루틴이 둘 다 없는 알람을 서버가 만들고(기본 AUTO · 반복 규칙 저장), 앱의 직접 INSERT는 막고, 둘 다 있으면 막음', async () => {
  await svc();
  const rule = 'FREQ=WEEKLY;BYDAY=MO,WE,FR';
  const [made] = await q(`insert into public.alarms (user_id, alarm_type, scheduled_at, recurrence_rule) values ($1, 'WAKE', ${KST0} + interval '1 day 06:00', $2) returning *`, [A, rule]);
  const [second] = await q(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'WAKE', ${KST0} + interval '1 day 06:10') returning alarm_id`, [A]);   // 유니크 제한 없음
  await as(A);
  const direct = await expectErr(() => q(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'WAKE', now())`, [A]), /row-level security/);
  await su();
  const [{ rt }] = await q(`insert into public.routines (user_id, title) values ($1, '일정 없는 알람 시험') returning routine_id as rt`, [A]);
  const both = await expectErr(() => q(`insert into public.alarms (participant_id, routine_id, step_order, user_id, alarm_type, scheduled_at)
     values ($1, $2, 1, $3, 'ROUTINE', now())`, [ids[A].part, rt, A]), /alarms_one_source/);
  const longRule = await expectErr(() => q(`insert into public.alarms (user_id, alarm_type, scheduled_at, recurrence_rule) values ($1, 'WAKE', now(), $2)`, [A, 'x'.repeat(101)]), /value too long/);
  const badSource = await expectErr(() => q(`insert into public.alarms (user_id, alarm_type, scheduled_at, time_source) values ($1, 'WAKE', now(), 'SOMETIMES')`, [A]), /invalid input value for enum/);
  // 주인은 읽고 · 직접 고름으로 바꾸고 · 지울 수 있음, 일정에 붙일 수는 없음
  await as(A);
  const mine = await q(`select 1 from public.alarms where alarm_id = $1`, [made.alarm_id]);
  const upd = await q(`update public.alarms set time_source = 'MANUAL', intensity_source = 'MANUAL' where alarm_id = $1 returning time_source, intensity_source`, [made.alarm_id]);
  const attach = await expectErr(() => q(`update public.alarms set participant_id = $1 where alarm_id = $2`, [ids[A].part, made.alarm_id]), /바꿀 수 없음/);
  const del = await q(`delete from public.alarms where alarm_id in ($1, $2) returning 1`, [made.alarm_id, second.alarm_id]);
  await su();
  await q(`delete from public.routines where routine_id = $1`, [rt]);
  return made.participant_id === null && made.routine_id === null && made.time_source === 'AUTO' && made.intensity_source === 'AUTO' && made.recurrence_rule === rule
    && direct === true && both === true && longRule === true && badSource === true
    && mine.length === 1 && upd[0].time_source === 'MANUAL' && upd[0].intensity_source === 'MANUAL' && attach === true && del.length === 2
    ? true : { made, direct, both, longRule, badSource, mine, upd, attach, del };
});

// 울림 기록 중복 방지 (Q11 A) · 입력 출처
await check('울림 기록: 같은 client_event_id는 on conflict do nothing으로 한 번만 저장되고, 번호가 없는 기록은 여러 개 · 입력 출처는 5가지만', async () => {
  const X = '99999999-9999-4999-8999-999999999999';
  await as(A);
  const ins = (extra = '', params = []) => q(`insert into public.alarm_events (alarm_id, user_id, event_type, client_event_id, input_source)
    values ($1, $2, 'ACKNOWLEDGED', $3, $4) ${extra}`, [ids[A].alarm, A, ...params]);
  const first = await ins('on conflict (client_event_id) do nothing returning event_id', [X, 'BUTTON']);
  const again = await ins('on conflict (client_event_id) do nothing returning event_id', [X, 'LOCATION']);
  const plain = await expectErr(() => ins('', [X, 'BUTTON']), /alarm_events_client_event_id_key|duplicate/);
  const count = await q(`select input_source from public.alarm_events where client_event_id = $1`, [X]);
  const noKey = await ins('returning event_id', [null, null]);
  const noKey2 = await ins('returning event_id', [null, null]);
  const sources = [];
  for (const s of ['BUTTON', 'LOCATION', 'VOICE', 'MANUAL', 'USAGE']) sources.push((await ins('returning input_source', [null, s]))[0].input_source);
  const bad = await expectErr(() => ins('', [null, 'GPS']), /invalid input value for enum/);
  return first.length === 1 && again.length === 0 && plain === true && count.length === 1 && count[0].input_source === 'BUTTON'
    && noKey.length === 1 && noKey2.length === 1 && sources.join() === 'BUTTON,LOCATION,VOICE,MANUAL,USAGE' && bad === true
    ? true : { first, again, plain, count, noKey, noKey2, sources, bad };
});

// 고친 값 기록 (F5 · F9)
let dEditLogs = 0;   // D의 고친 값 기록 수 — 탈퇴 검사에서 CASCADE로 지워졌는지 봄
await check('고친 값 기록: 본인 이름으로 남기고 되돌리기(고친 값 NULL)도 받고 본인만 읽고 지움 (남의 이름 · 남의 일정 · 남의 알람은 못 붙임, 고치기 없음) · 지워진 일정 · 알람은 set null', async () => {
  await as(A);
  const [log] = await q(`insert into public.user_edit_logs (appointment_id, alarm_id, screen, field, alarm_type, auto_value, edited_value)
     values ($1, $2, 'H03', 'buffer_minutes', 'WAKE', '10', '15') returning *`, [ids[A].appt, ids[A].alarm]);
  const [obj] = await q(`insert into public.user_edit_logs (screen, field, edited_value) values ('S01', 'scheduled_at', '{"at":"07:10"}') returning auto_value, edited_value`);
  await as(B);
  const others = await q(`select 1 from public.user_edit_logs`);
  const upd = await expectErr(() => q(`update public.user_edit_logs set field = 'x' where edit_id = $1`, [log.edit_id]), /permission denied/);
  const del = await q(`delete from public.user_edit_logs where edit_id = $1 returning 1`, [log.edit_id]);
  await as(A);
  const forgeUser = await expectErr(() => q(`insert into public.user_edit_logs (user_id, screen, field, edited_value) values ($1, 'H03', 'intensity', '"STRONG"')`, [B]), /row-level security/);
  const forgeAlarm = await expectErr(() => q(`insert into public.user_edit_logs (alarm_id, screen, field, edited_value) values ($1, 'H03', 'intensity', '"STRONG"')`, [ids[B].alarm]), /row-level security/);
  const forgeAppt = await expectErr(() => q(`insert into public.user_edit_logs (appointment_id, screen, field, edited_value) values ($1, 'H03', 'intensity', '"STRONG"')`, [ids[B].appt]), /row-level security/);
  // 모양: 화면은 허용 목록 안의 값만(목록 전체는 아래 "위치 감지 칸" 검사), 값 이름은 소문자 · 숫자 · _ (목록은 닫지 않음), 고친 값은 필수
  const badScreen = await expectErr(() => q(`insert into public.user_edit_logs (screen, field, edited_value) values ('H99', 'intensity', '1')`), /user_edit_logs_screen_check/);
  const badField = await expectErr(() => q(`insert into public.user_edit_logs (screen, field, edited_value) values ('H03', 'Buffer Minutes', '1')`), /user_edit_logs_field_format/);
  // 되돌리기("자동으로 되돌리기")는 고친 값이 NULL — 앱이 JSON null을 보내면 PostgREST가 SQL NULL로 넣음
  const [revert] = await q(`insert into public.user_edit_logs (screen, field, auto_value, edited_value) values ('H03', 'scheduled_at', '"07:00"', null) returning auto_value, edited_value`);
  const [bare] = await q(`insert into public.user_edit_logs (screen, field) values ('H03', 'intensity') returning auto_value, edited_value`);
  const fields = ['buffer_minutes', 'prepare_minutes', 'travel_minutes', 'origin', 'transport', 'intensity', 'voice_tone', 'sound_key', 'alarm_enabled', 'scheduled_at'];
  for (const f of fields) await q(`insert into public.user_edit_logs (screen, field, edited_value) values ('H03', $1, '1')`, [f]);
  // 일정 · 알람이 지워져도 기록은 남음
  await svc();
  const [{ alarm_id: tmp }] = await q(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'WAKE', now()) returning alarm_id`, [A]);
  await as(A);
  await q(`insert into public.user_edit_logs (alarm_id, screen, field, edited_value) values ($1, 'H03', 'alarm_enabled', 'false')`, [tmp]);
  await q(`delete from public.alarms where alarm_id = $1`, [tmp]);
  const kept = await q(`select alarm_id from public.user_edit_logs where field = 'alarm_enabled' and edited_value = 'false'::jsonb`);
  const [mine] = await q(`select count(*)::int as n from public.user_edit_logs`);
  const delMine = await q(`delete from public.user_edit_logs returning 1`);
  // D의 기록은 탈퇴 검사(아래)에서 CASCADE로 지워지는지 봄
  await as(D);
  await q(`insert into public.user_edit_logs (screen, field, edited_value) values ('H05', 'prepare_minutes', '30')`);
  dEditLogs = (await q(`select count(*)::int as n from public.user_edit_logs`))[0].n;
  return log.user_id === A && log.auto_value === 10 && log.edited_value === 15 && log.alarm_type === 'WAKE' && log.created_at
    && obj.auto_value === null && obj.edited_value.at === '07:10'
    && others.length === 0 && upd === true && del.length === 0
    && forgeUser === true && forgeAlarm === true && forgeAppt === true
    && badScreen === true && badField === true
    && revert.auto_value === '07:00' && revert.edited_value === null && bare.auto_value === null && bare.edited_value === null
    && kept.length === 1 && kept[0].alarm_id === null && mine.n === 2 + 2 + fields.length + 1 && delMine.length === mine.n
    ? true : { log, obj, others, upd, del, forgeUser, forgeAlarm, forgeAppt, badScreen, badField, revert, bare, kept, mine, delMine };
});

// G04 약속 정보 (screen-data-map G04)
await check('G04 약속 정보: 조회 권한(친구 · 그룹)을 받은 사람의 알람 약속만 제목 · 장소 · 시각으로 나옴 — 권한 없음 · 외부인 · 약속 없는 알람 · 권한 회수 뒤는 안 나옴', async () => {
  await svc();
  await q(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'WAKE', ${KST0} + interval '9 hours')`, [B]);   // B의 일정 없는 알람
  await as(A);
  const before = await q(`select * from public.get_shared_alarm_appointments()`);
  await as(B);
  const [{ permission_id: pf }] = await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm)
     values ($1, $2, 'FRIEND', $3, true) returning permission_id`, [B, A, fAB]);
  await as(A);
  const all = await q(`select * from public.get_shared_alarm_appointments()`);
  const byB = await q(`select * from public.get_shared_alarm_appointments($1)`, [B]);
  const byC = await q(`select * from public.get_shared_alarm_appointments($1)`, [C]);
  await as(E);
  const outsider = await q(`select * from public.get_shared_alarm_appointments()`);
  await as(C);
  const stranger = await q(`select * from public.get_shared_alarm_appointments()`);   // C는 아무도에게 알람 조회 권한을 못 받음
  await as(B);
  await q(`delete from public.sharing_permissions where permission_id = $1`, [pf]);
  await as(A);
  const revoked = await q(`select * from public.get_shared_alarm_appointments()`);
  // 그룹으로 받은 조회 권한도 같음
  await as(B);
  await q(`update public.sharing_permissions set can_view_alarm = true where permission_id = $1`, [pGroupBA]);
  await as(A);
  const viaGroup = await q(`select * from public.get_shared_alarm_appointments()`);
  await as(B);
  await q(`update public.sharing_permissions set can_view_alarm = false where permission_id = $1`, [pGroupBA]);
  await svc();
  await q(`delete from public.alarms where user_id = $1 and participant_id is null and routine_id is null`, [B]);
  const row = all[0] ?? {};
  return before.length === 0 && all.length === 1 && byB.length === 1 && byC.length === 0
    && row.alarm_id === ids[B].alarm && row.user_id === B && row.appointment_id === ids[B].appt
    && row.title === '개인 일정' && row.dest_name === '세종대학교' && row.appointment_at
    && Object.keys(row).sort().join() === 'alarm_id,appointment_at,appointment_id,dest_name,title,user_id'
    && outsider.length === 0 && stranger.length === 0 && revoked.length === 0 && viaGroup.length === 1 && viaGroup[0].alarm_id === ids[B].alarm
    ? true : { before, all, byB, byC, outsider, stranger, revoked, viaGroup };
});

// 푸시 보내도 되는지 (notify)
await check('푸시 권한 확인(can_send_push): ALARM_CHANGED는 보내는 사람이 받는 사람 알람의 설정 권한(친구 ∪ 그룹)을 가졌을 때만, WAKE_PING은 D19 뒤라 항상 거절', async () => {
  const can = async (s, t, k) => {
    await svc();
    return (await q(`select public.can_send_push($1, $2, $3) as ok`, [s, t, k]))[0].ok;
  };
  const none = await can(A, B, 'ALARM_CHANGED');
  await as(B);
  const [{ permission_id: pe }] = await q(`insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm, can_view_wake)
     values ($1, $2, 'FRIEND', $3, true, true, true) returning permission_id`, [B, A, fAB]);
  const yes = await can(A, B, 'ALARM_CHANGED');
  const reverse = await can(B, A, 'ALARM_CHANGED');
  const stranger = await can(A, C, 'ALARM_CHANGED');
  const ping = await can(A, B, 'WAKE_PING');
  const unknown = await can(A, B, 'SOMETHING');
  const nulls = [await can(null, B, 'ALARM_CHANGED'), await can(A, null, 'ALARM_CHANGED'), await can(A, B, null)];
  await as(B);
  await q(`update public.sharing_permissions set can_edit_alarm = false where permission_id = $1`, [pe]);
  const viewOnly = await can(A, B, 'ALARM_CHANGED');
  await as(B);
  await q(`update public.sharing_permissions set can_edit_alarm = true where permission_id = $1`, [pGroupBA]);   // 그룹으로 받은 설정 권한
  const viaGroup = await can(A, B, 'ALARM_CHANGED');
  await as(B);
  await q(`update public.sharing_permissions set can_edit_alarm = false where permission_id = $1`, [pGroupBA]);
  await q(`delete from public.sharing_permissions where permission_id = $1`, [pe]);
  const after = await can(A, B, 'ALARM_CHANGED');
  await as(A);
  const app = await expectErr(() => q(`select public.can_send_push($1, $2, 'ALARM_CHANGED')`, [A, B]), /permission denied for function/);
  return none === false && yes === true && reverse === false && stranger === false && ping === false && unknown === false
    && nulls.every((x) => x === false) && viewOnly === false && viaGroup === true && after === false && app === true
    ? true : { none, yes, reverse, stranger, ping, unknown, nulls, viewOnly, viaGroup, after, app };
});

// 기상 미확인 후보 (7.9.2)
await check('MISSED 후보(find_missed_wake_alarms): 알람 시각(마지막 미루기 뒤면 그 울림 시각) + 다시 울림 총 소요(끝난 뒤 간격 기준 약 11 · 보통 19 · 강 21분) + 30분이 지난 켜진 기상 알람만, 기상 확인 · 미확인 기록이 있으면 뺌', async () => {
  const T = '2026-03-01 07:00:00+09';
  const at = (hhmm) => `2026-03-01 ${hhmm}:00+09`;
  await svc();
  const label = {};
  const mk = async (name, user, { intensity = 'NORMAL', type = 'WAKE', enabled = true, when = T, participant = null } = {}) => {
    const [{ alarm_id }] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at, intensity, is_enabled)
      values ($1, $2, $3, $4, $5, $6) returning alarm_id`, [participant, user, type, when, intensity, enabled]);
    label[alarm_id] = name;
    return alarm_id;
  };
  const ev = (alarm, user, type, when, snooze = null) => q(
    `insert into public.alarm_events (alarm_id, user_id, event_type, event_at, snooze_minutes) values ($1, $2, $3, $4, $5)`, [alarm, user, type, when, snooze]);
  // 공동 약속에 붙은 기상 알람 (약속 정보를 같이 돌려주는지)
  const [{ appointment_id: apId }] = await q(`insert into public.appointments (creator_id, group_id, title, appointment_at, dest_name)
     values ($1, $2, '시험 약속', $3, '세종대학교') returning appointment_id`, [A, G, at('10:00')]);
  const [{ participant_id: ptId }] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [apId, A]);

  const soft = await mk('soft', A, { intensity: 'SOFT' });
  const strong = await mk('strong', A, { intensity: 'STRONG' });
  const normal = await mk('normal', A, { participant: ptId });
  const snoozed = await mk('snoozed', A, { intensity: 'SOFT' });
  await ev(snoozed, A, 'SNOOZED', at('07:01'), 5);
  await ev(snoozed, A, 'SNOOZED', at('07:06'), 10);
  const prevDay = await mk('prevDay', A);   // 전날 기록은 이번 회차로 안 셈
  await ev(prevDay, A, 'WAKE_CONFIRMED', '2026-02-28 07:05:00+09');
  const confirmed = await mk('confirmed', C);   // 기상 확인은 그 사람 기준이라, 다른 알람이 가려지지 않게 다른 사람(C)에게 둠
  await ev(confirmed, C, 'WAKE_CONFIRMED', at('07:20'));
  const missed = await mk('missed', A);
  await ev(missed, A, 'MISSED', at('07:41'));
  await mk('disabled', A, { enabled: false });
  await mk('prepare', A, { type: 'PREPARE' });
  await mk('old', A, { when: '2026-02-27 07:00:00+09' });   // 알람 시각이 24시간보다 오래됨
  // 해제(DISMISSED)만 · 원탭 응답(ACKNOWLEDGED)만 있는 알람은 기상 확인이 아니므로 미확인 대상 (7.9.2 "해제를 전제로 하지 않음" · SD-2)
  const dismissedOnly = await mk('dismissedOnly', A);
  await ev(dismissedOnly, A, 'DISMISSED', at('07:02'));
  const ackOnly = await mk('ackOnly', A);
  await ev(ackOnly, A, 'ACKNOWLEDGED', at('07:03'));
  await mk('dailyRecord', B);
  await mk('dailyRecord2', B, { when: at('09:00') });   // 같은 사람의 두 번째 기상 알람 — 생활 기록 하나로 둘 다 확인된 것으로 봄
  await q(`insert into public.daily_records (user_id, record_date, wake_confirmed_at) values ($1, '2026-03-01', $2)`, [B, at('07:10')]);   // 이벤트가 없어도 생활 기록에 기상 확인이 있음

  const at_ = async (hhmm) => {
    await svc();
    const r = await q(`select * from public.find_missed_wake_alarms($1::timestamptz)`, [at(hhmm)]);
    return { rows: r, names: r.map((x) => label[x.alarm_id]).filter(Boolean).sort().join() };
  };
  // 다시 울림 총 소요(첫 울림 시작 ~ 마지막 울림 끝): 약 3+5+3=11분 · 보통 3+5+3+5+3=19분 · 강 3×4 + 3×3=21분 (알람 코어와 같은 끝난 뒤 간격 기준)
  // 판정 시각 = (마지막으로 울리기 시작한 때) + 총 소요 + 30분 → soft 07:41 · normal류 07:49 · strong 07:51
  //   snoozed(SOFT): 마지막 미루기 07:06 + 10분 = 07:16에 다시 울림 시작 → 07:16 + 11 + 30 = 07:57 (미루기 합 15분을 단순히 더한 07:56이 아님)
  const t40 = await at_('07:40');
  const t41 = await at_('07:41');
  const t48 = await at_('07:48');
  const t49 = await at_('07:49');
  const t51 = await at_('07:51');
  const t55 = await at_('07:55');
  const t56 = await at_('07:56');
  const t57 = await at_('07:57');
  const t100 = await at_('10:00');   // 두 번째 기상 알람(09:00)도 판정 시각(09:49)이 지남
  const byName = (res, n) => res.rows.find((x) => label[x.alarm_id] === n);
  const s = byName(t41, 'soft');
  const sn = byName(t57, 'snoozed');
  const ap = byName(t49, 'normal');
  const keys = t57.rows.map((x) => x.event_key);
  const again = (await at_('07:57')).rows.map((x) => x.event_key);
  await svc();
  const noArgs = await q(`select * from public.find_missed_wake_alarms()`);   // 안 주면 지금 기준 — 오류 없이 돎

  await q(`delete from public.alarms where alarm_id = any($1::uuid[])`, [Object.keys(label)]);
  await q(`delete from public.appointments where appointment_id = $1`, [apId]);
  await q(`delete from public.daily_records where record_date = '2026-03-01'`);
  const iso = (t) => new Date(t).toISOString();
  const normalSet = 'ackOnly,dismissedOnly,normal,prevDay,soft';
  return t40.names === '' && t41.names === 'soft' && t48.names === 'soft' && t49.names === normalSet
    && t51.names === 'ackOnly,dismissedOnly,normal,prevDay,soft,strong' && t55.names === t51.names
    && t56.names === t51.names && t57.names === 'ackOnly,dismissedOnly,normal,prevDay,snoozed,soft,strong' && t100.names === t57.names
    && s.rering_minutes === 11 && s.snooze_minutes === 0 && iso(s.missed_at) === iso(at('07:41')) && s.intensity === 'SOFT'
    && sn.rering_minutes === 11 && sn.snooze_minutes === 15 && iso(sn.missed_at) === iso(at('07:57'))
    && byName(t49, 'normal').rering_minutes === 19 && byName(t51, 'strong').rering_minutes === 21
    && ap.appointment_id === apId && ap.group_id === G && iso(ap.appointment_at) === iso(at('10:00')) && ap.participant_id === ptId && ap.user_id === A
    && s.appointment_id === null && s.group_id === null
    && new Set(keys).size === keys.length && keys.every((k) => /^[0-9a-f-]{36}$/.test(k)) && JSON.stringify(keys) === JSON.stringify(again)
    && Array.isArray(noArgs)
    ? true : { t40: t40.names, t41: t41.names, t48: t48.names, t49: t49.names, t51: t51.names, t55: t55.names, t56: t56.names, t57: t57.names, t100: t100.names, normalSet, s, sn, ap, keys };
});

await check('MISSED 후보: 기상 확인은 그 사람 기준(어느 기상 알람이든) · 확인 구간은 알람 시각 6시간 전 ~ 18시간 뒤 · 미룬 뒤 기준은 폰과 같게(마지막 미루기 + 미루기 시간 + 총 소요 + 30분)', async () => {
  const at = (day, hhmm) => `2026-03-${day} ${hhmm}:00+09`;
  await svc();
  const label = {};
  const mk = async (name, user, when, intensity = 'NORMAL') => {
    const [{ alarm_id }] = await q(`insert into public.alarms (user_id, alarm_type, scheduled_at, intensity) values ($1, 'WAKE', $2, $3) returning alarm_id`, [user, when, intensity]);
    label[alarm_id] = name;
    return alarm_id;
  };
  const ev = (alarm, user, type, when, snooze = null) => q(
    `insert into public.alarm_events (alarm_id, user_id, event_type, event_at, snooze_minutes) values ($1, $2, $3, $4, $5)`, [alarm, user, type, when, snooze]);
  const run = async (day, hhmm, lookback = 24) => {
    await svc();
    const rows = await q(`select * from public.find_missed_wake_alarms($1::timestamptz, $2)`, [at(day, hhmm), lookback]);
    const names = (prefix) => rows.map((x) => label[x.alarm_id]).filter((n) => n && n.startsWith(prefix)).sort().join();
    return { rows, names };
  };

  // (a) 같은 날 기상 알람이 둘(07:00 · 09:00): A는 첫 알람에서 기상 확인 → 그룹 현황판이 '기상'으로 세는 사람이라 둘째 알람도 확인된 것
  //     B는 첫 알람에만 미확인(MISSED) 기록 — 미확인은 알람마다라서 둘째 알람은 그대로 후보
  const a1 = await mk('a1', A, at('02', '07:00'));
  const a2 = await mk('a2', A, at('02', '09:00'));
  await ev(a1, A, 'WAKE_CONFIRMED', at('02', '07:10'));
  const b1 = await mk('b1', B, at('02', '07:00'));
  await mk('b2', B, at('02', '09:00'));
  await ev(b1, B, 'MISSED', at('02', '07:50'));

  // (b) 보통 강도, 늦게 두 번 미룸: 07:18 미룸(10분) → 07:28 울림 → 07:46 미룸(10분) → 07:56 울림 시작 → 08:15 끝 (폰: 알람 시각 + 75분)
  //     미루기 합(20분)만 더하면 69분(08:09)에 나가 폰이 아직 울리는 중 — 마지막 울림 시작 07:56 + 19분 + 30분 = 08:45
  //     기록은 올라온 순서가 뒤바뀌어도(폰이 오프라인) event_at이 늦은 쪽을 마지막으로 봄
  const c1 = await mk('c1', C, at('02', '07:00'));
  await ev(c1, C, 'SNOOZED', at('02', '07:46'), 10);
  await ev(c1, C, 'SNOOZED', at('02', '07:18'), 10);

  // (c) 다음 날 아침 확인이 전날 알람을 덮지 않음: 3/2 07:00 알람(확인 없음) · 3/3 07:00 알람(07:30에 확인) — 3/3 07:30은 3/2 알람 시각 + 24시간 30분
  //     D는 기상 확인 기록, E는 생활 기록(daily_records)으로 확인
  await mk('d1', D, at('02', '07:00'));
  const d2 = await mk('d2', D, at('03', '07:00'));
  await ev(d2, D, 'WAKE_CONFIRMED', at('03', '07:30'));
  await mk('e1', E, at('02', '07:00'));
  await mk('e2', E, at('03', '07:00'));
  await q(`insert into public.daily_records (user_id, record_date, wake_confirmed_at) values ($1, '2026-03-03', $2)`, [E, at('03', '07:30')]);

  const r0809 = await run('02', '08:09');
  const r0844 = await run('02', '08:44');
  const r0845 = await run('02', '08:45');
  const r1000 = await run('02', '10:00');
  const r0309 = await run('03', '09:00', 48);   // 3/2 알람도 판정 범위 안 (48시간)
  const c = r0845.rows.find((x) => label[x.alarm_id] === 'c1');

  await svc();
  await q(`delete from public.alarms where alarm_id = any($1::uuid[])`, [Object.keys(label)]);
  await q(`delete from public.daily_records where user_id = $1 and record_date = '2026-03-03'`, [E]);
  const iso = (t) => new Date(t).toISOString();
  return r0809.names('c') === '' && r0844.names('c') === '' && r0845.names('c') === 'c1'
    && c.rering_minutes === 19 && c.snooze_minutes === 20 && iso(c.missed_at) === iso(at('02', '08:45'))
    && r1000.names('a') === '' && r1000.names('b') === 'b2' && r1000.names('c') === 'c1'
    && r0309.names('d') === 'd1' && r0309.names('e') === 'e1'
    ? true : { r0809: r0809.names(''), r0844: r0844.names(''), r0845: r0845.names(''), r1000: r1000.names(''), r0309: r0309.names(''), c };
});

await check('서버 전용 함수(can_send_push · find_missed_wake_alarms · 배치 호출)는 service_role만 실행하고 앱(authenticated · anon)은 못 부름', async () => {
  const fns = ['public.can_send_push(uuid,uuid,text)', 'public.find_missed_wake_alarms(timestamptz,integer)',
    'private.invoke_edge_function(text,jsonb)', 'private.granted_owner_ids_for(uuid,text)'];
  const r = await q(`select f, has_function_privilege('authenticated', f, 'execute') as a, has_function_privilege('anon', f, 'execute') as n,
                            has_function_privilege('service_role', f, 'execute') as s from unnest($1::text[]) f`, [fns]);
  const app = await q(`select has_function_privilege('authenticated', 'public.get_shared_alarm_appointments(uuid)', 'execute') as a,
                              has_function_privilege('anon', 'public.get_shared_alarm_appointments(uuid)', 'execute') as n`);
  const bad = r.filter((x) => x.a || x.n || !x.s);
  return r.length === fns.length && bad.length === 0 && app[0].a === true && app[0].n === false ? true : { bad, app };
});

// 배치 (Q5 A) — pg_cron · pg_net은 PGlite에 없어 cron.schedule · net.http_post 흉내로 확인
await check('배치 예약: wake-check · alarm-roll(반복 다음 회차)을 5분마다 (PGlite에는 pg_cron · pg_net이 없어 확장은 건너뛰고 예약만 흉내에 들어감)', async () => {
  const jobs = await q(`select jobname, schedule, command from cron.job order by jobname`);
  const ext = await q(`select extname from pg_extension where extname in ('pg_cron', 'pg_net')`);
  return jobs.length === 2 && ext.length === 0
    && ['wake-check', 'alarm-roll'].every((name) => {
      const j = jobs.find((x) => x.jobname === name);
      return j && j.schedule === '*/5 * * * *' && j.command === `select private.invoke_edge_function('${name}')`;
    })
    ? true : { jobs, ext };
});
await check('배치 호출: Vault에 비밀값이 없으면 오류 없이 아무것도 안 하고(null), 둘 다 있으면 프로젝트 주소/functions/v1/wake-check로 service_role 키를 실어 POST', async () => {
  await svc();
  const none = (await q(`select private.invoke_edge_function('wake-check') as r`))[0].r;
  await su();
  await q(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('project_url', 'https://abc.supabase.co/')`);
  await svc();
  const onlyUrl = (await q(`select private.invoke_edge_function('wake-check') as r`))[0].r;
  await su();
  await q(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('service_role_key', 'SECRET-KEY')`);
  await svc();
  const sent = (await q(`select private.invoke_edge_function('wake-check', '{"a":1}') as r`))[0].r;
  const badName = (await q(`select private.invoke_edge_function('../auth/v1/admin') as r`))[0].r;   // 경로에 붙는 이름은 모양을 검사함
  await su();
  const calls = await q(`select url, headers, body from net.calls order by id`);
  await q(`delete from vault.decrypted_secrets`);
  await q(`truncate net.calls`);
  const c = calls[0] ?? {};
  return none === null && onlyUrl === null && sent !== null && badName === null && calls.length === 1
    && c.url === 'https://abc.supabase.co/functions/v1/wake-check' && c.headers.Authorization === 'Bearer SECRET-KEY' && c.headers.apikey === 'SECRET-KEY'
    && c.headers['Content-Type'] === 'application/json' && c.body.a === 1
    ? true : { none, onlyUrl, sent, badName, calls };
});
await check('realtime · cron · Vault가 없는 DB에도 마이그레이션이 그대로 적용됨 (신호 트리거 · 정책 · 예약은 건너뛰고, 배치 호출은 오류 없이 null)', async () => {
  const bare = new PGlite();
  try {
    await bare.exec(AUTH_STUBS);
    for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) await bare.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
    const [{ n }] = (await bare.query(`select count(*)::int as n from pg_trigger where tgname = 'send_wake_signal'`)).rows;
    const [{ r }] = (await bare.query(`select private.invoke_edge_function('wake-check') as r`)).rows;
    return n === 0 && r === null ? true : { n, r };
  } finally {
    await bare.close();
  }
});


// ---------------------------------------------------------------------
// AI 대화 상태 · 호출 기록 (L4 PR 2) — conversation_sessions.turns · server_state, ai_calls
// ---------------------------------------------------------------------

// 호출 기록 한 줄 — 서버 함수(service_role)가 넣는 모양. 필요한 칸만 덮어씀
const CALL = { point: 'T1', prompt_id: 'T1', prompt_version: 'v1.3', model: 'test-model', ok: true, latency_ms: 1200 };
const insCall = (uid, over = {}, tail = 'returning *') => {
  const row = { user_id: uid, ...CALL, ...over };
  const cols = Object.keys(row);
  return q(`insert into public.ai_calls (${cols.join(', ')}) values (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) ${tail}`, Object.values(row));
};
const dAi = { calls: 0, sessions: 0, questions: 0 };   // D의 호출 기록 · 대화 · 질문 기록 수 — 탈퇴 검사에서 CASCADE로 지워졌는지 봄
const NO_USER = '99999999-0000-4000-8000-000000000000';

await check('대화 칸: turns · server_state 기본값은 [] · {} 이고, 배열 · 객체가 아니거나 NULL이면 못 넣음 (기본값은 앱 역할로, 종류 · NULL 제약은 서버 키로 확인)', async () => {
  await as(A);
  const [s] = await q(`insert into public.conversation_sessions (user_id, session_type, input_mode) values ($1, 'BEFORE_SLEEP', 'TEXT') returning turns, server_state`, [A]);
  await svc();   // 앱 역할은 값을 넣는 순간 아래 서버 전용 트리거가 먼저 막으므로, 제약은 서버 키로 확인함
  const badTurns = await expectErr(() => q(`insert into public.conversation_sessions (user_id, session_type, turns) values ($1, 'ANYTIME', '{}')`, [A]), /conversation_sessions_turns_is_array/);
  const badState = await expectErr(() => q(`insert into public.conversation_sessions (user_id, session_type, server_state) values ($1, 'ANYTIME', '[]')`, [A]), /conversation_sessions_server_state_is_object/);
  const nullTurns = await expectErr(() => q(`insert into public.conversation_sessions (user_id, session_type, turns) values ($1, 'ANYTIME', null)`, [A]), /not-null|null value/);
  const nullState = await expectErr(() => q(`insert into public.conversation_sessions (user_id, session_type, server_state) values ($1, 'ANYTIME', null)`, [A]), /not-null|null value/);
  return Array.isArray(s.turns) && s.turns.length === 0 && Object.keys(s.server_state).length === 0 && !Array.isArray(s.server_state)
    && badTurns === true && badState === true && nullTurns === true && nullState === true
    ? true : { s, badTurns, badState, nullTurns, nullState };
});
await check('대화 칸: 서버 키(service_role)가 턴을 덧붙이고 서버 상태를 고쳐 쓰면 그대로 읽힘 · 본인만 읽음', async () => {
  await as(B);
  const [{ session_id: sb }] = await q(`insert into public.conversation_sessions (user_id, session_type) values ($1, 'AFTER_WAKE') returning session_id`, [B]);
  await svc();
  const turns = [{ role: 'user', text: '내일 10시 강남 발표', at: '2026-10-29T14:00:00Z' }, { role: 'ai', text: '저장할까요?', at: '2026-10-29T14:00:03Z', card: 'c1' }];
  await q(`update public.conversation_sessions set turns = $1::jsonb, server_state = $2::jsonb where session_id = $3`,
    [JSON.stringify(turns), JSON.stringify({ pending: ['c1'], silence: 0, crisis_shown: false, asked_server_question: true, utterances: 1 }), sb]);
  const [after] = await q(`select turns, server_state from public.conversation_sessions where session_id = $1`, [sb]);
  await as(A);
  const hidden = await q(`select 1 from public.conversation_sessions where session_id = $1`, [sb]);
  await as(B);
  const [mine] = await q(`select turns, server_state from public.conversation_sessions where session_id = $1`, [sb]);
  return after.turns.length === 2 && after.turns[1].card === 'c1' && after.server_state.pending[0] === 'c1' && after.server_state.utterances === 1
    && hidden.length === 0 && mine.turns[0].role === 'user' && mine.server_state.asked_server_question === true
    ? true : { after, hidden, mine };
});
// turns · server_state는 서버 키만 씀 — 본인 insert · update 정책이 있어도 앱이 말 수 같은 서버 상태를 되돌리지 못하게 (트리거 server_only_columns)
await check('대화 칸 서버 전용(만들 때): 앱이 두 칸에 값을 넣어 만들면 거부(42501) · 기본값을 적거나 다른 칸만 넣는 것은 통과 · upsert로도 못 넣음', async () => {
  await as(A);
  const ins = (cols, vals) => q(`insert into public.conversation_sessions (user_id, session_type, ${cols}) values ($1, 'ANYTIME', ${vals}) returning session_id`, [A]);
  const turnsVal = await expectErr(() => ins('turns', `'[{"role":"user","text":"x"}]'`), /서버 함수만 쓸 수 있음/);
  const stateVal = await expectErr(() => ins('server_state', `'{"utterances":0,"crisis_shown":true}'`), /서버 함수만 쓸 수 있음/);
  const bothVal = await expectErr(() => ins('turns, server_state', `'[1]', '{"a":1}'`), /서버 함수만 쓸 수 있음/);
  const code = await ins('turns', `'[1]'`).then(() => null, (e) => e.code);
  // 기본값 그대로이거나 두 칸을 안 쓰면 됨 (오류가 아니라 기본값으로 덮지는 않음 — 값을 넣으면 위처럼 오류)
  const dflt = await ins('turns, server_state', `'[]', '{}'`);
  const other = await ins('transcript, extracted_data, apply_status', `'안녕', '{"a":1}', 'APPLIED'`);
  // upsert 우회: 새 줄을 값과 함께 넣거나 · 있는 줄을 두 칸 값으로 덮기
  const upNew = await expectErr(() => q(`insert into public.conversation_sessions (session_id, user_id, session_type, turns) values (gen_random_uuid(), $1, 'ANYTIME', '[1]'::jsonb)
                                         on conflict (session_id) do nothing`, [A]), /서버 함수만 쓸 수 있음/);
  const upSet = await expectErr(() => q(`insert into public.conversation_sessions (session_id, user_id, session_type, server_state) values ($1, $2, 'ANYTIME', '{}'::jsonb)
                                         on conflict (session_id) do update set server_state = '{"x":1}'::jsonb`, [dflt[0].session_id, A]), /서버 함수만 바꿀 수 있음/);
  const made = [dflt[0].session_id, other[0].session_id];
  const [row] = await q(`select turns, server_state from public.conversation_sessions where session_id = $1`, [made[0]]);
  await q(`delete from public.conversation_sessions where session_id = any($1::uuid[])`, [made]);
  return turnsVal === true && stateVal === true && bothVal === true && code === '42501' && dflt.length === 1 && other.length === 1
    && upNew === true && upSet === true && row.turns.length === 0 && Object.keys(row.server_state).length === 0
    ? true : { turnsVal, stateVal, bothVal, code, dflt, other, upNew, upSet, row };
});
await check('대화 칸 서버 전용(고칠 때): 앱이 두 칸을 바꾸면 거부(덧붙이기 · jsonb_set · 지우기 · upsert) · 값이 그대로이거나 다른 칸을 고치는 update는 통과 · 남의 줄은 RLS가 0행', async () => {
  await as(A);
  const [{ session_id: sid }] = await q(`insert into public.conversation_sessions (user_id, session_type) values ($1, 'BEFORE_SLEEP') returning session_id`, [A]);
  await svc();
  await q(`update public.conversation_sessions set turns = '[{"role":"user","text":"안녕"}]', server_state = '{"utterances":3,"pending":["c1"]}' where session_id = $1`, [sid]);
  await as(A);
  const rej = (sql) => expectErr(() => q(sql, [sid]), /서버 함수만 바꿀 수 있음/);
  const append = await rej(`update public.conversation_sessions set turns = turns || '[{"role":"user","text":"끼워 넣기"}]'::jsonb where session_id = $1`);
  const setPath = await rej(`update public.conversation_sessions set server_state = jsonb_set(server_state, '{utterances}', '0') where session_id = $1`);
  const wipeTurns = await rej(`update public.conversation_sessions set turns = '[]'::jsonb where session_id = $1`);
  const wipeState = await rej(`update public.conversation_sessions set server_state = '{}'::jsonb where session_id = $1`);
  const withOther = await rej(`update public.conversation_sessions set transcript = '끼어듦', server_state = '{}'::jsonb where session_id = $1`);   // 다른 칸을 같이 고쳐도 통째로 거부
  const upsert = await expectErr(() => q(`insert into public.conversation_sessions (session_id, user_id, session_type) values ($1, $2, 'BEFORE_SLEEP')
                                          on conflict (session_id) do update set turns = '[]'::jsonb, server_state = '{}'::jsonb`, [sid, A]), /서버 함수만 바꿀 수 있음/);
  // 값을 그대로 두거나(같은 값을 다시 씀) 두 칸이 아닌 칸을 고치는 건 막지 않음
  const same = await q(`update public.conversation_sessions set turns = turns, server_state = server_state where session_id = $1 returning 1`, [sid]);
  const sameLit = await q(`update public.conversation_sessions set server_state = '{"utterances":3,"pending":["c1"]}'::jsonb where session_id = $1 returning 1`, [sid]);
  const other = await q(`update public.conversation_sessions set transcript = '안녕', apply_status = 'APPLIED', ended_at = now(), extracted_data = '{"a":1}' where session_id = $1 returning transcript, apply_status`, [sid]);
  // 남의 줄은 RLS가 행을 가려 0행 (트리거까지 가지 않음)
  await as(B);
  const foreign = await q(`update public.conversation_sessions set turns = '[]'::jsonb where session_id = $1 returning 1`, [sid]);
  await svc();
  const [kept] = await q(`select turns, server_state, transcript from public.conversation_sessions where session_id = $1`, [sid]);
  await as(A);
  await q(`delete from public.conversation_sessions where session_id = $1`, [sid]);
  return append === true && setPath === true && wipeTurns === true && wipeState === true && withOther === true && upsert === true
    && same.length === 1 && sameLit.length === 1 && other.length === 1 && other[0].transcript === '안녕' && other[0].apply_status === 'APPLIED'
    && foreign.length === 0 && kept.turns.length === 1 && kept.turns[0].text === '안녕' && kept.server_state.utterances === 3 && kept.transcript === '안녕'
    ? true : { append, setPath, wipeTurns, wipeState, withOther, upsert, same, sameLit, other, foreign, kept };
});
await check('대화 칸 서버 전용: service_role · postgres는 두 칸을 넣고 고침 · 트리거 함수는 SECURITY INVOKER이고 앱 역할은 실행 권한이 없음', async () => {
  await svc();
  const [a] = await q(`insert into public.conversation_sessions (user_id, session_type, turns, server_state) values ($1, 'ANYTIME', '[{"role":"ai","text":"네"}]', '{"utterances":9}') returning session_id, turns, server_state`, [A]);
  const upd = await q(`update public.conversation_sessions set turns = '[]'::jsonb, server_state = jsonb_set(server_state, '{utterances}', '0') where session_id = $1 returning turns, server_state`, [a.session_id]);
  await su();   // 마이그레이션 · 대시보드가 쓰는 postgres
  const [{ cu }] = await q(`select current_user as cu`);
  const pgUpd = await q(`update public.conversation_sessions set turns = '[1]'::jsonb, server_state = '{"by":"postgres"}'::jsonb where session_id = $1 returning turns, server_state`, [a.session_id]);
  const [pgIns] = await q(`insert into public.conversation_sessions (user_id, session_type, turns) values ($1, 'ANYTIME', '[2]') returning session_id, turns`, [A]);
  await q(`delete from public.conversation_sessions where session_id in ($1, $2)`, [a.session_id, pgIns.session_id]);
  const [fn] = await q(`select p.prosecdef, has_function_privilege('authenticated', p.oid, 'execute') as auth_x, has_function_privilege('anon', p.oid, 'execute') as anon_x,
                               has_function_privilege('public', p.oid, 'execute') as public_x
                        from pg_proc p where p.oid = 'private.server_only_session_columns()'::regprocedure`);
  const trg = await q(`select tgname, tgenabled from pg_trigger where tgrelid = 'public.conversation_sessions'::regclass and not tgisinternal and tgname = 'server_only_columns'`);
  return a.turns[0].text === '네' && a.server_state.utterances === 9 && upd.length === 1 && upd[0].turns.length === 0 && upd[0].server_state.utterances === 0
    && cu === 'postgres' && pgUpd.length === 1 && pgUpd[0].server_state.by === 'postgres' && pgIns.turns[0] === 2
    && fn.prosecdef === false && fn.auth_x === false && fn.anon_x === false && fn.public_x === false && trg.length === 1 && trg[0].tgenabled === 'O'
    ? true : { a, upd, cu, pgUpd, pgIns, fn, trg };
});

await check('호출 기록: 칸 기본값(시도 1회 · 규칙 걸림 [] · 호출 글 NULL · 시각)과 토큰 · 비용 · 걸림 코드 · 모든 지점을 서버 키로 넣고 고치고 지움', async () => {
  await svc();
  const [r] = await insCall(A);
  const [full] = await insCall(A, { point: 'T2F', ok: false, error_code: 'RATE_LIMITED', attempts: 2, input_tokens: 1800, output_tokens: 120, cache_read_tokens: 900, cache_write_tokens: 0,
    thinking_tokens: 40, cost_usd: 0.003421, stop_reason: 'max_tokens', request_id: 'req_abc', flags: ['promises_save', 'alarm_relay_missing'], io: JSON.stringify({ input: '내일 10시', output: { ok: 1 } }) });
  const points = [];
  for (const p of ['T1', 'T2F', 'T2', 'T3', 'T4', 'T5', 'E4']) points.push((await insCall(A, { point: p }, 'returning point'))[0].point);
  const upd = await q(`update public.ai_calls set ok = false, error_code = 'TIMEOUT' where call_id = $1 returning ok, error_code`, [r.call_id]);
  const del = await q(`delete from public.ai_calls where call_id = $1 returning 1`, [r.call_id]);
  await q(`delete from public.ai_calls where user_id = $1 and call_id <> $2`, [A, full.call_id]);   // 아래 검사가 쓸 한 줄만 남김
  return r.attempts === 1 && Array.isArray(r.flags) && r.flags.length === 0 && r.io === null && r.error_code === null && r.input_tokens === null && r.cost_usd === null
    && r.thinking_tokens === null && r.stop_reason === null && r.request_id === null && r.session_id === null && r.created_at && r.call_id
    && full.attempts === 2 && full.flags.join() === 'promises_save,alarm_relay_missing' && full.error_code === 'RATE_LIMITED' && full.input_tokens === 1800 && full.cache_read_tokens === 900 && full.thinking_tokens === 40
    && String(full.cost_usd) === '0.003421' && full.io.output.ok === 1 && full.stop_reason === 'max_tokens'
    && points.join() === 'T1,T2F,T2,T3,T4,T5,E4' && upd.length === 1 && upd[0].error_code === 'TIMEOUT' && del.length === 1
    ? true : { r, full, points, upd, del };
});
await check('호출 기록: 지점은 7가지만 · 지연 · 시도(0 = 보내기 전 실패는 가능, 음수 불가) · 토큰 · 비용은 음수 불가 · 필수 칸 · 없는 사용자 거부', async () => {
  await svc();
  const bad = (over, re) => expectErr(() => insCall(A, over, ''), re);
  const point = await bad({ point: 'T9' }, /ai_calls_point_check/);
  const lower = await bad({ point: 't1' }, /ai_calls_point_check/);
  const latency = await bad({ latency_ms: -1 }, /ai_calls_latency_ms_check/);
  const attempts = await bad({ attempts: -1 }, /ai_calls_attempts_check/);
  const tokens = await bad({ output_tokens: -5 }, /ai_calls_tokens_check/);
  const cost = await bad({ cost_usd: -0.01 }, /ai_calls_cost_usd_check/);
  const noVersion = await bad({ prompt_version: null }, /not-null|null value/);
  const noOk = await bad({ ok: null }, /not-null|null value/);
  const ghost = await bad({ user_id: NO_USER }, /foreign key|violates/);
  const zero = await insCall(A, { latency_ms: 0, attempts: 0, input_tokens: 0, cost_usd: 0 }, 'returning latency_ms, attempts');
  await q(`delete from public.ai_calls where latency_ms = 0 and user_id = $1`, [A]);
  return point === true && lower === true && latency === true && attempts === true && tokens === true && cost === true
    && noVersion === true && noOk === true && ghost === true && zero.length === 1 && zero[0].attempts === 0
    ? true : { point, lower, latency, attempts, tokens, cost, noVersion, noOk, ghost, zero };
});
await check('호출 기록: 사용자는 자기 것만 읽고 남의 것은 못 읽음 · anon은 못 읽음', async () => {
  await svc();
  await insCall(B, { point: 'T5' });
  await insCall(B, { point: 'T4' });
  const [{ n: total }] = await q(`select count(*)::int as n from public.ai_calls`);
  await as(A);
  const mine = await q(`select user_id, point from public.ai_calls`);
  const peek = await q(`select 1 from public.ai_calls where user_id = $1`, [B]);
  await as(B);
  const theirs = await q(`select user_id from public.ai_calls`);
  await as(C);
  const none = await q(`select 1 from public.ai_calls`);
  await as(null, 'anon');
  const anon = await expectErr(() => q(`select * from public.ai_calls`), /permission denied/);
  return total === 3 && mine.length === 1 && mine[0].user_id === A && peek.length === 0
    && theirs.length === 2 && theirs.every((x) => x.user_id === B) && none.length === 0 && anon === true
    ? true : { total, mine, peek, theirs, none, anon };
});
await check('호출 기록: 로그인 사용자는 넣기 · 고치기 · 지우기 모두 못 함 (자기 것도) · 정책은 읽기 하나뿐', async () => {
  await as(A);
  const ins = await expectErr(() => insCall(A, {}, ''), /permission denied/);
  const forge = await expectErr(() => insCall(B, {}, ''), /permission denied/);
  const upd = await expectErr(() => q(`update public.ai_calls set ok = false where user_id = $1`, [A]), /permission denied/);
  const del = await expectErr(() => q(`delete from public.ai_calls where user_id = $1`, [A]), /permission denied/);
  const upsert = await expectErr(() => insCall(A, {}, 'on conflict (call_id) do nothing'), /permission denied/);
  await su();
  const pol = await q(`select polname, polcmd from pg_policy where polrelid = 'public.ai_calls'::regclass`);
  const [p] = await q(`select has_table_privilege('authenticated', 'public.ai_calls', 'select') as s, has_table_privilege('authenticated', 'public.ai_calls', 'insert') as i,
                              has_table_privilege('authenticated', 'public.ai_calls', 'update') as u, has_table_privilege('authenticated', 'public.ai_calls', 'delete') as d,
                              has_table_privilege('anon', 'public.ai_calls', 'select') as a`);
  const [{ n }] = await q(`select count(*)::int as n from public.ai_calls where user_id = $1`, [A]);
  return ins === true && forge === true && upd === true && del === true && upsert === true
    && pol.length === 1 && pol[0].polname === 'ai_calls_select_own' && pol[0].polcmd === 'r'
    && p.s === true && p.i === false && p.u === false && p.d === false && p.a === false && n === 1
    ? true : { ins, forge, upd, del, upsert, pol, p, n };
});
await check('호출 기록: 대화를 지워도 호출 기록은 남고 대화 연결만 비워짐 · 대화별로 모아 볼 수 있음 · 없는 대화는 거부', async () => {
  await svc();
  const [{ session_id: sid }] = await q(`insert into public.conversation_sessions (user_id, session_type) values ($1, 'BEFORE_SLEEP') returning session_id`, [A]);
  const [c1] = await insCall(A, { session_id: sid, point: 'T1' });
  const [c2] = await insCall(A, { session_id: sid, point: 'T2F' });
  const bySession = await q(`select call_id from public.ai_calls where session_id = $1`, [sid]);
  const badSession = await expectErr(() => insCall(A, { session_id: NO_USER }, ''), /foreign key|violates/);
  await as(A);   // 실제 경로: 사용자가 RLS로 자기 대화를 지움 (앱 역할에 ai_calls 수정 권한이 없어도 FK의 SET NULL은 돎)
  const delSession = await q(`delete from public.conversation_sessions where session_id = $1 returning 1`, [sid]);
  await svc();
  const kept = await q(`select call_id, session_id from public.ai_calls where call_id in ($1, $2)`, [c1.call_id, c2.call_id]);
  await q(`delete from public.ai_calls where call_id in ($1, $2)`, [c1.call_id, c2.call_id]);
  return bySession.length === 2 && badSession === true && delSession.length === 1 && kept.length === 2 && kept.every((x) => x.session_id === null)
    ? true : { bySession, badSession, delSession, kept };
});

// 질문 예산 공용 셈 자리 (헤드 10/29 H2) — user_questions
const insQ = (uid, over = {}, tail = 'returning *') => {
  const row = { user_id: uid, channel: 'CHAT', kind: 'PREP_CHECK', subject_key: 'PREP_CHECK:appt-1', ...over };
  const cols = Object.keys(row);
  return q(`insert into public.user_questions (${cols.join(', ')}) values (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) ${tail}`, Object.values(row));
};
await check('질문 기록: 서버 키로 넣고(기본값: 물은 시각 · 답 없음) 답을 적고 지움 · 채널은 CHIP · CARD · CHAT만 · 필수 칸 · 없는 사용자 거부', async () => {
  await svc();
  const [r] = await insQ(A);
  const chans = [];
  for (const c of ['CHIP', 'CARD', 'CHAT']) chans.push((await insQ(A, { channel: c }, 'returning channel'))[0].channel);
  const upd = await q(`update public.user_questions set answered_at = now(), answer = '챙겼어요' where question_id = $1 returning answered_at, answer`, [r.question_id]);
  const bad = (over, re) => expectErr(() => insQ(A, over, ''), re);
  const channel = await bad({ channel: 'VOICE' }, /user_questions_channel_check/);
  const lower = await bad({ channel: 'chat' }, /user_questions_channel_check/);
  const noKind = await bad({ kind: null }, /not-null|null value/);
  const noSubject = await bad({ subject_key: null }, /not-null|null value/);
  const ghost = await bad({ user_id: NO_USER }, /foreign key|violates/);
  const ghostSession = await bad({ session_id: NO_USER }, /foreign key|violates/);
  const del = await q(`delete from public.user_questions where user_id = $1 returning 1`, [A]);
  return r.channel === 'CHAT' && r.asked_at && r.answered_at === null && r.answer === null && r.session_id === null && r.question_id
    && chans.join() === 'CHIP,CARD,CHAT' && upd.length === 1 && upd[0].answer === '챙겼어요' && upd[0].answered_at
    && channel === true && lower === true && noKind === true && noSubject === true && ghost === true && ghostSession === true && del.length === 4
    ? true : { r, chans, upd, channel, lower, noKind, noSubject, ghost, ghostSession, del: del.length };
});
await check('질문 기록: 사용자는 자기 것만 읽고 남의 것은 못 읽음 · 넣기 · 고치기 · 지우기는 못 함(자기 것도) · anon은 못 읽음 · 정책은 읽기 하나뿐', async () => {
  await svc();
  const [qa] = await insQ(A);
  await insQ(B, { channel: 'CARD', subject_key: 'PREP_CHECK:appt-2' });
  await insQ(B, { channel: 'CHIP', kind: 'SLEEP_TIME', subject_key: 'SLEEP_TIME' });
  await as(A);
  const mine = await q(`select user_id from public.user_questions`);
  const peek = await q(`select 1 from public.user_questions where user_id = $1`, [B]);
  const ins = await expectErr(() => insQ(A, {}, ''), /permission denied/);
  const forge = await expectErr(() => insQ(B, {}, ''), /permission denied/);
  const upd = await expectErr(() => q(`update public.user_questions set answer = '조작' where question_id = $1`, [qa.question_id]), /permission denied/);
  const del = await expectErr(() => q(`delete from public.user_questions where question_id = $1`, [qa.question_id]), /permission denied/);
  await as(B);
  const theirs = await q(`select user_id from public.user_questions`);
  await as(C);
  const none = await q(`select 1 from public.user_questions`);
  await as(null, 'anon');
  const anon = await expectErr(() => q(`select * from public.user_questions`), /permission denied/);
  await su();
  const pol = await q(`select polname, polcmd from pg_policy where polrelid = 'public.user_questions'::regclass`);
  const [p] = await q(`select has_table_privilege('authenticated', 'public.user_questions', 'select') as s, has_table_privilege('authenticated', 'public.user_questions', 'insert') as i,
                              has_table_privilege('authenticated', 'public.user_questions', 'update') as u, has_table_privilege('authenticated', 'public.user_questions', 'delete') as d,
                              has_table_privilege('anon', 'public.user_questions', 'select') as a`);
  return mine.length === 1 && mine[0].user_id === A && peek.length === 0 && ins === true && forge === true && upd === true && del === true
    && theirs.length === 2 && theirs.every((x) => x.user_id === B) && none.length === 0 && anon === true
    && pol.length === 1 && pol[0].polname === 'user_questions_select_own' && pol[0].polcmd === 'r'
    && p.s === true && p.i === false && p.u === false && p.d === false && p.a === false
    ? true : { mine, peek, ins, forge, upd, del, theirs, none, anon, pol, p };
});
await check('질문 기록: 같은 사람 · 같은 질문 키의 24시간 안 기록을 색인 키로 찾을 수 있고, 대화를 지워도 질문 기록은 남고 대화 연결만 비워짐 (예산 셈이 안 줄어듦)', async () => {
  await svc();
  const [{ session_id: sid }] = await q(`insert into public.conversation_sessions (user_id, session_type) values ($1, 'BEFORE_SLEEP') returning session_id`, [A]);
  const [recent] = await insQ(A, { session_id: sid, subject_key: 'PREP_CHECK:appt-9' });
  await insQ(A, { subject_key: 'PREP_CHECK:appt-9', asked_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() });   // 30시간 전은 24시간 밖
  await insQ(B, { subject_key: 'PREP_CHECK:appt-9' });   // 다른 사람의 같은 키는 안 셈
  const within = await q(`select question_id from public.user_questions where user_id = $1 and subject_key = $2 and asked_at > now() - interval '24 hours'`, [A, 'PREP_CHECK:appt-9']);
  const [{ n: week }] = await q(`select count(*)::int as n from public.user_questions where user_id = $1 and asked_at > now() - interval '7 days'`, [A]);
  await as(A);
  const delSession = await q(`delete from public.conversation_sessions where session_id = $1 returning 1`, [sid]);
  await svc();
  const [kept] = await q(`select session_id from public.user_questions where question_id = $1`, [recent.question_id]);
  await q(`delete from public.user_questions where subject_key = 'PREP_CHECK:appt-9'`);
  return within.length === 1 && within[0].question_id === recent.question_id && week >= 2 && delSession.length === 1 && kept.session_id === null
    ? true : { within, week, delSession, kept };
});
await check('호출 기록 · 대화 · 질문: D의 기록을 만들어 둠 (탈퇴 검사에서 CASCADE로 지워지는지 봄)', async () => {
  await svc();
  const [{ session_id: sid }] = await q(`insert into public.conversation_sessions (user_id, session_type, turns) values ($1, 'BEFORE_SLEEP', '[{"role":"user","text":"안녕","at":"2026-10-29T14:00:00Z"}]') returning session_id`, [D]);
  await insCall(D, { session_id: sid });
  await insCall(D, { point: 'T5' });
  await insQ(D, { session_id: sid });
  await insQ(D, { channel: 'CARD', subject_key: 'PREP_CHECK:appt-2' });
  dAi.calls = (await q(`select count(*)::int as n from public.ai_calls where user_id = $1`, [D]))[0].n;
  dAi.sessions = (await q(`select count(*)::int as n from public.conversation_sessions where user_id = $1`, [D]))[0].n;
  dAi.questions = (await q(`select count(*)::int as n from public.user_questions where user_id = $1`, [D]))[0].n;
  return dAi.calls === 2 && dAi.sessions === 1 && dAi.questions === 2 ? true : dAi;
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
await check('기상 신호: 그룹을 나간(LEFT) 사람의 기상 기록은 그 그룹 채널로 안 감', async () => {
  await clearSignals();
  await as(B);
  await logEvent(B, ids[B].alarm, 'TRIGGERED');
  const r = await signals();
  return r.length === 0 ? true : r;
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
await check('탈퇴하면 고친 값 기록도 CASCADE로 지워짐', async () => {
  await su();
  const [r] = await q(`select count(*)::int as n from public.user_edit_logs where user_id = $1`, [D]);
  return dEditLogs === 1 && r.n === 0 ? true : { dEditLogs, r };
});
await check('탈퇴하면 AI 호출 기록 · 질문 기록 · 대화(턴 · 서버 상태 포함)도 CASCADE로 지워지고 다른 사람 기록은 그대로 (Q7)', async () => {
  await su();
  const [r] = await q(`select (select count(*) from public.ai_calls where user_id = $1)::int as calls,
                              (select count(*) from public.conversation_sessions where user_id = $1)::int as sessions,
                              (select count(*) from public.user_questions where user_id = $1)::int as questions,
                              (select count(*) from public.ai_calls where user_id = $2)::int as a_calls,
                              (select count(*) from public.ai_calls where user_id = $3)::int as b_calls,
                              (select count(*) from public.user_questions where user_id = $3)::int as b_questions`, [D, A, B]);
  return dAi.calls === 2 && dAi.sessions === 1 && dAi.questions === 2 && r.calls === 0 && r.sessions === 0 && r.questions === 0
    && r.a_calls === 1 && r.b_calls === 2 && r.b_questions === 2 ? true : { dAi, r };
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
// 위치 감지 칸 (L2, #40) — 출발 · 도착 출처 · 반경 · 고친 값 화면
// ---------------------------------------------------------------------

// 시험용 약속 + 참여 조건 하나 (그 사람 이름으로)
const mkPart = async (u) => {
  await as(u);
  const [ap] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name)
                        values ($1, '위치 감지 시험', now() + interval '1 day', '세종대학교') returning appointment_id`, [u]);
  const [pt] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap.appointment_id, u]);
  return { appt: ap.appointment_id, part: pt.participant_id };
};

await check('위치 감지 칸: 출발 · 도착 출처는 event_input_source(NULL 허용), 반경은 smallint(NULL 허용)', async () => {
  const r = await q(`select table_name || '.' || column_name as col, udt_name, is_nullable from information_schema.columns
                     where table_schema = 'public'
                       and (table_name, column_name) in (('appointment_participants', 'departed_source'), ('appointment_participants', 'arrived_source'),
                                                         ('appointments', 'dest_radius_m'), ('profiles', 'home_radius_m'))
                     order by 1`);
  const m = Object.fromEntries(r.map((x) => [x.col, `${x.udt_name}/${x.is_nullable}`]));
  return r.length === 4
    && m['appointment_participants.departed_source'] === 'event_input_source/YES'
    && m['appointment_participants.arrived_source'] === 'event_input_source/YES'
    && m['appointments.dest_radius_m'] === 'int2/YES'
    && m['profiles.home_radius_m'] === 'int2/YES'
    ? true : m;
});
await check('출발 · 도착 출처는 시각이 있을 때만: 출처만 있는 행 · 시각만 지우기는 거부, 시각만 있는 행(옛 앱 원탭 값)은 받음', async () => {
  const { part } = await mkPart(A);
  const upd = (set) => q(`update public.appointment_participants set ${set} where participant_id = $1 returning departed_source, arrived_source`, [part]);
  const depSrcOnly = await expectErr(() => upd(`departed_source = 'BUTTON'`), /appointment_participants_departed_source_needs_time/);
  const arrSrcOnly = await expectErr(() => upd(`arrived_source = 'LOCATION'`), /appointment_participants_arrived_source_needs_time/);
  const nothing = await upd(`is_late = null`);   // 둘 다 비어 있으면 다른 칸만 고쳐도 통과
  const legacy = await upd(`departed_at = now(), arrived_at = now()`);   // 출처 칸을 모르는 옛 앱이 시각만 씀 → 막지 않음 (BUTTON으로 읽음)
  const both = await upd(`departed_source = 'LOCATION', arrived_source = 'MANUAL'`);
  const clearTimeOnly = await expectErr(() => upd(`departed_at = null`), /appointment_participants_departed_source_needs_time/);
  const override = await upd(`departed_source = 'BUTTON'`);   // 위치로 쓴 값을 응답으로 덮을 때 (출처만 바꿈)
  const cleared = await upd(`departed_at = null, departed_source = null, arrived_at = null, arrived_source = null`);
  const badEnum = await expectErr(() => upd(`departed_source = 'GPS'`), /invalid input value for enum/);
  // 넣을 때도 같은 제약
  const second = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '시험 2', now() + interval '2 days', '강남역') returning appointment_id`, [A]);
  const insSrcOnly = await expectErr(() => q(`insert into public.appointment_participants (appointment_id, user_id, arrived_source) values ($1, $2, 'BUTTON')`, [second[0].appointment_id, A]),
    /appointment_participants_arrived_source_needs_time/);
  const [insBoth] = await q(`insert into public.appointment_participants (appointment_id, user_id, arrived_at, arrived_source) values ($1, $2, now(), 'BUTTON') returning arrived_source, departed_source`,
    [second[0].appointment_id, A]);
  return depSrcOnly === true && arrSrcOnly === true && nothing.length === 1
    && legacy.length === 1 && legacy[0].departed_source === null && legacy[0].arrived_source === null
    && both.length === 1 && both[0].departed_source === 'LOCATION' && both[0].arrived_source === 'MANUAL'
    && clearTimeOnly === true && override[0].departed_source === 'BUTTON'
    && cleared[0].departed_source === null && cleared[0].arrived_source === null && badEnum === true
    && insSrcOnly === true && insBoth.arrived_source === 'BUTTON' && insBoth.departed_source === null
    ? true : { depSrcOnly, arrSrcOnly, nothing, legacy, both, clearTimeOnly, override, cleared, badEnum, insSrcOnly, insBoth };
});
await check('반경: 약속 도착지(dest_radius_m)와 집(home_radius_m)은 100~500이고 NULL(기본값)도 받음 — 99 · 501은 거부', async () => {
  const { appt } = await mkPart(A);
  const setAppt = (v) => q(`update public.appointments set dest_radius_m = $1 where appointment_id = $2 returning dest_radius_m`, [v, appt]);
  const setHome = (v) => q(`update public.profiles set home_radius_m = $1 where user_id = $2 returning home_radius_m`, [v, A]);
  const out = {};
  for (const [name, set, re] of [['dest', setAppt, /appointments_dest_radius_m_range/], ['home', setHome, /profiles_home_radius_m_range/]]) {
    out[name] = {
      low: await expectErr(() => set(99), re),
      high: await expectErr(() => set(501), re),
      min: (await set(100))[0],
      max: (await set(500))[0],
      none: (await set(null))[0],
    };
  }
  // 넣을 때도 같은 제약 (집 반경은 profiles가 가입 트리거로 생기므로 약속만)
  const insLow = await expectErr(() => q(`insert into public.appointments (creator_id, title, appointment_at, dest_name, dest_radius_m)
                                          values ($1, '반경 시험', now(), '역', 50)`, [A]), /appointments_dest_radius_m_range/);
  const [insOk] = await q(`insert into public.appointments (creator_id, title, appointment_at, dest_name, dest_radius_m)
                           values ($1, '반경 시험', now(), '역', 300) returning dest_radius_m`, [A]);
  return ['dest', 'home'].every((k) => out[k].low === true && out[k].high === true && out[k].min[`${k}_radius_m`] === 100
      && out[k].max[`${k}_radius_m`] === 500 && out[k].none[`${k}_radius_m`] === null)
    && insLow === true && insOk.dest_radius_m === 300
    ? true : { out, insLow, insOk };
});
await check('새 칸의 권한: 본인 참여 조건의 출처 · 본인 프로필의 반경 · 본인 약속의 반경은 본인이 고치고 남은 못 고침 (칼럼 권한 · 트리거에 막히지 않음)', async () => {
  const { appt, part } = await mkPart(A);
  await as(A);
  const mine = await q(`update public.appointment_participants set departed_at = now(), departed_source = 'BUTTON' where participant_id = $1 returning departed_source`, [part]);
  const home = await q(`update public.profiles set home_radius_m = 250 where user_id = $1 returning home_radius_m`, [A]);
  const dest = await q(`update public.appointments set dest_radius_m = 150 where appointment_id = $1 returning dest_radius_m`, [appt]);
  await as(B);   // 약속 · 그룹을 같이 쓰지 않는 남 — 행이 안 보여서 0행이 고쳐짐
  const otherPart = await q(`update public.appointment_participants set departed_at = now(), departed_source = 'MANUAL' where participant_id = $1 returning 1`, [part]);
  const otherSrc = await q(`update public.appointment_participants set departed_source = 'MANUAL' where participant_id = $1 returning 1`, [part]);
  const otherHome = await q(`update public.profiles set home_radius_m = 500 where user_id = $1 returning 1`, [A]);
  const otherDest = await q(`update public.appointments set dest_radius_m = 500 where appointment_id = $1 returning 1`, [appt]);
  await su();
  const [after] = await q(`select (select departed_source from public.appointment_participants where participant_id = $1) as src,
                                  (select home_radius_m from public.profiles where user_id = $2) as home,
                                  (select dest_radius_m from public.appointments where appointment_id = $3) as dest`, [part, A, appt]);
  return mine.length === 1 && mine[0].departed_source === 'BUTTON' && home[0].home_radius_m === 250 && dest[0].dest_radius_m === 150
    && otherPart.length === 0 && otherSrc.length === 0 && otherHome.length === 0 && otherDest.length === 0
    && after.src === 'BUTTON' && after.home === 250 && after.dest === 150
    ? true : { mine, home, dest, otherPart, otherSrc, otherHome, otherDest, after };
});
await check('고친 값 기록 화면: H01 · H03 · H05 · H08 · NTF · S01만 받고 그 밖(H99 · H02 · 소문자 · 빈 값)은 거부', async () => {
  await as(A);
  const ok = [];
  for (const s of ['H01', 'H03', 'H05', 'H08', 'NTF', 'S01']) ok.push((await q(`insert into public.user_edit_logs (screen, field, edited_value) values ($1, 'departed_at', '1') returning screen`, [s]))[0].screen);
  const bad = [];
  for (const s of ['H99', 'H02', 'h01', 'ntf', '']) bad.push(await expectErr(() => q(`insert into public.user_edit_logs (screen, field, edited_value) values ($1, 'departed_at', '1')`, [s]), /user_edit_logs_screen_check/));
  const del = await q(`delete from public.user_edit_logs where field = 'departed_at' returning 1`);
  return ok.join() === 'H01,H03,H05,H08,NTF,S01' && bad.every((x) => x === true) && del.length === 6 ? true : { ok, bad, del: del.length };
});
// L4 PR 2: AI 대화(A02)에서 고친 값. 제약을 다시 정의하면서 기존 화면 값이 빠지지 않았는지도 함께 봄
await check('고친 값 기록 화면: A02(AI 대화에서 고친 값)도 받고 기존 화면 값은 그대로 받음 · 비슷한 값(a02 · A01 · A022)은 거부', async () => {
  await as(A);
  const ok = [];
  for (const s of ['A02', 'H01', 'H03', 'H05', 'H08', 'NTF', 'S01']) ok.push((await q(`insert into public.user_edit_logs (screen, field, edited_value) values ($1, 'departed_at', '1') returning screen`, [s]))[0].screen);
  const bad = [];
  for (const s of ['a02', 'A01', 'A022']) bad.push(await expectErr(() => q(`insert into public.user_edit_logs (screen, field, edited_value) values ($1, 'departed_at', '1')`, [s]), /user_edit_logs_screen_check/));
  const del = await q(`delete from public.user_edit_logs where field = 'departed_at' returning 1`);
  return ok.join() === 'A02,H01,H03,H05,H08,NTF,S01' && bad.every((x) => x === true) && del.length === 7 ? true : { ok, bad, del: del.length };
});
await check('백필: 마이그레이션 전에 들어 있던 출발 · 도착 시각은 BUTTON으로 채워지고 시각 없는 칸은 NULL로 남음 (반경은 NULL · 기존 고친 값 기록 유지)', async () => {
  const staged = new PGlite();
  try {
    await staged.exec(AUTH_STUBS);
    const files = readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort();
    const i = files.findIndex((x) => x.endsWith('_location_detect.sql'));
    if (i < 0) return '_location_detect.sql 마이그레이션이 없음';
    for (const f of files.slice(0, i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));   // 새 칸이 생기기 전까지만
    const sq = async (sql, params = []) => (await staged.query(sql, params)).rows;
    await sq(`insert into auth.users (id, email) values ($1, 'old@example.com')`, [A]);
    for (const [n, dep, arr] of [[1, `'2026-10-20 09:00+09'`, `'2026-10-20 10:00+09'`], [2, `'2026-10-21 09:00+09'`, 'null'], [3, 'null', `'2026-10-22 10:00+09'`], [4, 'null', 'null']]) {
      const [{ appointment_id: ap }] = await sq(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, $2, now(), '세종대학교') returning appointment_id`, [A, `옛 약속 ${n}`]);
      await sq(`insert into public.appointment_participants (appointment_id, user_id, departed_at, arrived_at) values ($1, $2, ${dep}, ${arr})`, [ap, A]);
    }
    await sq(`insert into public.user_edit_logs (user_id, screen, field, edited_value) values ($1, 'H03', 'buffer_minutes', '15')`, [A]);
    for (const f of files.slice(i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
    const rows = await sq(`select a.title, p.departed_source, p.arrived_source from public.appointment_participants p
                           join public.appointments a using (appointment_id) order by a.title`);
    const [radius] = await sq(`select (select count(*) from public.appointments where dest_radius_m is not null)::int as dest,
                                      (select count(*) from public.profiles where home_radius_m is not null)::int as home,
                                      (select count(*) from public.user_edit_logs where screen = 'H03')::int as logs`);
    const src = rows.map((x) => `${x.departed_source ?? '-'}/${x.arrived_source ?? '-'}`).join();
    return src === 'BUTTON/BUTTON,BUTTON/-,-/BUTTON,-/-' && radius.dest === 0 && radius.home === 0 && radius.logs === 1 ? true : { src, radius };
  } finally {
    await staged.close();
  }
});


// ---------------------------------------------------------------------
// 반복 다음 회차 (L1 #209, PR 3a-1) — 묶음 칸 · 열쇠 칸 · 앱 쓰기 제한 · 회차 하나 쓰기 · 할 일 목록 · 재시도 기록 · 예약
// ---------------------------------------------------------------------
// 시험 값은 모두 고정 날짜(2026-11-03 화 · 11-04 수 · 11-05 목 · 11-10 화 · 11-11 수 · 11-12 목)와 한국 시각이라 지금 시각과 상관없음
// alarm-roll(서버 함수)은 다음 PR — 여기서는 DB가 약속하는 것(칸 · 유니크 · 열쇠 · 권한 · 함수)만 확인함

const F = '66666666-6666-4666-8666-666666666666';   // 지난 회차 읽기 시험
const H1 = '77777777-7777-4777-8777-777777777777';  // 할 일 목록 시험 (약속 · 일정 없는 알람)
const H2 = '88888888-8888-4888-8888-888888888888';  // 할 일 목록 시험 (루틴 · 다른 사람)
const Z = '99999999-9999-4999-8999-aaaaaaaaaaaa';   // 재시도 기록 CASCADE 시험
const mkUser = async (id, email) => {
  await as(null, 'supabase_auth_admin');
  await q(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  await su();
};
for (const [id, email] of [[F, 'f@example.com'], [H1, 'h1@example.com'], [H2, 'h2@example.com'], [Z, 'z@example.com']]) await mkUser(id, email);

const kst = (col) => `to_char(${col} at time zone 'Asia/Seoul', 'MM-DD HH24:MI')`;   // 시각을 한국 "월-일 시:분" 글자로
const DAWN = '2026-11-11T01:00:00+09:00';   // 한국 새벽 1시 = UTC로는 11-10 16:00

// 서비스 키로 약속 한 줄 (series · on을 안 주면 DB가 채움)
const insAppt = async (creator, { at, title = '수업', rule = null, series = null, on = null, group = null }) =>
  (await q(`insert into public.appointments (creator_id, group_id, series_id, occurrence_on, title, appointment_at, dest_name, recurrence_rule)
            values ($1, $2, $3, $4, $5, $6, '세종대학교', $7)
            returning appointment_id, series_id, occurrence_on::text as occurrence_on`, [creator, group, series, on, title, at, rule]))[0];

// 일정 없는 알람 한 줄
const insStandalone = async (user, { at, rule = null, series = null, on = null, enabled = true }) =>
  (await q(`insert into public.alarms (user_id, alarm_type, scheduled_at, recurrence_rule, is_enabled, series_id, occurrence_on)
            values ($1, 'WAKE', $2, $3, $4, $5, $6)
            returning alarm_id, series_id, occurrence_on::text as occurrence_on`, [user, at, rule, enabled, series, on]))[0];

// roll_insert_occurrence에 넣는 회차 한 벌 (alarm-commit이 넣는 칸과 같음)
const rollArgs = (creator, series, on, over = {}) => [
  {
    creator_id: creator, series_id: series, occurrence_on: on, title: '수업', appointment_at: `${on}T10:00:00+09:00`, dest_name: '세종대학교',
    dest_lat: 37.5503, dest_lng: 127.0731, dest_radius_m: 150, importance: 'HIGH', recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE', memo: '3층 강의실', ...over.appointment,
  },
  { origin_name: '집', origin_lat: 37.5, origin_lng: 127.0, transport_type: 'SUBWAY', est_travel_minutes: 47, travel_source: 'ESTIMATE', prepare_minutes: 55, buffer_minutes: 12, ...over.participant },
  over.alarms ?? [
    { alarm_type: 'WAKE', scheduled_at: `${on}T07:30:00+09:00`, intensity: 'STRONG', voice_tone: 'DIRECT', sound_key: 'theme_urgent', time_source: 'MANUAL', intensity_source: 'MANUAL', last_calculated_at: '2026-11-04T01:00:00Z' },
    { alarm_type: 'PREPARE', scheduled_at: `${on}T08:25:00+09:00`, is_enabled: false },
    { alarm_type: 'DEPARTURE', scheduled_at: `${on}T09:00:00+09:00` },
    { alarm_type: 'ARRIVE', scheduled_at: `${on}T09:50:00+09:00` },
  ],
  over.items ?? [{ title: '노트북' }, { title: '   ' }, { title: '긴 준비물'.padEnd(120, '가'), due_date: '2026-11-10' }],
];
const rollCall = async (...args) =>
  (await q(`select public.roll_insert_occurrence($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb) as id`, rollArgs(...args).map((x) => JSON.stringify(x))))[0].id;

// ---- ① 묶음 칸 채우기 --------------------------------------------------

await check('묶음 칸 채우기: 약속 · 일정 없는 알람은 series_id = 자기 id, 날짜는 만든 사람 시간대의 날짜(새벽 1시 약속 = 한국 날짜) · 약속 · 루틴 알람은 비워 둠 · 준 값은 그대로', async () => {
  await svc();
  const kr = await insAppt(A, { at: DAWN });
  await su();
  await q(`update public.profiles set timezone = 'America/Los_Angeles' where user_id = $1`, [B]);
  await svc();
  const la = await insAppt(B, { at: DAWN });   // 같은 순간이 LA에서는 11-10 08:00
  await su();
  await q(`update public.profiles set timezone = 'Asia/Seoul' where user_id = $1`, [B]);
  await svc();
  const given = await insAppt(A, { at: DAWN, series: kr.series_id, on: '2026-11-18' });   // alarm-roll이 이렇게 넣음 — 준 번호 · 날짜를 안 덮음
  const sa = await insStandalone(A, { at: DAWN });
  const saLa = await insStandalone(B, { at: DAWN });   // B는 이미 서울로 돌아옴 → 서울 날짜
  const [part] = await q(`select series_id, occurrence_on from public.alarms where alarm_id = $1`, [ids[A].alarm]);   // 약속 알람 (앞 절에서 앱이 넣음)
  const [{ rt }] = await q(`insert into public.routines (user_id, title) values ($1, '묶음 칸 시험') returning routine_id as rt`, [A]);
  const [rout] = await q(`insert into public.alarms (routine_id, step_order, user_id, alarm_type, scheduled_at) values ($1, 1, $2, 'ROUTINE', $3) returning series_id, occurrence_on`, [rt, A, DAWN]);
  // 앞 절에서 앱(authenticated)이 넣은 약속 — 오늘 10시 약속이라 서울 오늘 날짜
  const [mine] = await q(`select appointment_id, series_id, occurrence_on::text as occurrence_on, ${TODAY}::text as today from public.appointments where appointment_id = $1`, [ids[A].appt]);
  const [nulls] = await q(`select count(*)::int as n from public.appointments where series_id is null or occurrence_on is null`);
  await q(`delete from public.routines where routine_id = $1`, [rt]);
  return kr.series_id === kr.appointment_id && kr.occurrence_on === '2026-11-11'
    && la.series_id === la.appointment_id && la.occurrence_on === '2026-11-10'
    && given.series_id === kr.series_id && given.occurrence_on === '2026-11-18'
    && sa.series_id === sa.alarm_id && sa.occurrence_on === '2026-11-11' && saLa.occurrence_on === '2026-11-11'
    && part.series_id === null && part.occurrence_on === null && rout.series_id === null && rout.occurrence_on === null
    && mine.series_id === mine.appointment_id && mine.occurrence_on === mine.today && nulls.n === 0
    ? true : { kr, la, given, sa, saLa, part, rout, mine, nulls };
});
await check('지금 있던 행 채우기: 마이그레이션 전에 들어 있던 약속 · 일정 없는 알람이 묶음 1개짜리가 되고(새벽 1시 약속 = 시간대 날짜) 약속 · 루틴 알람은 비어 있음 · 약속 칸은 NOT NULL · 이후 insert도 DB가 채움', async () => {
  const staged = new PGlite();
  try {
    await staged.exec(AUTH_STUBS);
    const files = readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort();
    const i = files.findIndex((x) => x.endsWith('_alarm_roll.sql'));
    if (i < 0) return '_alarm_roll.sql 마이그레이션이 없음';
    for (const f of files.slice(0, i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));   // 새 칸이 생기기 전까지만
    const sq = async (sql, params = []) => (await staged.query(sql, params)).rows;
    await sq(`insert into auth.users (id, email) values ($1, 'old1@example.com'), ($2, 'old2@example.com')`, [A, B]);
    await sq(`update public.profiles set timezone = 'America/Los_Angeles' where user_id = $1`, [B]);   // B만 LA
    const made = {};
    for (const [u, key] of [[A, 'seoul'], [B, 'la']]) {
      const [{ appointment_id: ap }] = await sq(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '옛 약속', $2, '세종대학교') returning appointment_id`, [u, DAWN]);
      const [{ participant_id: pt }] = await sq(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [ap, u]);
      await sq(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, 'WAKE', $3)`, [pt, u, DAWN]);
      const [{ rt }] = await sq(`insert into public.routines (user_id, title) values ($1, '옛 루틴') returning routine_id as rt`, [u]);
      await sq(`insert into public.alarms (routine_id, step_order, user_id, alarm_type, scheduled_at) values ($1, 1, $2, 'ROUTINE', $3)`, [rt, u, DAWN]);
      const [{ alarm_id: sa }] = await sq(`insert into public.alarms (user_id, alarm_type, scheduled_at) values ($1, 'WAKE', $2) returning alarm_id`, [u, DAWN]);
      made[key] = { ap, sa };
    }
    for (const f of files.slice(i)) await staged.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
    const out = {};
    for (const key of ['seoul', 'la']) {
      const [a] = await sq(`select series_id = appointment_id as own, occurrence_on::text as on from public.appointments where appointment_id = $1`, [made[key].ap]);
      const [s] = await sq(`select series_id = alarm_id as own, occurrence_on::text as on from public.alarms where alarm_id = $1`, [made[key].sa]);
      out[key] = { appt: `${a.own}/${a.on}`, standalone: `${s.own}/${s.on}` };
    }
    const [others] = await sq(`select count(*)::int as n from public.alarms where (participant_id is not null or routine_id is not null) and (series_id is not null or occurrence_on is not null)`);
    const cols = Object.fromEntries((await sq(`select table_name || '.' || column_name as col, is_nullable from information_schema.columns
      where table_schema = 'public' and column_name in ('series_id', 'occurrence_on') and table_name in ('appointments', 'alarms')`)).map((x) => [x.col, x.is_nullable]));
    const [fresh] = await sq(`insert into public.appointments (creator_id, title, appointment_at, dest_name) values ($1, '새 약속', $2, '강남역') returning series_id = appointment_id as own, occurrence_on::text as on`, [B, DAWN]);
    const ok = out.seoul.appt === 'true/2026-11-11' && out.seoul.standalone === 'true/2026-11-11'
      && out.la.appt === 'true/2026-11-10' && out.la.standalone === 'true/2026-11-10'
      && others.n === 0 && cols['appointments.series_id'] === 'NO' && cols['appointments.occurrence_on'] === 'NO'
      && cols['alarms.series_id'] === 'YES' && cols['alarms.occurrence_on'] === 'YES'
      && fresh.own === true && fresh.on === '2026-11-10';
    return ok ? true : { out, others, cols, fresh };
  } finally {
    await staged.close();
  }
});

// ---- ② 날짜 유니크 · roll_insert_occurrence --------------------------------

let rollBase;   // E의 매주 수 10시 수업 첫 회차 (11-04) — 아래 검사들이 이어 씀
await check('날짜 유니크 · 회차 하나 쓰기: 같은 (만든 사람, 묶음, 날짜)는 두 번 못 만들고, roll_insert_occurrence는 두 번 불러도 한 벌 — 약속 · 참여 · 알람 4 · 준비물 칸이 alarm-commit과 같음', async () => {
  await svc();
  rollBase = await insAppt(E, { at: '2026-11-04T10:00:00+09:00', rule: 'FREQ=WEEKLY;BYDAY=WE' });
  const S = rollBase.series_id;
  const id1 = await rollCall(E, S, '2026-11-11');
  const again = await rollCall(E, S, '2026-11-11');   // 같은 요청 두 번 → 아무것도 안 쓰고 null
  const count = async (sql) => (await q(sql, [E, S]))[0].n;
  const [appt] = await q(`select title, dest_name, dest_lat::float as lat, dest_lng::float as lng, dest_radius_m, importance, recurrence_rule, memo, group_id, creator_id,
                                 series_id, occurrence_on::text as on, ${kst('appointment_at')} as at from public.appointments where appointment_id = $1`, [id1]);
  const [part] = await q(`select user_id, origin_name, origin_lat::float as lat, origin_lng::float as lng, transport_type, est_travel_minutes, travel_source::text as src,
                                 prepare_minutes, buffer_minutes, participant_id, departed_at, arrived_at from public.appointment_participants where appointment_id = $1`, [id1]);
  const alarms = Object.fromEntries((await q(`select alarm_type::text as t, user_id, participant_id, series_id, occurrence_on, ${kst('scheduled_at')} as at, intensity::text as intensity, voice_tone::text as voice,
                                                     sound_key, is_enabled, time_source::text as ts, intensity_source::text as isrc, snooze_limit, last_calculated_at is not null as calc
                                              from public.alarms where participant_id = $1`, [part.participant_id])).map((x) => [x.t, x]));
  const todos = await q(`select title, todo_type::text as type, due_date::text as due, is_done, user_id, length(title) as len from public.todos where appointment_id = $1 order by due_date desc`, [id1]);
  const counts = {
    appts: await count(`select count(*)::int as n from public.appointments where creator_id = $1 and series_id = $2`),
    parts: (await q(`select count(*)::int as n from public.appointment_participants where appointment_id = $1`, [id1]))[0].n,
    alarms: (await q(`select count(*)::int as n from public.alarms where participant_id = $1`, [part.participant_id]))[0].n,
    todos: (await q(`select count(*)::int as n from public.todos where appointment_id = $1`, [id1]))[0].n,
  };
  const enumLabels = (await q(`select enum_range(null::public.travel_source)::text as v`))[0].v;
  // 날짜 유니크 — 직접 넣어도 같은 (만든 사람, 묶음, 날짜)는 거절, 만든 사람이 다르면 같은 번호도 받음
  const dupAppt = await expectErr(() => insAppt(E, { at: '2026-11-11T11:00:00+09:00', series: S, on: '2026-11-11' }), /appointments_series_occurrence_key/);
  const otherCreator = await insAppt(B, { at: '2026-11-11T11:00:00+09:00', series: S, on: '2026-11-11' });
  const sa1 = await insStandalone(E, { at: '2026-11-11T07:30:00+09:00', rule: 'FREQ=DAILY' });
  const dupAlarm = await expectErr(() => insStandalone(E, { at: '2026-11-11T07:45:00+09:00', series: sa1.series_id, on: sa1.occurrence_on }), /alarms_series_occurrence_key/);
  const nextDay = await insStandalone(E, { at: '2026-11-12T07:30:00+09:00', series: sa1.series_id, on: '2026-11-12' });
  // 한 트랜잭션 — 알람 칸이 틀리면 약속 · 참여 조건도 안 남음 / 필수 칸이 없으면 오류
  const before = await count(`select count(*)::int as n from public.appointments where creator_id = $1 and series_id = $2`);
  const partsBefore = (await q(`select count(*)::int as n from public.appointment_participants where user_id = $1`, [E]))[0].n;
  const rolledBack = await expectErr(() => rollCall(E, S, '2026-11-18', { alarms: [{ alarm_type: 'WAKE', scheduled_at: '2026-11-18T07:30:00+09:00' }, { alarm_type: 'NOPE', scheduled_at: '2026-11-18T08:00:00+09:00' }] }), /invalid input value for enum/);
  const after = await count(`select count(*)::int as n from public.appointments where creator_id = $1 and series_id = $2`);
  const partsAfter = (await q(`select count(*)::int as n from public.appointment_participants where user_id = $1`, [E]))[0].n;
  const noSeries = await expectErr(() => q(`select public.roll_insert_occurrence('{"creator_id":"${E}","occurrence_on":"2026-11-18"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb)`), /series_id/);
  const noTitle = await expectErr(() => rollCall(E, S, '2026-11-25', { appointment: { title: null } }), /null value in column "title"/);
  const w = alarms.WAKE ?? {};
  const p = alarms.PREPARE ?? {};
  const ok = typeof id1 === 'string' && again === null
    && counts.appts === 2 && counts.parts === 1 && counts.alarms === 4 && counts.todos === 2
    && appt.title === '수업' && appt.dest_name === '세종대학교' && appt.lat === 37.5503 && appt.lng === 127.0731 && appt.dest_radius_m === 150 && appt.importance === 'HIGH'
    && appt.recurrence_rule === 'FREQ=WEEKLY;BYDAY=WE' && appt.memo === '3층 강의실' && appt.group_id === null && appt.creator_id === E
    && appt.series_id === S && appt.on === '2026-11-11' && appt.at === '11-11 10:00'
    && part.user_id === E && part.origin_name === '집' && part.lat === 37.5 && part.lng === 127 && part.transport_type === 'SUBWAY' && part.est_travel_minutes === 47
    && part.src === 'ESTIMATE' && part.prepare_minutes === 55 && part.buffer_minutes === 12 && part.departed_at === null && part.arrived_at === null
    && Object.keys(alarms).sort().join() === 'ARRIVE,DEPARTURE,PREPARE,WAKE'
    && w.user_id === E && w.participant_id === part.participant_id && w.series_id === null && w.occurrence_on === null && w.at === '11-11 07:30'
    && w.intensity === 'STRONG' && w.voice === 'DIRECT' && w.sound_key === 'theme_urgent' && w.is_enabled === true && w.ts === 'MANUAL' && w.isrc === 'MANUAL' && w.snooze_limit === 3 && w.calc === true
    && p.is_enabled === false && p.intensity === 'NORMAL' && p.voice === 'NEUTRAL' && p.sound_key === null && p.ts === 'AUTO' && p.isrc === 'AUTO'
    && todos.length === 2 && todos[0].title === '노트북' && todos[0].due === '2026-11-11' && todos[0].type === 'ITEM' && todos[0].is_done === false && todos[0].user_id === E
    && todos[1].len === 100 && todos[1].due === '2026-11-10'
    && enumLabels === '{API,CACHED,MANUAL,ESTIMATE}'
    && dupAppt === true && otherCreator.series_id === S && dupAlarm === true && nextDay.occurrence_on === '2026-11-12'
    && rolledBack === true && after === before && partsAfter === partsBefore && noSeries === true && noTitle === true;
  return ok ? true : { id1, again, counts, appt, part, alarms, todos, enumLabels, dupAppt, otherCreator, dupAlarm, nextDay, rolledBack, before, after, partsBefore, partsAfter, noSeries, noTitle };
});

// ---- ③ 열쇠 칸 ---------------------------------------------------------

await check('열쇠 칸: 묶음 · 날짜는 한 번 정하면 못 바꿈(service_role · 주인도, NULL → 값도) — 제목 · 시각을 바꿔도 날짜는 그대로', async () => {
  await svc();
  const S = rollBase.series_id;
  const key = (table, set, id, idCol) => () => q(`update public.${table} set ${set} where ${idCol} = $1`, [id]);
  const sa = await insStandalone(E, { at: '2026-11-13T07:30:00+09:00', rule: 'FREQ=DAILY' });
  const [{ pid }] = await q(`select participant_id as pid from public.appointment_participants where user_id = $1 limit 1`, [E]);
  const [{ part_alarm }] = await q(`select alarm_id as part_alarm from public.alarms where participant_id = $1 limit 1`, [pid]);
  const re = /바꿀 수 없음/;
  const svcErrs = [
    await expectErr(key('appointments', `series_id = gen_random_uuid()`, rollBase.appointment_id, 'appointment_id'), re),
    await expectErr(key('appointments', `occurrence_on = '2030-01-01'`, rollBase.appointment_id, 'appointment_id'), re),
    await expectErr(key('alarms', `series_id = gen_random_uuid()`, sa.alarm_id, 'alarm_id'), re),
    await expectErr(key('alarms', `occurrence_on = '2030-01-01'`, sa.alarm_id, 'alarm_id'), re),
    await expectErr(key('alarms', `series_id = '${S}'`, part_alarm, 'alarm_id'), re),   // 약속 알람: NULL → 값도 막힘
    await expectErr(key('alarms', `occurrence_on = '2026-11-11'`, part_alarm, 'alarm_id'), re),
  ];
  await as(E);   // 주인(앱)도 같음
  const ownerErrs = [
    await expectErr(key('appointments', `series_id = gen_random_uuid()`, rollBase.appointment_id, 'appointment_id'), re),
    await expectErr(key('appointments', `occurrence_on = '2030-01-01'`, rollBase.appointment_id, 'appointment_id'), re),
  ];
  const okTitle = await q(`update public.appointments set title = '바뀐 제목' where appointment_id = $1 returning title, series_id, occurrence_on::text as on`, [rollBase.appointment_id]);
  await svc();
  const moved = await q(`update public.alarms set scheduled_at = '2026-11-20T07:00:00+09:00' where alarm_id = $1 returning occurrence_on::text as on, series_id`, [sa.alarm_id]);   // 이번만 시각을 바꿔도 날짜 칸은 그대로
  const movedAppt = await q(`update public.appointments set appointment_at = '2026-11-04T11:30:00+09:00' where appointment_id = $1 returning occurrence_on::text as on`, [rollBase.appointment_id]);
  const def = Object.fromEntries((await q(`select c.relname, pg_get_triggerdef(t.oid) as def from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'keep_keys' and c.relname in ('appointments', 'alarms')`)).map((d) => [d.relname, d.def]));
  const ok = svcErrs.every((x) => x === true) && ownerErrs.every((x) => x === true)
    && okTitle.length === 1 && okTitle[0].title === '바뀐 제목' && okTitle[0].series_id === S && okTitle[0].on === '2026-11-04'
    && moved.length === 1 && moved[0].on === '2026-11-13' && moved[0].series_id === sa.series_id && movedAppt[0].on === '2026-11-04'
    && def.appointments?.includes(`prevent_key_change('creator_id', 'group_id', 'series_id', 'occurrence_on')`)
    && def.alarms?.includes(`prevent_key_change('user_id', 'participant_id', 'routine_id', 'series_id', 'occurrence_on')`);
  return ok ? true : { svcErrs, ownerErrs, okTitle, moved, movedAppt, def };
});

// ---- ④ 앱 쓰기 제한 -----------------------------------------------------

await check('앱 쓰기 제한: 앱은 남의 묶음 · 임의 번호 · 자기 묶음의 둘째 회차를 못 넣고, 새 묶음(번호 없음 · 자기 id)만 넣음 — 약속 · 루틴 알람에 묶음 번호는 달 수 없음', async () => {
  await as(A);
  const into = (series, id = null) => q(`insert into public.appointments (appointment_id, creator_id, series_id, title, appointment_at, dest_name)
                                         values (coalesce($1::uuid, gen_random_uuid()), $2, $3, '쓰기 제한 시험', '2026-11-20T10:00:00+09:00', '역') returning appointment_id, series_id`, [id, A, series]);
  const inOthers = await expectErr(() => into(ids[B].appt), /row-level security/);   // B의 묶음
  const random = await expectErr(() => into('abababab-abab-4bab-8bab-abababababab'), /row-level security/);
  const [own] = await into(null);   // 번호 없음 → 트리거가 자기 id
  const X = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  const [explicit] = await into(X, X);
  const second = await expectErr(() => into(own.appointment_id), /row-level security/);   // 자기 묶음에도 둘째 회차는 못 넣음 (alarm-roll만)
  const directAlarm = await expectErr(() => q(`insert into public.alarms (user_id, alarm_type, scheduled_at, series_id, occurrence_on) values ($1, 'WAKE', now(), gen_random_uuid(), current_date)`, [A]), /row-level security/);
  await q(`delete from public.appointments where title = '쓰기 제한 시험'`);
  await svc();
  const withPartAlarm = await expectErr(() => q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at, series_id, occurrence_on) values ($1, $2, 'PREPARE', now(), gen_random_uuid(), current_date)`, [ids[A].part, A]), /alarms_series_standalone/);
  const [{ rt }] = await q(`insert into public.routines (user_id, title) values ($1, '쓰기 제한 시험') returning routine_id as rt`, [A]);
  const withRoutine = await expectErr(() => q(`insert into public.alarms (routine_id, step_order, user_id, alarm_type, scheduled_at, series_id, occurrence_on) values ($1, 1, $2, 'ROUTINE', now(), gen_random_uuid(), current_date)`, [rt, A]), /alarms_series_standalone/);
  await q(`delete from public.routines where routine_id = $1`, [rt]);
  return inOthers === true && random === true && own.series_id === own.appointment_id && explicit.series_id === X && second === true && directAlarm === true
    && withPartAlarm === true && withRoutine === true
    ? true : { inOthers, random, own, explicit, second, directAlarm, withPartAlarm, withRoutine };
});

// ---- ⑤ 서버 전용 권한 ----------------------------------------------------

await check('서버 전용 권한: roll_insert_occurrence · roll_due_series는 service_role만(앱 · anon은 못 부름) · fill_series 트리거 함수는 실행 권한 없이도 돎', async () => {
  const fns = ['public.roll_insert_occurrence(jsonb,jsonb,jsonb,jsonb)', 'public.roll_due_series(timestamptz,integer)'];
  const r = await q(`select f, has_function_privilege('authenticated', f, 'execute') as a, has_function_privilege('anon', f, 'execute') as n,
                            has_function_privilege('service_role', f, 'execute') as s from unnest($1::text[]) f`, [fns]);
  const trigFn = (await q(`select has_function_privilege('authenticated', 'private.fill_series()', 'execute') as a, has_function_privilege('anon', 'private.fill_series()', 'execute') as n`))[0];
  await as(A);
  const callDue = await expectErr(() => q(`select * from public.roll_due_series(now(), 10)`), /permission denied/);
  const callRoll = await expectErr(() => q(`select public.roll_insert_occurrence('{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb)`), /permission denied/);
  await as(null, 'anon');
  const anonDue = await expectErr(() => q(`select * from public.roll_due_series(now(), 10)`), /permission denied/);
  await svc();
  const svcDue = await q(`select * from public.roll_due_series(now(), 1)`);
  return r.length === fns.length && r.every((x) => !x.a && !x.n && x.s) && trigFn.a === false && trigFn.n === false
    && callDue === true && callRoll === true && anonDue === true && Array.isArray(svcDue)
    ? true : { r, trigFn, callDue, callRoll, anonDue };
});
await check('roll_attempts: RLS만 켜고 정책 없음 · 앱(authenticated · anon)은 읽고 쓰지 못함 · 날짜마다 한 줄 · updated_at 갱신 · 탈퇴하면 CASCADE', async () => {
  const [t] = await q(`select c.relrowsecurity as rls, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
                              has_table_privilege('authenticated', c.oid, 'select') as a, has_table_privilege('anon', c.oid, 'select') as n,
                              has_table_privilege('service_role', c.oid, 'insert') as s
                       from pg_class c where c.oid = 'public.roll_attempts'::regclass`);
  await as(A);
  const readDenied = await expectErr(() => q(`select * from public.roll_attempts`), /permission denied/);
  const writeDenied = await expectErr(() => q(`insert into public.roll_attempts (user_id, series_id, occurrence_on, next_try_at) values ($1, gen_random_uuid(), current_date, now())`, [A]), /permission denied/);
  await as(null, 'anon');
  const anonDenied = await expectErr(() => q(`select * from public.roll_attempts`), /permission denied/);
  await svc();
  const series = 'efefefef-efef-4fef-8fef-efefefefefef';
  const [row] = await q(`insert into public.roll_attempts (user_id, series_id, occurrence_on, next_try_at, updated_at) values ($1, $2, '2026-11-18', '2026-11-05T13:00:00Z', '2020-01-01') returning tries, skipped, last_error`, [Z, series]);
  const dup = await expectErr(() => q(`insert into public.roll_attempts (user_id, series_id, occurrence_on, next_try_at) values ($1, $2, '2026-11-18', now())`, [Z, series]), /roll_attempts_pkey|duplicate key/);
  await q(`insert into public.roll_attempts (user_id, series_id, occurrence_on, next_try_at) values ($1, $2, '2026-11-25', now())`, [Z, series]);   // 다른 날짜는 따로
  const [upd] = await q(`update public.roll_attempts set tries = tries + 1, last_error = 'TIMEOUT' where user_id = $1 and series_id = $2 and occurrence_on = '2026-11-18' returning tries, updated_at > '2021-01-01' as touched`, [Z, series]);
  const longError = await expectErr(() => q(`update public.roll_attempts set last_error = $3 where user_id = $1 and series_id = $2`, [Z, series, 'x'.repeat(41)]), /value too long/);
  await su();
  await q(`delete from auth.users where id = $1`, [Z]);
  const [left] = await q(`select count(*)::int as n from public.roll_attempts where user_id = $1`, [Z]);
  return t.rls === true && t.policies === 0 && t.a === false && t.n === false && t.s === true
    && readDenied === true && writeDenied === true && anonDenied === true
    && row.tries === 0 && row.skipped === false && row.last_error === null && dup === true && upd.tries === 1 && upd.touched === true && longError === true && left.n === 0
    ? true : { t, readDenied, writeDenied, anonDenied, row, dup, upd, longError, left };
});

// ---- ⑥ 지난 회차는 그대로 (설계 메모 M4) -----------------------------------

await check('지난 회차가 그대로: 다음 회차(화 11-10)를 만든 뒤에도 MISSED 후보 · 그룹 기상 상태 · R02 계획 쿼리가 지난 회차(화 11-03)의 알람 행을 같은 id · 같은 시각으로 읽고, 새 회차는 새 날짜에만 보임', async () => {
  // 매주 화 10시 수업 — 지난 회차(11-03): 기상 07:30 · 준비 08:30 · 출발 09:10. 기상은 울리고 끄기만 함 (기상 확인 없음)
  await svc();
  const past = await insAppt(F, { at: '2026-11-03T10:00:00+09:00', rule: 'FREQ=WEEKLY;BYDAY=TU' });
  const [{ participant_id: pt }] = await q(`insert into public.appointment_participants (appointment_id, user_id) values ($1, $2) returning participant_id`, [past.appointment_id, F]);
  const ring = {};
  for (const [type, hhmm] of [['WAKE', '07:30'], ['PREPARE', '08:30'], ['DEPARTURE', '09:10']]) {
    [{ alarm_id: ring[type] }] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, $3, $4) returning alarm_id`, [pt, F, type, `2026-11-03T${hhmm}:00+09:00`]);
  }
  await q(`insert into public.alarm_events (alarm_id, user_id, event_type, event_at) values ($1, $2, 'TRIGGERED', '2026-11-03T07:30:05+09:00'), ($1, $2, 'DISMISSED', '2026-11-03T07:31:00+09:00')`, [ring.WAKE, F]);
  // 그룹 — 공동 약속은 반복해도 첫 회차만이라 11-03 · 11-10 단발 약속을 따로 둠
  await as(F);
  const [{ group_id: G2 }] = await q(`insert into public.groups (group_name, owner_id) values ('반복 시험 그룹', $1) returning group_id`, [F]);
  await svc();
  await insAppt(F, { at: '2026-11-03T15:00:00+09:00', title: '팀 회의', group: G2 });
  await insAppt(F, { at: '2026-11-10T15:00:00+09:00', title: '팀 회의', group: G2 });

  const snap = async () => {
    await svc();
    const missed = await q(`select alarm_id, ${kst('scheduled_at')} as at, ${kst('missed_at')} as missed from public.find_missed_wake_alarms('2026-11-04T03:00:00+09:00', 24) where user_id = $1`, [F]);
    await as(F);
    const group = (day) => q(`select is_me, ${kst('wake_alarm_at')} as at, wake_status from public.get_group_wake_status($1, $2)`, [G2, day]);
    // R02: 그날 계획 줄(loadPlannedRows)과 목표 기상(loadWakeAlarmAts)과 같은 조건
    const day = (from, to) => [F, `${from}T00:00:00+09:00`, `${to}T00:00:00+09:00`];
    const plan = (from, to) => q(`select alarm_id, alarm_type::text as t, ${kst('scheduled_at')} as at, is_enabled from public.alarms where user_id = $1 and scheduled_at >= $2 and scheduled_at < $3 order by scheduled_at`, day(from, to));
    const wakes = (from, to) => q(`select ${kst('scheduled_at')} as at from public.alarms where user_id = $1 and alarm_type = 'WAKE' and is_enabled and scheduled_at >= $2 and scheduled_at < $3`, day(from, to));
    return {
      missed, g3: await group('2026-11-03'), g10: await group('2026-11-10'),
      p3: await plan('2026-11-03', '2026-11-04'), p10: await plan('2026-11-10', '2026-11-11'),
      w3: await wakes('2026-11-03', '2026-11-04'), w10: await wakes('2026-11-10', '2026-11-11'),
    };
  };
  const before = await snap();
  await svc();   // 다음 회차 (화 11-10)
  const nextId = await rollCall(F, past.series_id, '2026-11-10', {
    appointment: { recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU' }, participant: { travel_source: 'API' },
    alarms: [
      { alarm_type: 'WAKE', scheduled_at: '2026-11-10T07:30:00+09:00' },
      { alarm_type: 'PREPARE', scheduled_at: '2026-11-10T08:30:00+09:00' },
      { alarm_type: 'DEPARTURE', scheduled_at: '2026-11-10T09:10:00+09:00' },
    ],
    items: [],
  });
  const after = await snap();
  const same = (k) => JSON.stringify(before[k]) === JSON.stringify(after[k]);
  const ok = typeof nextId === 'string'
    // MISSED 후보: 지난 회차 기상(11-03 07:30 + 다시 울림 19 + 30분 = 08:19)이 그대로
    && before.missed.length === 1 && before.missed[0].alarm_id === ring.WAKE && before.missed[0].at === '11-03 07:30' && before.missed[0].missed === '11-03 08:19' && same('missed')
    // 그룹 기상 상태: 11-03은 지난 회차 그대로(끄기만 함 = DISMISSED), 11-10은 새 회차가 생긴 뒤에 생김
    && before.g3.length === 1 && before.g3[0].is_me === true && before.g3[0].at === '11-03 07:30' && before.g3[0].wake_status === 'DISMISSED' && same('g3')
    && before.g10[0].wake_status === 'NO_ALARM' && after.g10[0].at === '11-10 07:30' && after.g10[0].wake_status === 'SCHEDULED'
    // R02: 지난 날 계획 줄 3개 · 목표 기상이 같은 알람 id로 남고, 새 날짜에는 새 회차 알람이 생김
    && before.p3.length === 3 && before.p3[0].alarm_id === ring.WAKE && before.p3.map((x) => x.at).join() === '11-03 07:30,11-03 08:30,11-03 09:10' && same('p3') && same('w3')
    && before.p10.length === 0 && after.p10.map((x) => x.at).join() === '11-10 07:30,11-10 08:30,11-10 09:10' && before.w10.length === 0 && after.w10.length === 1;
  return ok ? true : { nextId, before, after };
});

// ---- ⑦ roll_due_series --------------------------------------------------

await check('roll_due_series: 묶음마다 가장 늦은 회차 기준 · 다음 회차가 14일 안(끝 시각은 포함 안 함, 14일치가 차 있으면 빠짐) · 못 읽는 규칙 · 공동 약속 · 규칙 없는 묶음 · 재시도 대기는 빠지고 도래한 재시도는 포함 · 일정 없는 반복 알람 · 켜 둔 루틴 · 급한 순 · p_limit', async () => {
  const N = '2026-11-05T12:00:00+09:00';   // 목요일. 창은 11-19(목) 12:00 앞까지
  await as(H1);
  const [{ group_id: G3 }] = await q(`insert into public.groups (group_name, owner_id) values ('목록 시험 그룹', $1) returning group_id`, [H1]);
  await svc();
  const name = new Map();     // series_id → 이름
  const latest = new Map();   // 이름 → 기대하는 template_id
  // 약속 묶음: ats[0]을 먼저 넣고(묶음 번호가 됨) 나머지는 같은 번호로. 기준 회차 = 날짜(occurrence_on)가 가장 늦은 행
  const apptSeries = async (label, user, ats, over = {}) => {
    const rows = [];
    for (const at of ats) {
      const row = await insAppt(user, { at, rule: over.rule === undefined ? 'FREQ=WEEKLY;BYDAY=TH' : over.rule, group: over.group ?? null, series: rows[0]?.series_id ?? null, on: rows[0] ? at.slice(0, 10) : null });
      rows.push(row);
    }
    name.set(rows[0].series_id, label);
    latest.set(label, rows.reduce((a, b) => (b.occurrence_on > a.occurrence_on ? b : a)).appointment_id);
    return rows[0].series_id;
  };
  const attempt = (user, series, on, nextTry, skipped = false) =>
    q(`insert into public.roll_attempts (user_id, series_id, occurrence_on, tries, next_try_at, skipped) values ($1, $2, $3, 1, $4, $5)`, [user, series, on, nextTry, skipped]);

  await apptSeries('ok', H1, ['2026-11-12T10:00:00+09:00', '2026-11-05T10:00:00+09:00']);   // 늦은 회차를 먼저 넣음 — 마지막으로 넣은 행이 아니라 날짜가 늦은 행이 기준
  await apptSeries('ok_other_user', H2, ['2026-11-12T10:00:00+09:00']);
  await apptSeries('edge_in', H1, ['2026-11-12T11:59:00+09:00']);    // 다음 회차 11-19 11:59 — 창 안
  await apptSeries('edge_out', H1, ['2026-11-12T12:00:00+09:00']);   // 다음 회차 11-19 12:00 — 창 끝은 포함 안 함
  await apptSeries('filled', H1, ['2026-11-19T10:00:00+09:00']);     // 기준 회차는 창 안이지만 다음 회차(11-26)가 창 밖 — 14일치가 이미 참
  await apptSeries('far', H1, ['2026-11-26T10:00:00+09:00']);
  await apptSeries('multi_in', H1, ['2026-11-16T10:00:00+09:00'], { rule: 'FREQ=WEEKLY;BYDAY=MO,TH' });      // 월 → 다음은 목 11-19 10:00
  await apptSeries('multi_filled', H1, ['2026-11-19T10:00:00+09:00'], { rule: 'FREQ=WEEKLY;BYDAY=MO,TH' });  // 목 → 다음은 월 11-23
  await apptSeries('lenient', H1, ['2026-11-12T10:00:00+09:00'], { rule: 'rrule:byday=th;freq=weekly' });   // recur.ts parseRecurrence처럼 접두사 · 소문자 · 순서 상관없이 읽음
  await apptSeries('bad_monthly', H1, ['2026-11-01T10:00:00+09:00'], { rule: 'FREQ=MONTHLY;BYMONTHDAY=1' }); // 두 모양 밖 — 오래된 회차라도 빠짐
  await apptSeries('bad_interval', H1, ['2026-11-12T10:00:00+09:00'], { rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH' });
  await apptSeries('no_rule', H1, ['2026-11-12T10:00:00+09:00'], { rule: null });
  await apptSeries('group', H1, ['2026-11-12T10:00:00+09:00'], { group: G3 });
  const wait = await apptSeries('wait', H1, ['2026-11-12T10:30:00+09:00']);
  await attempt(H1, wait, '2026-11-12', '2026-11-05T13:00:00+09:00');                // 1시간 뒤 재시도 → 대기
  const retry = await apptSeries('retry', H1, ['2026-11-12T11:00:00+09:00']);
  await attempt(H1, retry, '2026-11-12', '2026-11-05T11:59:00+09:00');               // 재시도 때가 지남 → 포함
  const mixed = await apptSeries('wait_and_retry', H1, ['2026-11-12T12:00:00+09:00']);
  await attempt(H1, mixed, '2026-11-12', '2026-11-05T11:00:00+09:00');
  await attempt(H1, mixed, '2026-11-13', '2026-11-05T15:00:00+09:00');               // 하나라도 대기면 묶음 전체가 빠짐
  const farRetry = await apptSeries('far_retry', H1, ['2026-11-26T10:00:00+09:00']);
  await attempt(H1, farRetry, '2026-11-19', '2026-11-05T11:00:00+09:00');            // 가장 늦은 회차는 창 밖이어도, 미뤄 둔 날짜의 재시도 때가 오면 포함
  const farSkipped = await apptSeries('far_skipped', H1, ['2026-11-26T10:00:00+09:00']);
  await attempt(H1, farSkipped, '2026-11-19', '2026-11-05T11:00:00+09:00', true);    // 건너뛴 날짜는 재시도가 아님
  const farStale = await apptSeries('far_stale', H1, ['2026-11-26T10:00:00+09:00']);
  await attempt(H1, farStale, '2026-11-02', '2026-11-05T11:00:00+09:00');            // 어제 이전 날짜의 재시도는 무시

  // 일정 없는 알람: 마지막 행이 기준 (규칙 있고 14일 안)
  const standalone = async (label, user, rows, rule, enabled = true) => {
    const made = [];
    for (const at of rows) made.push(await insStandalone(user, { at, rule, enabled, series: made[0]?.series_id ?? null, on: made[0] ? at.slice(0, 10) : null }));
    name.set(made[0].series_id, label);
    latest.set(label, made[made.length - 1].alarm_id);
  };
  await standalone('sa_ok', H1, ['2026-11-05T07:30:00+09:00', '2026-11-06T07:30:00+09:00'], 'FREQ=DAILY');
  await standalone('sa_off', H1, ['2026-11-06T08:00:00+09:00'], 'FREQ=DAILY', false);   // 꺼 둔 반복 알람도 줌
  await standalone('sa_no_rule', H1, ['2026-11-06T09:00:00+09:00'], null);
  await standalone('sa_far', H1, ['2026-11-26T07:30:00+09:00'], 'FREQ=DAILY');
  await standalone('sa_filled', H1, ['2026-11-19T07:30:00+09:00'], 'FREQ=DAILY');   // 다음 회차 11-20 — 창 밖
  await standalone('sa_bad', H1, ['2026-11-06T07:30:00+09:00'], 'FREQ=MONTHLY');

  // 루틴: 켜 둔 루틴의 켜진 단계 알람 중 시각이 지난 것이 있을 때
  const routine = async (label, { active = true, days = 'MON~FRI', alarms }) => {
    const [{ routine_id: rid }] = await q(`insert into public.routines (user_id, title, repeat_days, is_active) values ($1, $2, $3, $4) returning routine_id`, [H2, label, days, active]);
    let order = 0;
    for (const [at, enabled] of alarms) await q(`insert into public.alarms (routine_id, step_order, user_id, alarm_type, scheduled_at, is_enabled) values ($1, $2, $3, 'ROUTINE', $4, $5)`, [rid, ++order, H2, at, enabled]);
    name.set(rid, label);
    latest.set(label, rid);
  };
  await routine('r_ok', { alarms: [['2026-11-05T08:00:00+09:00', true], ['2026-11-06T08:30:00+09:00', true]] });
  await routine('r_off', { active: false, alarms: [['2026-11-05T08:00:00+09:00', true]] });
  await routine('r_future', { alarms: [['2026-11-06T08:00:00+09:00', true]] });
  await routine('r_alarm_off', { alarms: [['2026-11-05T08:00:00+09:00', false]] });
  await routine('r_no_days', { days: '', alarms: [['2026-11-05T08:00:00+09:00', true]] });
  await routine('r_bad_days', { days: 'EVERYDAY', alarms: [['2026-11-05T08:00:00+09:00', true]] });   // 읽을 요일이 없음
  await routine('r_range', { days: 'sat~mon', alarms: [['2026-11-05T07:00:00+09:00', true]] });       // 소문자 · 일요일을 넘는 범위도 읽음

  const rows = await q(`select user_id, series_id, kind, template_id from public.roll_due_series($1, 1000)`, [N]);
  const mine = rows.filter((r) => name.has(r.series_id));
  const got = mine.map((r) => name.get(r.series_id));
  const expected = ['ok', 'ok_other_user', 'edge_in', 'multi_in', 'lenient', 'retry', 'far_retry', 'sa_ok', 'sa_off', 'r_ok', 'r_range'];
  const kinds = Object.fromEntries(mine.map((r) => [name.get(r.series_id), r.kind]));
  const templates = mine.every((r) => r.template_id === latest.get(name.get(r.series_id)));
  const users = Object.fromEntries(mine.map((r) => [name.get(r.series_id), r.user_id]));
  const order = ['r_ok', 'sa_ok', 'sa_off', 'ok', 'retry', 'edge_in', 'far_retry'].map((n) => got.indexOf(n));
  const sortedOrder = order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]));
  const top3 = await q(`select series_id from public.roll_due_series($1, 3)`, [N]);
  const none = await q(`select series_id from public.roll_due_series($1, 0)`, [N]);
  const ok = [...got].sort().join() === [...expected].sort().join()
    && kinds.ok === 'APPOINTMENT' && kinds.sa_ok === 'STANDALONE' && kinds.r_ok === 'ROUTINE' && templates
    && users.ok === H1 && users.ok_other_user === H2 && users.r_ok === H2
    && sortedOrder
    && top3.length === 3 && top3.map((r) => r.series_id).join() === rows.slice(0, 3).map((r) => r.series_id).join() && none.length === 0;
  return ok ? true : { got, expected, kinds, templates, users, order, top3: top3.length, none: none.length };
});

// ---- ⑧ 예약 --------------------------------------------------------------

await check('배치 예약: alarm-roll을 5분마다 부름 (pg_cron은 PGlite에 없어 cron.schedule 흉내에 들어간 것을 봄) — 호출은 /functions/v1/alarm-roll로 서비스 키를 실어 POST', async () => {
  const [job] = await q(`select jobname, schedule, command from cron.job where jobname = 'alarm-roll'`);
  await su();
  await q(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('project_url', 'https://abc.supabase.co'), ('service_role_key', 'SECRET-KEY')`);
  await svc();
  await q(`select private.invoke_edge_function('alarm-roll')`);
  await su();
  const calls = await q(`select url, headers from net.calls order by id`);
  await q(`delete from vault.decrypted_secrets`);
  await q(`truncate net.calls`);
  return job && job.schedule === '*/5 * * * *' && job.command === `select private.invoke_edge_function('alarm-roll')`
    && calls.length === 1 && calls[0].url === 'https://abc.supabase.co/functions/v1/alarm-roll' && calls[0].headers.Authorization === 'Bearer SECRET-KEY'
    ? true : { job, calls };
});


// ---------------------------------------------------------------------
// 회의 의견 (결정 안건 페이지 /decisions) — 링크를 아는 사람은 로그인 없이 읽고 남김, 고치기 X,
// 지우기는 내 이름으로 남긴 것만 함수로 (숨김)
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
await check('회의 의견: 사람은 "자동" 이름으로 못 남김 (가짜 자동 줄)', async () => {
  await as(null, 'anon');
  const exact = await expectErr(() => addComment('D1', '자동', '[정한 것] A안'), /row-level security/);
  const spaced = await expectErr(() => addComment('D1', ' 자동 ', '[정한 것] A안'), /row-level security/);
  return exact === true && spaced === true ? true : { exact, spaced };
});
await check('회의 의견 지우기: 내 이름으로 남긴 것만 숨김 — 남의 의견 · 자동 줄 · 두 번째는 안 됨, 줄은 남음', async () => {
  await su();
  const [{ id: autoId }] = await q(`insert into public.decision_comments (decision_id, author, body) values ('D35', '자동', '[보류] 지형') returning id`);
  await as(null, 'anon');
  const [{ id }] = await addComment('D35', '준성', '지울 의견');
  const del = async (cid, who) => (await q(`select public.delete_decision_comment($1, $2) as ok`, [cid, who]))[0].ok;
  const other = await del(id, '지형');
  const mine = await del(id, ' 준성 ');
  const again = await del(id, '준성');
  const auto = await del(autoId, '자동');
  const rows = await q(`select id, deleted_at is not null as gone from public.decision_comments where id = any($1::bigint[]) order by id`, [[autoId, id]]);
  return other === false && mine === true && again === false && auto === false
    && rows.length === 2 && rows[0].gone === false && rows[1].gone === true ? true : { other, mine, again, auto, rows };
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
