// 친구 대본 자동 시험 실행기
//   node run.mjs              로컬 스택에서 16장 대본 37단계를 돌리고 단계마다 PASS / FAIL / SKIP을 찍음
//   node run.mjs --restore    비정상 종료 때 남은 저장본으로 A · B · C의 친구 · 권한을 되돌림
//   --report <경로>           보고서 md 위치 (기본 runs/<시각>.md, 깃 제외)
// 필요: 로컬 스택(npx supabase start) + supabase/seed에 데모 4명이 들어가 있음(npm run seed:demo -- --yes)
// 시드 .env 위치: E2E_SEED_ENV (깃 제외 파일). 비밀번호 · 키는 출력하지 않음. 127.0.0.1이 아니면 멈춤
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { readCaps } from './caps.mjs';
import { REPO_ROOT, loadEnv } from './env.mjs';
import { reportMarkdown, runSteps, statusRow, summarize } from './harness.mjs';
import { RPC } from './rpc-map.mjs';
import { readSavedSnapshot, restore, takeSnapshot, wipe } from './snapshot.mjs';
import { STEPS } from './steps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS = { A: 'demo-me', B: 'demo-suyeon', C: 'demo-jihyeong' };
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const git = (...a) => spawnSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';
const kstDate = () => {
  const d = new Date(Date.now() + 9 * 3600e3);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

async function main() {
  const env = loadEnv();
  const admin = createClient(env.url, env.serviceKey, NO_SESSION);

  if (args.includes('--restore')) {
    const snap = readSavedSnapshot();
    if (!snap) return console.log('되돌릴 저장본이 없음');
    await restore(admin, snap);
    return console.log('A · B · C의 친구 · 권한을 되돌림');
  }

  // 지난 실행이 중간에 죽었으면 먼저 되돌림
  const leftover = readSavedSnapshot();
  if (leftover) {
    console.log('지난 실행의 저장본이 남아 있어 먼저 되돌림');
    await restore(admin, leftover);
  }

  const caps = await readCaps(env.url, env.serviceKey);

  // 계정 A · B · C 로그인 (시드 비밀번호는 출력하지 않음)
  const clients = {};
  const ids = {};
  for (const [key, name] of Object.entries(ACCOUNTS)) {
    const c = createClient(env.url, env.anonKey, NO_SESSION);
    const { data, error } = await c.auth.signInWithPassword({ email: `${name}@example.com`, password: env.password });
    if (error) throw new Error(`${name} 로그인 실패 — 시드가 들어가 있나요? (npm run seed:demo -- --yes): ${error.message}`);
    clients[key] = c;
    ids[key] = data.user.id;
  }
  const { data: profs, error: pe } = await admin.from('profiles').select('user_id, handle').in('user_id', Object.values(ids));
  if (pe) throw pe;
  const handles = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, profs.find((p) => p.user_id === id)?.handle]));

  const snap = await takeSnapshot(admin, ids, caps);
  let restored = false;
  const finish = async () => {
    if (restored) return;
    restored = true;
    await restore(admin, snap);
  };
  process.once('SIGINT', async () => {
    await finish();
    process.exit(130);
  });

  const ctx = {
    admin,
    a: clients.A,
    b: clients.B,
    c: clients.C,
    ids,
    handles,
    caps,
    password: env.password,
    fn: RPC,
    s: {},
    note() {},
  };

  let results;
  try {
    await wipe(admin, ids);
    results = await runSteps(STEPS, ctx, {
      log: (r) => console.log(`${String(r.n).padStart(2)} ${r.who} [${r.ch}] ${r.status.padEnd(4)} ${r.action}${r.reason ? `\n      → ${r.reason}` : ''}${r.notes.map((n) => `\n      · 생략: ${n}`).join('')}`),
    });
  } finally {
    await finish();
  }

  const meta = { date: kstDate(), main: process.env.E2E_MAIN_LABEL ?? git('rev-parse', '--short', 'HEAD') };
  const { count, firstFail } = summarize(results);
  console.log(`\nPASS ${count.PASS} / FAIL ${count.FAIL} / SKIP ${count.SKIP}`);
  console.log(`개발현황 줄: ${statusRow(results, meta)}`);
  const reportPath = argOf('--report') ?? join(HERE, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, reportMarkdown(results, meta));
  console.log(`보고서: ${reportPath}`);
  process.exitCode = firstFail ? 1 : 0;
}

main().catch((e) => {
  console.error(`시험 실행 실패: ${e.message}`);
  process.exit(2);
});
