// 알람 조정 제안 전체 흐름 시뮬레이션 (AI 자동 점검) — 기록 → 18:00 제안 → 적용 → 다음 회차 · 다시 계산 → 되돌리기 · 무시 → 다시 제안
//   DB: db-check와 같은 PGlite + 마이그레이션 전부. 서버 코드: 실제 _shared/suggest-run.ts · suggest-apply.ts · calc/chain.ts · plan-core.ts
//   읽기는 사용자 권한(RLS), 쓰기는 service_role — 실제 서버 함수와 같은 길. 폰 알람 울림 · 실서버 배포는 여기서 못 봄
// 실행: cd supabase/tests && npm ci && node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e-suggest.mjs
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

const MIG_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
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
  create table cron.job (jobid bigserial primary key, jobname text unique, username text not null default current_user, schedule text not null, command text not null, active boolean not null default true);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql
    as $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
          on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
  -- 실제 cron.unschedule처럼 없는 작업이면 오류
  create function cron.unschedule(job_name text) returns boolean language plpgsql as $$
    begin
      delete from cron.job where jobname = job_name;
      if not found then raise exception 'could not find valid entry for job %', job_name; end if;
      return true;
    end $$;

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
// 3. 실제 서버 코드를 이 DB에 붙이는 어댑터 (supabase-js에서 서버 코드가 쓰는 만큼만)
// ---------------------------------------------------------------------
const { runSuggest } = await import('../functions/_shared/suggest-run.ts');
const { runSuggestApply } = await import('../functions/_shared/suggest-apply.ts');
const { alarmChain } = await import('../functions/_shared/calc/chain.ts');
const { inferBeforePrepare } = await import('../functions/_shared/plan-core.ts');

const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const fix = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, iso(v)]));
const param = (v) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);

function client(enter) {
  const run = async (sql, params, single) => {
    await enter();
    try {
      const rows = (await db.query(sql, params)).rows.map(fix);
      return { data: single ? rows[0] ?? null : rows, error: null };
    } catch (e) {
      return { data: null, error: { code: e.code ?? '', message: e.message } };
    } finally {
      await su();
    }
  };
  class Query {
    constructor(table) { Object.assign(this, { table, op: 'select', where: [], params: [], single: false, returning: false }); }
    select() { if (this.op !== 'select') this.returning = true; return this; }
    filter(col, opr, v) { this.params.push(v); this.where.push(`${col} ${opr} $${this.params.length}`); return this; }
    eq(c, v) { return this.filter(c, '=', v); }
    gte(c, v) { return this.filter(c, '>=', v); }
    gt(c, v) { return this.filter(c, '>', v); }
    lt(c, v) { return this.filter(c, '<', v); }
    in(c, list) { this.params.push(list); this.where.push(`${c} = any($${this.params.length})`); return this; }
    is(c, v) { this.where.push(`${c} is ${v === null ? 'null' : v}`); return this; }
    update(patch) { this.op = 'update'; this.patch = patch; return this; }
    insert(row) { this.op = 'insert'; this.row = row; return this; }
    maybeSingle() { this.single = true; return this; }
    then(ok, bad) { return this.exec().then(ok, bad); }
    exec() {
      const where = this.where.length ? ` where ${this.where.join(' and ')}` : '';
      if (this.op === 'select') return run(`select * from public.${this.table}${where}`, this.params, this.single);
      if (this.op === 'update') {
        const keys = Object.keys(this.patch);
        const base = this.params.length;
        const set = keys.map((k, i) => `${k} = $${base + i + 1}`).join(', ');
        return run(`update public.${this.table} set ${set}${where}${this.returning ? ' returning *' : ''}`, [...this.params, ...keys.map((k) => param(this.patch[k]))], this.single);
      }
      const keys = Object.keys(this.row);
      return run(`insert into public.${this.table} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})${this.returning ? ' returning *' : ''}`, keys.map((k) => param(this.row[k])), this.single);
    }
  }
  return {
    from: (t) => new Query(t),
    rpc: (name, args) => ({ then: (ok, bad) => run(`select * from public.${name}(${Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')})`, Object.values(args), false).then(ok, bad) }),
  };
}

// ---------------------------------------------------------------------
// 4. 시나리오 — 매일 9시 수업. 계획: 기상 7:25 · 준비 7:45(준비 전 활동 20분) · 출발 8:25 (이동 30 · 여유 5, 준비 시간 60)
// ---------------------------------------------------------------------
const U = '66666666-6666-4666-8666-666666666666';
const service = client(() => svc());
const user = client(() => as(U));
const k = (day, h, m) => new Date(`2026-12-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
const hm = (v) => new Date(new Date(v).getTime() + 9 * 3600_000).toISOString().slice(11, 16);
const steps = [];
const step = (name, ok, detail = '') => steps.push([ok ? 'PASS' : 'FAIL', name, detail]);

await su();
await q(`insert into auth.users (id, email) values ($1, 'e2e-suggest@example.com')`, [U]);
let series = null;
const occ = {};
async function addDay(day, { alarms = true } = {}) {
  const [a] = await q(
    `insert into public.appointments (creator_id, title, appointment_at, dest_name, recurrence_rule, series_id, occurrence_on)
     values ($1, '수업', $2, '세종대학교', $3, $4, $5) returning appointment_id, series_id`,
    [U, k(day, 9, 0), series ? null : 'FREQ=DAILY', series, series ? `2026-12-${String(day).padStart(2, '0')}` : null],
  );
  series ??= a.series_id;
  const [p] = await q(
    `insert into public.appointment_participants (appointment_id, user_id, prepare_minutes, buffer_minutes, est_travel_minutes)
     values ($1, $2, 60, 5, 30) returning participant_id, prepare_advance_minutes`,
    [a.appointment_id, U],
  );
  const ids = {};
  if (alarms) {
    // 그 회차 참여 조건의 당김 분으로 사슬을 계산해 알람을 넣음 (alarm-roll이 하는 일 — 앞 회차 당김을 이어받은 값)
    const chain = alarmChain({ at: k(day, 9, 0), travelMinutes: 30, bufferMinutes: 5, prepareMinutes: 60, beforePrepareMinutes: 20, withWake: true, prepareAdvanceMinutes: p.prepare_advance_minutes });
    for (const x of chain.filter((c) => c.kind !== 'ARRIVE')) {
      const [r] = await q(`insert into public.alarms (participant_id, user_id, alarm_type, scheduled_at) values ($1, $2, $3, $4) returning alarm_id`, [p.participant_id, U, x.kind, x.at]);
      ids[x.kind] = r.alarm_id;
    }
  }
  occ[day] = { appointment: a.appointment_id, participant: p.participant_id, inherited: p.prepare_advance_minutes, alarm: ids };
}
// 아침 — 준비 알람을 끈 시각을 앱처럼 사용자 권한으로 씀(비어 있을 때만, #490) · 출발 기록
async function morning(day, { prepStart = [7, 45], leave }) {
  await as(U);
  if (prepStart) {
    await q(`update public.appointment_participants set prepare_started_at = $1, prepare_started_source = 'PREPARE_ALARM' where participant_id = $2 and prepare_started_at is null`, [k(day, ...prepStart), occ[day].participant]);
  }
  await q(`update public.appointment_participants set departed_at = $1 where participant_id = $2`, [k(day, ...leave), occ[day].participant]);
  await su();
}
const alarmAt = async (day, kind) => hm((await q(`select scheduled_at from public.alarms where alarm_id = $1`, [occ[day].alarm[kind]]))[0].scheduled_at);
const advanceOf = async (day) => (await q(`select prepare_advance_minutes from public.appointment_participants where participant_id = $1`, [occ[day].participant]))[0].prepare_advance_minutes;
const suggestions = async () => q(`select suggestion_id, target_alarm_id, status, current_value, suggested_value, result_value, evidence from public.alarm_suggestions where user_id = $1 order by created_at, suggestion_id`, [U]);

// 12/1 ~ 12/6 회차, 12/1 ~ 12/5 아침 기록: 정시 출발(±3분 — 뺌) · +10 · +14 · +12 · 준비 알람 꺼 둔 날(준비 시작 없음 — 뺌)
for (const d of [1, 2, 3, 4, 5, 6]) await addDay(d);
await morning(1, { leave: [8, 26] });
await morning(2, { leave: [8, 35] });
await morning(3, { leave: [8, 39] });
await morning(4, { leave: [8, 37] });
await morning(5, { prepStart: null, leave: [8, 40] });

// ① 12/5 18:00 배치
const batch1 = await runSuggest(service, k(5, 18, 0));
const [s1] = await suggestions();
step('① 18:00 배치: 내일(12/6) 준비 알람에 "10분 당김" 제안 1개 — 근거는 +10 · +14 · +12 (정시 출발 · 준비 시작 없는 날은 빠짐)',
  batch1.created === 1 && s1?.target_alarm_id === occ[6].alarm.PREPARE && s1.suggested_value === '10' && JSON.stringify(s1.evidence) === '[10,14,12]',
  JSON.stringify({ batch1, s1 }));

// ② 앱이 사용자 권한으로 제안을 읽을 수 있음 (RLS)
await as(U);
const seen = await q(`select suggestion_id from public.alarm_suggestions where status = 'PENDING'`);
await su();
step('② 사용자 권한으로 대기 중 제안이 보임 (그룹 탭 카드 · S01이 읽는 길)', seen.length === 1, JSON.stringify(seen));

// ③ 12/5 20:00 적용 (S01 "제안 적용하기" → suggestion-apply)
const applied = await runSuggestApply({ db: user, write: service, userId: U, now: k(5, 20, 0) }, { suggestionId: s1.suggestion_id, action: 'APPLY' });
step('③ 적용: 12/6 준비 알람 7:45 → 7:35, 기상 7:25 · 출발 8:25 그대로, 당김 분 10, 제안 APPLIED, 폰 꾸러미 1개(준비 7:35)',
  (await alarmAt(6, 'PREPARE')) === '07:35' && (await alarmAt(6, 'WAKE')) === '07:25' && (await alarmAt(6, 'DEPARTURE')) === '08:25'
    && (await advanceOf(6)) === 10 && applied.status === 'APPLIED' && applied.ring_packages.length === 1 && hm(applied.ring_packages[0].atMillis) === '07:35',
  JSON.stringify({ prep: await alarmAt(6, 'PREPARE'), adv: await advanceOf(6), status: applied.status, pkgs: applied.ring_packages.map((p) => [p.type, hm(p.atMillis)]) }));
step('③-1 지난 회차(12/5)는 그대로 — 당김 분 0, 준비 알람 7:45', (await advanceOf(5)) === 0 && (await alarmAt(5, 'PREPARE')) === '07:45');

// ④ 다시 계산해도 두 번 당겨지지 않음 — 저장된 알람에서 준비 전 활동을 되찾고(B안) 같은 사슬로 다시 계산
const rows6 = await q(`select alarm_id, alarm_type, scheduled_at, time_source from public.alarms where participant_id = $1`, [occ[6].participant]);
const before6 = inferBeforePrepare(rows6.map(fix), 10, 60);
const again6 = alarmChain({ at: k(6, 9, 0), travelMinutes: 30, bufferMinutes: 5, prepareMinutes: 60, beforePrepareMinutes: before6, withWake: true, prepareAdvanceMinutes: 10 });
step('④ 다시 계산(일정 수정 · 회차 계산): 준비 전 활동 20분을 되찾고 같은 시각(기상 7:25 · 준비 7:35)',
  before6 === 20 && hm(again6.find((x) => x.kind === 'PREPARE').at) === '07:35' && hm(again6.find((x) => x.kind === 'WAKE').at) === '07:25',
  JSON.stringify({ before6, again: again6.map((x) => [x.kind, hm(x.at)]) }));

// ⑤ 다음 회차(12/7)를 새로 만들면 당김 10을 이어받고 준비 알람이 7:35로 만들어짐
await addDay(7);
step('⑤ 반복 새 회차(12/7): 당김 분 10을 이어받고 준비 알람 7:35', occ[7].inherited === 10 && (await alarmAt(7, 'PREPARE')) === '07:35',
  JSON.stringify({ inherited: occ[7].inherited, prep: await alarmAt(7, 'PREPARE') }));

// ⑥ 되돌리기 (12/5 21:00) — 이번 회차 · 이후 회차 모두 원래대로, 제안은 대기(D23 A)
const reverted = await runSuggestApply({ db: user, write: service, userId: U, now: k(5, 21, 0) }, { suggestionId: s1.suggestion_id, action: 'REVERT' });
step('⑥ 되돌리기: 12/6 · 12/7 준비 알람 7:45, 당김 분 0, 제안 PENDING',
  (await alarmAt(6, 'PREPARE')) === '07:45' && (await alarmAt(7, 'PREPARE')) === '07:45' && (await advanceOf(6)) === 0 && (await advanceOf(7)) === 0 && reverted.status === 'PENDING',
  JSON.stringify({ p6: await alarmAt(6, 'PREPARE'), p7: await alarmAt(7, 'PREPARE'), status: reverted.status }));

// ⑦ 고쳐 적용 15분 — 준비 전 활동 20분 안이라 기상 그대로, 그다음 다시 되돌리고 무시
const edited = await runSuggestApply({ db: user, write: service, userId: U, now: k(5, 21, 5) }, { suggestionId: s1.suggestion_id, action: 'EDIT', minutes: 15 });
const p6e = await alarmAt(6, 'PREPARE');
const w6e = await alarmAt(6, 'WAKE');
await runSuggestApply({ db: user, write: service, userId: U, now: k(5, 21, 10) }, { suggestionId: s1.suggestion_id, action: 'REVERT' });
const ignored = await runSuggestApply({ db: user, write: service, userId: U, now: k(5, 21, 15) }, { suggestionId: s1.suggestion_id, action: 'IGNORE' });
step('⑦ 고쳐 적용 15분: 준비 7:30 · 기상 7:25(준비 전 활동 안) → 되돌린 뒤 무시: 제안 IGNORED, 알람 그대로',
  edited.status === 'EDITED' && p6e === '07:30' && w6e === '07:25' && ignored.status === 'IGNORED' && (await alarmAt(6, 'PREPARE')) === '07:45',
  JSON.stringify({ edited: edited.status, p6e, w6e, ignored: ignored.status }));

// ⑧ 무시한 다음 날(12/6 18:00) 배치 — 무시 뒤 실측이 1번뿐이라 새 제안 없음 (D24 C)
await morning(6, { leave: [8, 36] });
await addDay(8);
const batch2 = await runSuggest(service, k(6, 18, 0));
step('⑧ 무시 다음 날 배치: 무시 뒤 실측 1번 → 새 제안 없음 (D24 C)', batch2.created === 0, JSON.stringify(batch2));

// ⑨ 3일 더 늦으면(12/7 · 12/8 · 12/9) 12/9 18:00 배치가 다시 제안
await morning(7, { leave: [8, 37] });
await morning(8, { leave: [8, 38] });
await addDay(9);
await addDay(10);
await morning(9, { leave: [8, 36] });
const batch3 = await runSuggest(service, k(9, 18, 0));
const latest = (await suggestions()).at(-1);
step('⑨ 무시 뒤 실측 4번(+11 · +12 · +13 · +11)이 쌓이면 12/9 18:00 배치가 12/10 준비 알람에 다시 제안',
  batch3.created === 1 && latest.target_alarm_id === occ[10].alarm.PREPARE && latest.status === 'PENDING',
  JSON.stringify({ batch3, latest }));

// ⑩ 남의 제안은 적용할 수 없음 (다른 사용자 권한)
const OTHER = '77777777-7777-4777-8777-777777777777';
await q(`insert into auth.users (id, email) values ($1, 'other@example.com')`, [OTHER]);
let denied = '';
try {
  await runSuggestApply({ db: client(() => as(OTHER)), write: service, userId: OTHER, now: k(9, 20, 0) }, { suggestionId: latest.suggestion_id, action: 'APPLY' });
  denied = '적용됨';
} catch (e) {
  denied = e.code;
}
step('⑩ 다른 사용자는 이 제안을 적용할 수 없음 (NOT_FOUND)', denied === 'NOT_FOUND', denied);

for (const [s, n, d] of steps) console.log(`${s}  ${n}${s === 'FAIL' && d ? '\n      ' + d : ''}`);
const fails = steps.filter((x) => x[0] !== 'PASS').length;
console.log(`\n전체 흐름 ${steps.length - fails} / ${steps.length} 통과`);
process.exit(fails ? 1 : 0);
