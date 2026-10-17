// 프로젝트 ref 확인 — SEED_PROJECT_REF가 있으면 URL의 프로젝트와 같아야 하고 다르면 멈춤 (네트워크 안 씀)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkProjectRef, projectRef } from './project-ref.mjs';

const URL_A = 'https://gomrhctwjvttoqifxktt.supabase.co';

test('주소에서 프로젝트 ref를 읽음, 주소 모양이 아니면 알기 쉬운 오류', () => {
  assert.equal(projectRef(URL_A), 'gomrhctwjvttoqifxktt');
  assert.equal(projectRef(`${URL_A}/`), 'gomrhctwjvttoqifxktt');
  assert.throws(() => projectRef('not a url'), /주소 모양이 아니에요/);
});

test('SEED_PROJECT_REF가 같으면 통과 (대소문자 · 앞뒤 공백은 무시)', () => {
  assert.deepEqual(checkProjectRef(URL_A, 'gomrhctwjvttoqifxktt'), { ref: 'gomrhctwjvttoqifxktt', checked: true });
  assert.deepEqual(checkProjectRef(URL_A, '  GomrhctwjvttoqifxkTT '), { ref: 'gomrhctwjvttoqifxktt', checked: true });
});

test('SEED_PROJECT_REF가 다르면 멈춤 — 오류에 URL의 프로젝트와 기대한 프로젝트가 둘 다 나옴', () => {
  assert.throws(
    () => checkProjectRef(URL_A, 'otherprojectref'),
    (e) => e instanceof Error && e.message.includes('gomrhctwjvttoqifxktt') && e.message.includes('otherprojectref') && /멈췄어요/.test(e.message),
  );
  // 주소 전체를 적으면 ref와 다르므로 멈춤 (ref만 적으라고 안내)
  assert.throws(() => checkProjectRef(URL_A, URL_A), /ref만 적어요/);
});

test('SEED_PROJECT_REF가 없거나 비어 있으면 확인하지 않음 (지금처럼 프로젝트를 보여 주고 --yes만)', () => {
  for (const empty of [undefined, '', '   ']) {
    assert.deepEqual(checkProjectRef(URL_A, empty), { ref: 'gomrhctwjvttoqifxktt', checked: false });
  }
});

// ---- seed.mjs 전체: 환경 변수만 주고 돌려서 네트워크 전에 멈추는지 (서비스 키 · URL은 가짜) ----

const SEED = join(dirname(fileURLToPath(import.meta.url)), 'seed.mjs');
function runSeed(args, env) {
  const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', SEED, ...args], {
    env: { ...process.env, SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'not-a-real-key', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('seed.mjs: SEED_PROJECT_REF가 URL의 프로젝트와 다르면 --yes가 있어도 계정을 건드리기 전에 멈춤', () => {
  const r = runSeed(['reset', '--yes'], { SEED_PROJECT_REF: 'bbbbbbbbbbbbbbbbbbbb' });
  assert.equal(r.status, 1);
  assert.match(r.out, /aaaaaaaaaaaaaaaaaaaa/);
  assert.match(r.out, /bbbbbbbbbbbbbbbbbbbb/);
  assert.match(r.out, /멈췄어요/);
  assert.doesNotMatch(r.out, /데모 계정 \d+개를 지웠어요/); // 아무것도 안 지움
});

test('seed.mjs: SEED_PROJECT_REF가 같으면 "확인함"을 보여 주지만 --yes가 없으면 그래도 멈춤', () => {
  const r = runSeed(['reset'], { SEED_PROJECT_REF: 'aaaaaaaaaaaaaaaaaaaa' });
  assert.equal(r.status, 1);
  assert.match(r.out, /SEED_PROJECT_REF와 같음/);
  assert.match(r.out, /--yes/);
});
