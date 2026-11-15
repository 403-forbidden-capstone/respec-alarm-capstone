// 골든 도구 — 알람 계산 TS에 시나리오 입력을 넣어 나온 결과를 JSON으로 뽑고(generate), 커밋된 골든과 같은지 확인(check)
//   실행 (레포 맨 위에서):
//     node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/golden/golden.ts generate
//     node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/golden/golden.ts check
//   check는 lefthook push 전 검사에서도 돎 (lefthook.yml). 설명 · 파일 모양은 tools/golden/README.md
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from './codec.ts';
import { MODULES, SOURCE_FILES } from './registry.ts';
import { SCENARIOS } from './scenarios/index.ts';
import type { Add } from './scenarios/kit.ts';

export const FORMAT = 1;
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../..');
export const DATA_DIR = join(HERE, 'data');

type Outcome = { output?: unknown; error?: { name: string; message: string } };
export type GoldenCase = { id: string; fn: string; args: unknown[] } & Outcome;

// 상수(함수가 아닌 내보내기)를 한꺼번에 — RegExp는 source 글자로
function constantsOf(ns: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ns).sort()) {
    const value = ns[key];
    if (typeof value === 'function') continue;
    out[key] = value instanceof RegExp ? value.source : value;
  }
  return out;
}

export function runOne(module: string, fn: string, args: unknown[]): Outcome {
  const ns = MODULES[module];
  if (!ns) throw new Error(`골든 모듈이 없음: ${module}`);
  if (fn === '$constants') return { output: encode(constantsOf(ns), `${module}.$constants`) };
  const f = ns[fn];
  if (typeof f !== 'function') throw new Error(`골든 함수가 없음: ${module}.${fn}`);
  let result: unknown;
  try {
    // 함수가 인자를 건드려도 기록한 입력과 어긋나지 않게 복제본을 넘김 (Date도 복제됨)
    result = f(...structuredClone(args));
  } catch (e) {
    if (e instanceof Error) return { error: { name: e.name, message: e.message } };
    throw e;
  }
  // 부호화는 try 밖: 골든에 못 넣는 값(Map · $ 키 · 잘못된 Date)은 "함수가 던진 오류"로 둔갑하지 않고 generate · check를 멈춤
  return result === undefined ? {} : { output: encode(result, `${module}.${fn}`) };
}

// 모든 시나리오를 돌려 모듈별 사례 목록을 만듦 (순서 고정)
export function buildAll(): Map<string, GoldenCase[]> {
  const raw: { module: string; fn: string; name: string; args: unknown[] }[] = [];
  const add: Add = (module, fn, name, ...args) => raw.push({ module, fn, name, args });
  for (const module of Object.keys(MODULES)) add(module, '$constants', 'all');
  for (const scenario of SCENARIOS) scenario(add);

  const warn = console.warn;
  console.warn = () => {}; // ring-package가 문구를 못 만들 때 찍는 경고는 골든과 상관없음
  try {
    const seen = new Set<string>();
    const byModule = new Map<string, GoldenCase[]>(Object.keys(MODULES).map((m) => [m, []]));
    for (const c of raw) {
      const id = `${c.module}/${c.fn}/${c.name}`;
      if (seen.has(id)) throw new Error(`사례 이름이 겹침: ${id}`);
      seen.add(id);
      const args = c.args.map((a, i) => encode(a, `${id}.args[${i}]`));
      byModule.get(c.module)!.push({ id, fn: c.fn, args, ...runOne(c.module, c.fn, c.args) });
    }
    return byModule;
  } finally {
    console.warn = warn;
  }
}

function baseCommit(): string {
  const run = (args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  for (const args of [['merge-base', 'HEAD', 'origin/main'], ['rev-parse', 'HEAD']]) {
    const r = run(args);
    if (r.status === 0 && /^[0-9a-f]{40}$/.test(r.stdout.trim())) return r.stdout.trim();
  }
  return 'unknown';
}

export function sourceSha256(): string {
  const hash = createHash('sha256');
  for (const file of SOURCE_FILES) {
    hash.update(`${file}\n${readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')}\n`);
  }
  return hash.digest('hex');
}

function fileText(module: string, cases: GoldenCase[], meta: { baseCommit: string; sourceSha256: string }): string {
  const lines = cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n');
  return [
    '{',
    `  "format": ${FORMAT},`,
    `  "module": ${JSON.stringify(module)},`,
    `  "baseCommit": ${JSON.stringify(meta.baseCommit)},`,
    `  "sourceSha256": ${JSON.stringify(meta.sourceSha256)},`,
    '  "cases": [',
    lines,
    '  ]',
    '}',
    '',
  ].join('\n');
}

export function generate(): void {
  const all = buildAll();
  const meta = { baseCommit: baseCommit(), sourceSha256: sourceSha256() };
  mkdirSync(DATA_DIR, { recursive: true });
  for (const file of readdirSync(DATA_DIR)) if (file.endsWith('.json')) rmSync(join(DATA_DIR, file)); // 없어진 모듈 파일이 남지 않게
  let total = 0;
  for (const [module, cases] of all) {
    writeFileSync(join(DATA_DIR, `${module}.json`), fileText(module, cases, meta));
    total += cases.length;
    console.log(`${module.padEnd(13)} ${String(cases.length).padStart(5)}건`);
  }
  console.log(`골든 ${all.size}개 파일 · ${total}건 · 기준 커밋 ${meta.baseCommit.slice(0, 8)}`);
  // 오류로 끝난 사례는 일부러 넣은 것이어야 함 — 시나리오 실수가 오류로 가려지지 않게 목록을 보여 줌
  const errors = [...all.values()].flat().filter((c) => c.error);
  console.log(`오류로 기록된 사례 ${errors.length}건 (일부러 넣은 것인지 확인):`);
  for (const c of errors) console.log(`  ${c.id} → ${c.error!.name}: ${c.error!.message.slice(0, 80)}`);
}

// 커밋된 골든 = 지금 TS 결과인지. 다르면 어느 사례가 어떻게 다른지 보여 주고 1을 돌려줌
export function check(): number {
  const all = buildAll();
  const problems: string[] = [];
  const onDisk = new Set(existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')) : []);
  for (const [module, cases] of all) {
    const name = `${module}.json`;
    onDisk.delete(name);
    const path = join(DATA_DIR, name);
    if (!existsSync(path)) {
      problems.push(`${name}: 골든 파일이 없음`);
      continue;
    }
    const file = JSON.parse(readFileSync(path, 'utf8')) as { format?: number; cases?: GoldenCase[] };
    if (file.format !== FORMAT) problems.push(`${name}: 형식 번호가 ${file.format}, 도구는 ${FORMAT}`);
    const committed = new Map((file.cases ?? []).map((c) => [c.id, JSON.stringify(c)]));
    const fresh = new Map(cases.map((c) => [c.id, JSON.stringify(c)]));
    const missing = [...fresh.keys()].filter((id) => !committed.has(id));
    const extra = [...committed.keys()].filter((id) => !fresh.has(id));
    const changed = [...fresh.keys()].filter((id) => committed.has(id) && committed.get(id) !== fresh.get(id));
    if (missing.length) problems.push(`${name}: 골든에 없는 사례 ${missing.length}건 (예: ${missing[0]})`);
    if (extra.length) problems.push(`${name}: 시나리오에 없는 사례 ${extra.length}건 (예: ${extra[0]})`);
    for (const id of changed.slice(0, 3)) problems.push(`${name}: 결과가 달라짐 — ${id}\n    골든: ${committed.get(id)!.slice(0, 300)}\n    지금: ${fresh.get(id)!.slice(0, 300)}`);
    if (changed.length > 3) problems.push(`${name}: 그 밖에 결과가 달라진 사례 ${changed.length - 3}건`);
  }
  for (const stray of onDisk) problems.push(`${stray}: 모듈 목록에 없는 골든 파일`);
  if (!problems.length) {
    console.log(`골든 일치 — ${[...all.values()].reduce((n, c) => n + c.length, 0)}건 (${all.size}개 파일)`);
    return 0;
  }
  console.error('골든과 TS 결과가 다름:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\n계산을 일부러 바꿨다면: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/golden/golden.ts generate`로 골든을 새로 뽑아 같은 PR에 올리고,\n' +
      '서버 레포 Python판도 같은 작업으로 맞춤 (tools/golden/README.md "바꿀 때").\n' +
      '의도하지 않은 변경이면 계산 코드를 되돌림.',
  );
  return 1;
}

// 직접 실행했을 때만 (심볼릭 링크 · Windows 정션 경로로 열어도 같게 보려고 양쪽을 realpath로 맞춤 — import.meta.url은 이미 풀린 경로)
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const command = process.argv[2];
  if (command === 'generate') generate();
  else if (command === 'check') process.exitCode = check();
  else {
    console.error('사용법: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/golden/golden.ts generate | check');
    process.exitCode = 2;
  }
}
