// 로컬 스택 주소 · 키 · 시드 비밀번호 읽기. 로컬(127.0.0.1)이 아니면 멈춤. 값은 어디에도 출력하지 않음
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

// KEY=VALUE 줄만 읽음 (따옴표 · 주석 처리). 이미 있는 환경 변수가 먼저
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function isLocalUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

// 시드 .env 위치: E2E_SEED_ENV → 이 레포의 supabase/seed/.env (깃 제외 파일이라 worktree엔 없을 수 있음)
function seedEnvPath() {
  const candidates = [process.env.E2E_SEED_ENV, join(REPO_ROOT, 'supabase', 'seed', '.env')].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

// 로컬 스택의 공개(anon) 키: E2E_ANON_KEY → `supabase status -o json`
// 로컬 공개 키는 비밀이 아니고 스택을 다시 만들기 전엔 안 바뀜 → 임시 폴더에 두고 쓰면 `supabase status`(Windows에서 가끔 Node가 죽는 spawnSync)를 부르는 횟수가 줄어듦.
// 쓰기 전에 그 키가 지금 스택에서 통하는지 한 번 확인하고(안 통하면 새로 읽음)
const ANON_CACHE = join(tmpdir(), 'friend-e2e-anon-key.json');
function cachedAnonKey(url) {
  try {
    const j = JSON.parse(readFileSync(ANON_CACHE, 'utf8'));
    if (j.url !== url || !j.key) return undefined;
    const r = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(url + '/auth/v1/settings')},{headers:{apikey:${JSON.stringify(j.key)}}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`], { timeout: 8000 });
    return r.status === 0 ? j.key : undefined;
  } catch {
    return undefined;
  }
}
function anonKeyFromStatus(url) {
  const key = anonKeyFromStatusRaw();
  if (key && url) {
    try {
      writeFileSync(ANON_CACHE, JSON.stringify({ url, key }));
    } catch {
      /* 캐시는 편의일 뿐 */
    }
  }
  return key;
}
function anonKeyFromStatusRaw() {
  // 로컬 스택이 바쁠 때 status가 잠깐 실패할 수 있어 세 번까지 다시 시도
  for (let i = 0; i < 3; i += 1) {
    const key = anonKeyOnce();
    if (key) return key;
  }
  return undefined;
}
function anonKeyOnce() {
  const r = spawnSync('npx', ['supabase', 'status', '-o', 'json'], { cwd: REPO_ROOT, shell: true, encoding: 'utf8' });
  const start = (r.stdout ?? '').indexOf('{');
  if (start < 0) return undefined;
  try {
    const j = JSON.parse(r.stdout.slice(start));
    return j.ANON_KEY ?? j.PUBLISHABLE_KEY;
  } catch {
    return undefined;
  }
}

export function loadEnv() {
  const file = seedEnvPath();
  if (!file) {
    throw new Error('supabase/seed/.env를 못 찾음 — E2E_SEED_ENV에 그 파일 경로를 넣어 주세요 (깃 제외 파일)');
  }
  const seed = parseEnvFile(readFileSync(file, 'utf8'));
  const get = (k) => process.env[k] ?? seed[k];
  const url = get('SUPABASE_URL');
  const serviceKey = get('SUPABASE_SERVICE_ROLE_KEY');
  const password = get('SEED_PASSWORD');
  if (!url || !serviceKey || !password) throw new Error('시드 .env에 SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · SEED_PASSWORD가 없음');
  if (!isLocalUrl(url)) throw new Error('로컬 스택(127.0.0.1)이 아니라서 멈춤 — 이 시험은 실서버에 붙지 않음');
  const anonKey = process.env.E2E_ANON_KEY ?? cachedAnonKey(url) ?? anonKeyFromStatus(url);
  if (!anonKey) throw new Error('로컬 공개 키를 못 읽음 — `npx supabase status`가 되는지 보거나 E2E_ANON_KEY를 넣어 주세요');
  return { url, serviceKey, anonKey, password };
}
