#!/usr/bin/env node
// Starts local Supabase Edge Functions and the Expo web preview.
// DOES NOT modify the shared Supabase project or reseed existing local accounts.
// Explicitly local-only: source URL must be http://127.0.0.1:54321.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = resolve(root, 'mobile');
const fail = (s) => { throw new Error(s); };

function fromEnv(output) {
  return Object.fromEntries(output.split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]));
}

async function localConfig() {
  let output;
  try {
    output = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
  } catch {
    fail('로컬 Supabase가 실행 중이지 않습니다. 먼저 npx supabase start를 실행하세요.');
  }
  const vars = fromEnv(output);
  const url = new URL(vars.API_URL || '');
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.port !== '54321' || (url.pathname !== '' && url.pathname !== '/')) {
    fail('안전 검사: 이 명령은 오직 127.0.0.1:54321 로컬 DB에만 연결할 수 있습니다.');
  }
  const pub = vars.PUBLISHABLE_KEY || vars.ANON_KEY;
  const secret = vars.SERVICE_ROLE_KEY || vars.SECRET_KEY;
  if (!pub || !secret) fail('로컬 Supabase CLI에서 키를 조회할 수 없습니다.');
  return { url: url.origin, pub, secret };
}

async function findFixtureUsers({ url, secret }) {
  const result = await fetch(url + '/auth/v1/admin/users?per_page=1000', {
    headers: { apikey: secret, Authorization: 'Bearer ' + secret },
    signal: AbortSignal.timeout(12_000),
  });
  if (!result.ok) fail('로컬 Auth 계정을 조회할 수 없습니다: HTTP ' + result.status);
  const data = await result.json();
  const users = Array.isArray(data.users) ? data.users : [];
  const ids = users.filter((u) => typeof u.email === 'string' &&
    /^local-pure-prep-[a-f0-9]{8}@example\.com$/i.test(u.email) &&
    /^[0-9a-f-]{36}$/i.test(u.id)).map((u) => u.id);
  if (!ids.length) fail('로컬 테스트 계정이 없습니다. 먼저 node scripts/run-local-pure-prep-e2e.mjs 를 한 번 실행하세요.');
  return ids;
}

async function main() {
  const cfg = await localConfig();
  const users = await findFixtureUsers(cfg);

  // Ephemeral env file: no shared/cloud secret material, only local fixture switches.
  // The CLI injects its local Supabase URL/keys to Edge Functions separately.
  const dir = mkdtempSync(join(tmpdir(), 'respec-pure-prep-'));
  const envFile = join(dir, 'local-edge.env');
  writeFileSync(envFile, [
    'LOCAL_PURE_PREP_E2E_FIXTURE=1',
    'PURE_PREP_APPLY_ENABLED=1',
    'PURE_PREP_ALLOWED_USER_IDS=' + users.join(','),
    'PURE_PREP_HISTORY_ENABLED=0',
    'PREPARE_ML_ENABLED=0',
    '',
  ].join('\n'), { mode: 0o600 });

  const procs = [];
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', shutdown);

  console.log('로컬 계정 ' + users.length + '개만 순수 준비시간 계산 기능 대상으로 허용');
  console.log('로컬 외부 API fixture: 장소 2개 (건대입구역, 세종대학교) / 합성 이동시간 30분');
  console.log('실제 카카오 검색/길찾기 데이터가 아닙니다.');
  console.log('팀 공용 Supabase DB와 Edge Functions는 변경하지 않습니다.\n');
  console.log('로컬 Edge Functions 실행...');
  const edge = spawn('npx', ['supabase', 'functions', 'serve', '--env-file', envFile], {
    cwd: root, stdio: 'inherit',
  });
  procs.push(edge);
  edge.on('error', (e) => { console.error('Edge 시작 오류:', e.message); process.exitCode = 1; shutdown(); });
  edge.on('exit', (code) => {
    if (!closing) { console.error('로컬 Edge 서버 종료. 종료코드:', code); process.exitCode = code || 1; shutdown(); }
  });

  console.log('Expo 웹 실행: 기존 웹 서버가 실행 중이라면 먼저 종료하세요.');
  const web = spawn('npm', ['run', 'web'], {
    cwd: mobile,
    env: {
      ...process.env,
      EXPO_PUBLIC_SUPABASE_URL: cfg.url,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.pub,
      EXPO_PUBLIC_API_BASE_URL: '',
      EXPO_PUBLIC_DEMO_PASSWORD: '',
    },
    stdio: 'inherit',
  });
  procs.push(web);
  web.on('error', (e) => { console.error('Expo 시작 오류:', e.message); process.exitCode = 1; shutdown(); });
  web.on('exit', (code) => {
    if (!closing) { process.exitCode = code || 0; shutdown(); }
  });
  console.log('웹에서 로그인은 기존 local-pure-prep-... 계정을 계속 사용하세요.');
  console.log('테스트 화면: http://localhost:8081/dev/screens?mode=real');
  console.log('종료: Ctrl+C');
}

main().catch((e) => {
  console.error('로컬 서버 시작 실패:', e?.message || String(e));
  process.exitCode = 1;
});
