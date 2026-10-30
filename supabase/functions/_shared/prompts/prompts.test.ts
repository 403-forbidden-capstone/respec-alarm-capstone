// 프롬프트 모듈 시험 — 서버가 쓰는 글(.ts 모듈)이 실험에서 쓴 글(docs/ai-lab/prompts/*.md)과 같은지,
// 지점 설정(index.ts)이 모두 실제 모듈 · 스키마를 가리키는지 확인.
// 지문은 실험실 장부(runs/ledger.jsonl)의 prompt_id "ID@판#지문"과 같은 값 — 줄바꿈을 LF로 맞춘 파일 전체의 FNV-1a.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { DEFAULT_MODEL } from '../ai/llm.ts';
import { render, templateVars } from '../ai/render.ts';
import { SCHEMAS, schemaOf } from '../ai/schemas/index.ts';
import { normalizeNewlines, parsePromptMd, PROMPTS, promptModuleSource, promptSha, SCHEMAS as GEN_SCHEMAS } from './gen.mjs';
import { POINTS, type PointId } from './index.ts';

const here = new URL('./', import.meta.url);
const readMd = (name: string): string => readFileSync(new URL(`../../../../docs/ai-lab/prompts/${name}.md`, import.meta.url), 'utf8');
const readModule = (name: string): string => readFileSync(new URL(`${name}.ts`, here), 'utf8');

// 실험실 장부의 prompt_id (채택한 실행본)
const LEDGER: Record<string, string> = {
  'T1.v1.3': 'T1@v1.3#1a1d234b',
  'T2.v2': 'T2@v2#d5dff11c',
  'T2F.v2-a': 'T2F@v2-a#d2c172e5',
  'T4.v1.1': 'T4@v1.1#b597fc65',
  'T5.v1.2': 'T5@v1.2#d792df8d',
  'ASSIST_E4.v1.1': 'ASSIST_E4@v1.1#71eed0db',
  'T3.v1': 'T3@v1#5dd07ef4',
};

// 지점 → 파일 이름
const FILE_OF: Record<PointId, string> = {
  T1: 'T1.v1.3',
  T2F: 'T2F.v2-a',
  T2: 'T2.v2',
  T3: 'T3.v1',
  T4: 'T4.v1.1',
  T5: 'T5.v1.2',
  E4: 'ASSIST_E4.v1.1',
};

// 사용자 템플릿이 받는 변수 (바뀌면 서버에서 넘기는 쪽도 같이 바꿔야 하므로 고정해 둠)
const VARS: Record<PointId, string[]> = {
  T1: ['context', 'transcript'],
  T2F: ['context', 'transcript'],
  T2: ['context', 'transcript'],
  T3: ['utterance'],
  T4: ['date_line', 'facts', 'appointments', 'todos', 'record_amount'],
  T5: ['date_line', 'facts', 'appointments', 'routine_eligible', 'server_saved', 'week_pattern', 'transcript'],
  E4: ['mode_hybrid', 'mode_stats', 'appointments', 'plan_line', 'rule_block', 'stats_block', 'target_line', 'window_days', 'window_line'],
};

describe('프롬프트 모듈 = md 원본', () => {
  for (const name of PROMPTS as string[]) {
    it(`${name}: 모듈의 id · 판 · 머리말 · system · user가 md와 글자까지 같음`, async () => {
      const md = parsePromptMd(readMd(name));
      const mod = (await import(`./${name}.ts`)).default;
      assert.equal(mod.id, md.id);
      assert.equal(mod.version, md.version);
      assert.deepEqual({ ...mod.meta }, md.meta);
      assert.equal(mod.system, md.system);
      assert.equal(mod.user, md.user);
      assert.equal(`${md.id}.${md.version}`, name); // 파일 이름 = id.판
    });

    it(`${name}: 생성기가 지금 만드는 글과 커밋된 모듈 파일이 같음 (손으로 고치지 않았음)`, () => {
      // 윈도 CRLF 체크아웃이어도 같게 양쪽을 LF로 맞춰 비교 (.gitattributes는 eol=lf라 보통 필요 없음)
      assert.equal(normalizeNewlines(readModule(name)), normalizeNewlines(promptModuleSource(name, readMd(name))));
    });

    it(`${name}: 지문이 실험실 장부와 같음 (${LEDGER[name]})`, () => {
      const md = parsePromptMd(readMd(name));
      assert.equal(`${md.id}@${md.version}#${promptSha(readMd(name))}`, LEDGER[name]);
    });
  }

  it('지문은 줄바꿈 · BOM에 흔들리지 않음 (윈도 · 리눅스에서 같은 값)', () => {
    const md = readMd('T3.v1');
    assert.equal(promptSha(md.replace(/\n/g, '\r\n')), promptSha(md));
    assert.equal(promptSha('﻿' + md), promptSha(md));
    assert.notEqual(promptSha(md + ' '), promptSha(md));
    assert.equal(promptSha(''), '811c9dc5');
    assert.equal(normalizeNewlines('a\r\nb\rc'), 'a\nb\nc');
  });

  it('system에는 변수({{)가 없음 — 모델에 보내는 그대로이므로', async () => {
    for (const name of PROMPTS as string[]) {
      const mod = (await import(`./${name}.ts`)).default;
      assert.equal(mod.system.includes('{{'), false, name);
      assert.ok(mod.system.length > 200, name);
    }
  });

  it('prompts/ 폴더의 모듈 파일 = 쓰는 판 목록 (덮어쓰기 · 빠진 파일 없음)', () => {
    const files = readdirSync(here).filter((f) => f.endsWith('.ts') && f !== 'index.ts' && !f.endsWith('.test.ts')).map((f) => f.replace(/\.ts$/, ''));
    assert.deepEqual(files.sort(), [...(PROMPTS as string[])].sort());
  });
});

describe('지점 설정(index.ts)', () => {
  const ids = Object.keys(POINTS) as PointId[];

  it('지점 7개, ai_calls.point 값과 같은 이름', () => {
    assert.deepEqual([...ids].sort(), ['E4', 'T1', 'T2', 'T2F', 'T3', 'T4', 'T5']);
  });

  for (const p of ids) {
    it(`${p}: 모듈 · 스키마 · effort · thinking이 서로 맞음`, async () => {
      const cfg = POINTS[p];
      const mod = (await import(`./${FILE_OF[p]}.ts`)).default;
      assert.equal(cfg.prompt, mod); // 같은 모듈 객체
      assert.equal(cfg.prompt.meta.schema, cfg.schema); // 머리말이 가리키는 스키마 = 지점이 쓰는 스키마
      assert.equal(cfg.prompt.meta.effort, cfg.effort);
      assert.equal(cfg.prompt.meta.model, DEFAULT_MODEL);
      assert.equal(cfg.prompt.meta.thinking === 'adaptive', cfg.thinking !== null); // 머리말에 adaptive가 있는 지점만 보냄
      assert.ok(SCHEMAS[cfg.schema], `${cfg.schema} 없음`);
      assert.equal(schemaOf(cfg.schema), SCHEMAS[cfg.schema]);
      assert.equal(cfg.cacheSystem, true);
      assert.ok(Number.isInteger(cfg.maxTokens) && cfg.maxTokens >= 1024);
      assert.ok(cfg.timeoutMs >= 4_000 && cfg.timeoutMs <= 30_000);
      assert.deepEqual(templateVars(cfg.prompt.user).sort(), [...VARS[p]].sort());
    });

    it(`${p}: user 템플릿을 변수로 채우면 {{ 가 남지 않음`, () => {
      const vars = Object.fromEntries(VARS[p].map((n) => [n, '값']));
      const out = render(POINTS[p].prompt.user, vars);
      assert.equal(out.includes('{{'), false);
      assert.ok(out.length > 0);
    });
  }

  it('모든 판 파일이 지점 하나씩에 쓰임, 쓰는 스키마 7개 = 생성기 목록', () => {
    const used = ids.map((p) => FILE_OF[p]).sort();
    assert.deepEqual(used, [...(PROMPTS as string[])].sort());
    assert.deepEqual([...new Set(ids.map((p) => POINTS[p].schema))].sort(), [...(GEN_SCHEMAS as string[])].sort());
  });

  it('지점 설정 값 (실험실 채택 실행 설정)', () => {
    const row = (p: PointId) => {
      const c = POINTS[p];
      return [c.prompt.id, c.prompt.version, c.schema, c.effort, c.maxTokens, c.thinking?.type ?? null, c.timeoutMs, c.retryOnTimeout];
    };
    assert.deepEqual(row('T1'), ['T1', 'v1.3', 't1-reply.v1', 'low', 2048, null, 13_000, true]);
    assert.deepEqual(row('T2F'), ['T2F', 'v2-a', 'extract-fast.v1', 'low', 4096, 'adaptive', 5_000, false]);
    assert.deepEqual(row('T2'), ['T2', 'v2', 'extract.v1', 'medium', 4096, null, 19_000, true]);
    assert.deepEqual(row('T3'), ['T3', 'v1', 't3-reason.v1', 'low', 1024, null, 4_000, true]);
    assert.deepEqual(row('T4'), ['T4', 'v1.1', 't4-diary.v1', 'medium', 4096, null, 11_000, true]);
    assert.deepEqual(row('T5'), ['T5', 'v1.2', 't5-journal.v1', 'medium', 6000, null, 26_000, true]);
    assert.deepEqual(row('E4'), ['ASSIST_E4', 'v1.1', 'assist-e4.v1', 'medium', 8000, null, 28_000, true]);
  });
});

describe('gen.mjs — md 읽기 규칙', () => {
  const ok = ['---', 'id: X', 'version: v1', 'model: claude-haiku-5-5', '---', '', '## system', '규칙 `하나` ${돈} \\n', '', '## user', '{{a}}', ''].join('\n');

  it('머리말 · 구획 · 앞뒤 빈 줄 정리, 모르는 머리말 키는 meta로', () => {
    const p = parsePromptMd(ok);
    assert.deepEqual(p, { id: 'X', version: 'v1', meta: { model: 'claude-haiku-5-5' }, system: '규칙 `하나` ${돈} \\n', user: '{{a}}' });
    assert.deepEqual(parsePromptMd(ok.replace(/\n/g, '\r\n')), p);
  });

  it('백틱 · ${ · 역슬래시가 든 글도 모듈에 그대로 들어감', async () => {
    const src = promptModuleSource('X.v1', ok);
    // 모듈은 TS(as const)라 그대로는 못 불러옴 — 끝의 as const만 떼고 JS로 불러 값을 확인
    const js = src.replace(/\} as const;\n$/, '};\n');
    assert.notEqual(js, src);
    const mod = (await import(`data:text/javascript,${encodeURIComponent(js)}`)).default;
    assert.equal(mod.system, '규칙 `하나` ${돈} \\n');
    assert.equal(mod.user, '{{a}}');
  });

  it('틀린 모양은 던짐', () => {
    assert.throws(() => parsePromptMd('## system\nx'), /머리말/);
    assert.throws(() => parsePromptMd('---\nid: X\n## system'), /닫는/);
    assert.throws(() => parsePromptMd('---\nversion: v1\n---\n## system\na\n## user\nb'), /id · version/);
    assert.throws(() => parsePromptMd('---\nid: X\nversion: v1\n---\n## system\na'), /둘 다/);
    assert.throws(() => parsePromptMd('---\nid: X\nversion: v1\n---\n## system\na\n## system\nb\n## user\nc'), /두 번/);
    assert.throws(() => parsePromptMd('---\nid: X\nversion: v1\n---\n메모\n## system\na\n## user\nb'), /앞에 내용/);
    assert.throws(() => parsePromptMd('---\nid: X\nversion: v1\n---\n## system\n{{a}}\n## user\nb'), /system'에 \{\{/);
    assert.throws(() => parsePromptMd('---\nid: X\nversion: v1\n---\n## system\na\n## user\n\n'), /비어/);
  });
});
