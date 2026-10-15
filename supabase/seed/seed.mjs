// 데모 시드 — 이메일 계정 4명 + 친구 · 그룹 · 약속 · 알람 · 지난 4주 기록을 넣거나 지움 (#100)
//   npm run seed:demo -- --dry-run     네트워크 없이 넣을 개수만 보여 줌
//   npm run seed:demo -- --yes         데모 계정과 데이터를 (지우고 다시) 넣음
//   npm run seed:reset -- --yes        데모 계정 4개를 지움 (그 계정의 모든 데이터가 같이 지워짐)
// SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · SEED_PASSWORD는 이 폴더의 .env(깃에 안 올라감) 또는 환경 변수에서 읽음.
// 서비스 키는 모든 RLS를 건너뛰는 키라서, 어느 프로젝트에 넣는지 출력하고 --yes가 있을 때만 실행함
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEMO_USERS, buildDataset, demoEmails, todayInKst } from './data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BATCH = 500;

// ---- 인자 · 환경 ----

function parseArgs(argv) {
  const args = { command: argv[0], yes: false, dryRun: false, date: undefined };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') args.yes = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--date') args.date = argv[++i];
    else throw new Error(`모르는 옵션: ${a}`);
  }
  return args;
}

// .env는 KEY=VALUE 줄만 읽는 작은 읽기 (따옴표 · 주석 처리). 이미 설정된 환경 변수가 먼저
function loadEnv() {
  const file = join(HERE, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name}이(가) 없어요. supabase/seed/.env.example을 .env로 복사해서 채워 주세요`);
  return v;
};

const projectRef = (url) => new URL(url).hostname.split('.')[0];
const fmtCounts = (counts) => Object.entries(counts).map(([k, v]) => `  ${k.padEnd(26)} ${v}`).join('\n');

// ---- 넣기 · 지우기 ----

async function findDemoUsers(client) {
  const wanted = new Set(demoEmails());
  const found = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) if (u.email && wanted.has(u.email.toLowerCase())) found.push(u);
    if (data.users.length < 200) break;
  }
  return found;
}

async function reset(client) {
  const users = await findDemoUsers(client);
  for (const u of users) {
    // 계정을 지우면 profiles부터 약속 · 알람 · 기록까지 ON DELETE CASCADE로 같이 지워짐
    const { error } = await client.auth.admin.deleteUser(u.id);
    if (error) throw error;
  }
  console.log(`데모 계정 ${users.length}개를 지웠어요 (연결된 데이터 포함)`);
}

async function insertAll(client, table, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await client.from(table).insert(rows.slice(i, i + BATCH));
    if (error) throw new Error(`${table} 넣기 실패: ${error.message}`);
  }
}

async function createAccounts(client) {
  const password = need('SEED_PASSWORD');
  if (password.length < 8) throw new Error('SEED_PASSWORD는 8자 이상이어야 해요');
  const ids = {};
  for (const u of DEMO_USERS) {
    const { data, error } = await client.auth.admin.createUser({
      email: u.email,
      password,
      email_confirm: true,
      user_metadata: { nickname: u.nickname },
    });
    if (error) throw new Error(`${u.email} 계정 만들기 실패: ${error.message}`);
    ids[u.key] = data.user.id;
  }
  return ids;
}

async function seedDemo(client, today) {
  await reset(client); // 여러 번 실행해도 같은 상태 (계정 id는 매번 새로 만들어짐)
  const ids = await createAccounts(client);
  const { tables, counts } = buildDataset({ users: ids, today });

  // 가입 트리거가 만든 프로필 행을 고침
  for (const p of tables.profiles) {
    const { user_id: id, ...patch } = p;
    const { error } = await client.from('profiles').update(patch).eq('user_id', id);
    if (error) throw new Error(`profiles 고치기 실패: ${error.message}`);
  }
  await insertAll(client, 'friends', tables.friends);
  await insertAll(client, 'groups', tables.groups); // 만든 사람은 트리거가 구성원(JOINED)으로 넣음
  const [owner] = tables.groups.map((g) => g.owner_id);
  const others = tables.group_members.filter((m) => m.user_id !== owner);
  await insertAll(client, 'group_members', others);
  for (const m of tables.group_members.filter((x) => x.user_id === owner)) {
    const { error } = await client.from('group_members').update({ wake_share_opt_in: m.wake_share_opt_in }).eq('group_id', m.group_id).eq('user_id', m.user_id);
    if (error) throw new Error(`group_members 고치기 실패: ${error.message}`);
  }
  await insertAll(client, 'sharing_permissions', tables.sharing_permissions);
  await insertAll(client, 'appointments', tables.appointments);
  await insertAll(client, 'appointment_participants', tables.appointment_participants);
  await insertAll(client, 'alarms', tables.alarms);
  await insertAll(client, 'alarm_events', tables.alarm_events);
  await insertAll(client, 'daily_records', tables.daily_records);
  console.log('넣은 개수');
  console.log(fmtCounts(counts));
  console.log(`\n로그인: ${DEMO_USERS.map((u) => u.email).join(' · ')} (비밀번호는 SEED_PASSWORD)`);
}

// ---- 실행 ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== 'demo' && args.command !== 'reset') {
    console.log('사용법: node seed.mjs <demo|reset> [--dry-run] [--yes] [--date YYYY-MM-DD]');
    process.exit(args.command ? 1 : 0);
  }
  const today = args.date ?? todayInKst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('--date는 YYYY-MM-DD 모양이어야 해요');

  if (args.dryRun) {
    if (args.command === 'reset') {
      console.log(`[dry-run] 지울 데모 계정: ${demoEmails().join(', ')}`);
      return;
    }
    const fakeIds = Object.fromEntries(DEMO_USERS.map((u, i) => [u.key, `00000000-0000-4000-8000-00000000000${i + 1}`]));
    const { counts } = buildDataset({ users: fakeIds, today });
    console.log(`[dry-run] ${today} 기준으로 넣을 개수 (네트워크 안 씀)`);
    console.log(`  auth 계정                  ${DEMO_USERS.length}`);
    console.log(fmtCounts(counts));
    return;
  }

  loadEnv();
  const url = need('SUPABASE_URL');
  const key = need('SUPABASE_SERVICE_ROLE_KEY');
  console.log(`프로젝트: ${projectRef(url)}  (${url})`);
  console.log(`작업: ${args.command === 'demo' ? `데모 시드 넣기 (${today} 기준, 기존 데모 계정은 지우고 다시)` : '데모 계정 지우기'}`);
  if (!args.yes) {
    console.log('\n서비스 키로 이 프로젝트를 바꿔요. 맞으면 --yes를 붙여 다시 실행해 주세요 (미리 보기만: --dry-run)');
    process.exit(1);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  if (args.command === 'reset') await reset(client);
  else await seedDemo(client, today);
}

main().catch((e) => {
  console.error(`\n실패: ${e.message}`);
  process.exit(1);
});
