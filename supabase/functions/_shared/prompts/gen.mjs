// 프롬프트 · 스키마 모듈 만들기 — 서버 함수는 파일을 읽지 않으므로(Edge Function에는 md가 안 실림) 글을 .ts 모듈로 굳혀 둠.
//
//   node supabase/functions/_shared/prompts/gen.mjs --schemas <ai-lab 폴더>/schemas
//
//   프롬프트: docs/ai-lab/prompts/<이름>.md  →  _shared/prompts/<이름>.ts   (아래 PROMPTS 목록)
//   스키마:   <ai-lab>/schemas/<id>.json     →  _shared/ai/schemas/<id>.ts  (아래 SCHEMAS 목록)
//
// 스키마 원본은 팀 레포에 두지 않음: 실험실의 `npm run share`가 docs/ai-lab/을 통째로 지우고 다시 쓰는데 schemas/는 올리는 목록에 없어서
// 사본을 두면 다음 share 때 사라짐. 그래서 .ts가 레포의 원본이고, 실험실과 같은지는 지문(prompts.test.ts · schema.test.ts)으로 대조함.
// 스키마를 새로 가져올 때만 --schemas가 필요하고, 프롬프트는 레포 안 md만 있으면 됨.
//
// 순수 Node (외부 패키지 없음). 시험이 parsePromptMd · promptModuleSource를 불러 써서 md와 모듈이 글자까지 같은지 대조함.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

// 쓰는 판 목록. 새 판은 여기에 한 줄 더하고 md를 docs/ai-lab/prompts/에 둔 뒤 다시 돌림 (옛 판 줄은 지우지 않음 — index.ts 머리 주석)
export const PROMPTS = ['T1.v1.3', 'T1.v1.4', 'T1.v1.5', 'T1.v1.6', 'T1.v1.7', 'T2F.v2-a', 'T2F.v2-b', 'T2F.v2-c', 'T2F.v2-d', 'T2F.v2-e', 'T2F.v2-f', 'T2F.v2-g', 'T2F.v2-h', 'T2.v2', 'T2.v3', 'T2.v3.1', 'T2.v3.2', 'T2.v3.3', 'T2.v3.4', 'T3.v1', 'T4.v1.1', 'T5.v1.2', 'T5.v2', 'T5.v3', 'ASSIST_E4.v1.1'];
export const SCHEMAS = ['t1-reply.v1', 'extract.v1', 'extract-fast.v1', 't4-diary.v1', 't5-journal.v1', 'assist-e4.v1', 't3-reason.v1'];

// ---------------------------------------------------------------------------
// md 읽기 — 실험실 src/lib/render.ts parsePromptFile과 같은 규칙 (줄바꿈 정규화, 앞뒤 빈 줄 · 끝 공백 정리)
//   ---
//   id: T1 / version: v1.3 / model / effort / schema / (thinking …)
//   ---
//   ## system
//   ## user
// ---------------------------------------------------------------------------

const SECTION_RE = /^##[ \t]+(system|user)[ \t]*$/i;

/** BOM 제거 + CRLF/CR → LF. 윈도 · 리눅스에서 같은 파일이면 같은 글이 나오게 */
export function normalizeNewlines(text) {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** 앞쪽 빈 줄과 끝 공백을 걷어 낸다(가운데는 그대로) */
function trimBlock(lines) {
  let a = 0;
  while (a < lines.length && lines[a].trim() === '') a++;
  return lines.slice(a).join('\n').trimEnd();
}

/** FNV-1a 32비트(UTF-8 바이트), 16진 8자리. 실험실 promptSha와 같은 계산 — 장부의 prompt_id "T1@v1.3#1a1d234b" 뒤 지문 */
export function promptSha(text) {
  const bytes = new TextEncoder().encode(normalizeNewlines(text));
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** md 글 → { id, version, meta(나머지 머리말), system, user } */
export function parsePromptMd(text) {
  const lines = normalizeNewlines(text).split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if ((lines[i] ?? '').trim() !== '---') throw new Error('첫 줄이 --- 머리말이 아님');
  i++;

  const fields = new Map();
  let closed = false;
  for (; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (ln === '---') {
      closed = true;
      i++;
      break;
    }
    if (ln === '' || ln.startsWith('#')) continue;
    const colon = ln.indexOf(':');
    if (colon < 0) throw new Error(`머리말 줄에 ':'가 없음 — '${ln}'`);
    const key = ln.slice(0, colon).trim();
    let value = ln.slice(colon + 1).trim();
    if (fields.has(key)) throw new Error(`머리말 키 '${key}'가 두 번 나옴`);
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) value = value.slice(1, -1);
    if (value === '') throw new Error(`머리말 '${key}' 값이 비어 있음`);
    fields.set(key, value);
  }
  if (!closed) throw new Error('머리말을 닫는 --- 가 없음');

  const id = fields.get('id');
  const version = fields.get('version');
  if (!id || !version) throw new Error('머리말에 id · version이 있어야 함');
  const meta = {};
  for (const [k, v] of fields) if (k !== 'id' && k !== 'version') meta[k] = v;

  const body = { system: null, user: null };
  let cur = null;
  for (; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i]);
    if (m) {
      const name = m[1].toLowerCase();
      if (body[name] !== null) throw new Error(`'## ${name}' 구획이 두 번 나옴`);
      cur = body[name] = [];
      continue;
    }
    if (cur === null) {
      if (lines[i].trim() !== '') throw new Error("'## system'/'## user' 앞에 내용이 있음");
      continue;
    }
    cur.push(lines[i]);
  }
  if (body.system === null || body.user === null) throw new Error("'## system' · '## user' 구획이 둘 다 있어야 함");
  const system = trimBlock(body.system);
  const user = trimBlock(body.user);
  if (user === '') throw new Error("'## user' 구획이 비어 있음");
  // system은 모델에 보내는 글 그대로(채울 변수가 없음). user는 {{변수}} 템플릿 원문
  if (system.includes('{{')) throw new Error("'## system'에 {{ 가 있음 — system은 변수 없이 쓰는 규칙이라 모듈에 그대로 굳힘");
  return { id, version, meta, system, user };
}

// ---------------------------------------------------------------------------
// .ts 만들기
// ---------------------------------------------------------------------------

/** 글을 백틱 글(template literal)에 안전하게 넣음: \ ` ${ 만 이스케이프 — 줄바꿈은 그대로 둬서 프롬프트 고침이 줄 단위 diff로 보임 */
function templateLiteral(text) {
  return '`' + text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
}

const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** 프롬프트 모듈 글. name = "T1.v1.3" */
export function promptModuleSource(name, mdText) {
  const p = parsePromptMd(mdText);
  const meta = Object.entries(p.meta).map(([k, v]) => `${/^[A-Za-z_]\w*$/.test(k) ? k : q(k)}: ${q(v)}`).join(', ');
  return [
    `// 생성 파일 — 고치지 말 것. docs/ai-lab/prompts/${name}.md(실험실에서 share로 복사됨)를 gen.mjs로 굳힌 것.`,
    '// 글이 바뀌면 이 파일을 덮어쓰지 말고 새 판 파일을 만들 것 (index.ts 머리 주석 "판 관리").',
    '// system = 모델에 보내는 그대로, user = {{변수}} 템플릿 원문 (ai/render.ts로 채움).',
    'export default {',
    `  id: ${q(p.id)},`,
    `  version: ${q(p.version)},`,
    `  meta: { ${meta} },`,
    `  system: ${templateLiteral(p.system)},`,
    `  user: ${templateLiteral(p.user)},`,
    '} as const;',
    '',
  ].join('\n');
}

/** 스키마 모듈 글. 키 순서는 원본 그대로(구조화 출력은 속성 순서대로 생성하므로 지문에도 순서가 들어감) */
export function schemaModuleSource(id, jsonText) {
  const schema = JSON.parse(jsonText);
  return [
    `// 생성 파일 — 고치지 말 것. 실험실 schemas/${id}.json을 gen.mjs로 옮긴 것 (팀 레포에는 JSON 사본을 두지 않음 — gen.mjs 머리 주석).`,
    '// 실험실과 같은지는 지문 대조(schema.test.ts)로 확인. 바뀌면 새 id(.v2)로 만들 것.',
    "import type { JsonSchema } from '../schema.ts';",
    '',
    `const schema: JsonSchema = ${JSON.stringify(schema, null, 2)};`,
    '',
    'export default schema;',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

function main(argv) {
  const at = argv.indexOf('--schemas');
  const schemaDir = at >= 0 ? path.resolve(argv[at + 1] ?? '') : null;

  const promptsOut = here;
  const mdDir = path.join(repoRoot, 'docs/ai-lab/prompts');
  for (const name of PROMPTS) {
    const md = fs.readFileSync(path.join(mdDir, `${name}.md`), 'utf8');
    fs.writeFileSync(path.join(promptsOut, `${name}.ts`), promptModuleSource(name, md));
    console.log(`[gen] prompts/${name}.ts`);
  }

  if (schemaDir) {
    const schemasOut = path.resolve(here, '../ai/schemas');
    fs.mkdirSync(schemasOut, { recursive: true });
    for (const id of SCHEMAS) {
      const json = fs.readFileSync(path.join(schemaDir, `${id}.json`), 'utf8');
      fs.writeFileSync(path.join(schemasOut, `${id}.ts`), schemaModuleSource(id, json));
      console.log(`[gen] ai/schemas/${id}.ts`);
    }
  } else {
    console.log('[gen] --schemas <ai-lab 폴더>/schemas 를 안 줘서 스키마는 건너뜀');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
