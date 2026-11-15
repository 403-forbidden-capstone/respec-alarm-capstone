// 골든 도구 시험 — 부호화 · 함수 빠짐 없음 · 결정성(시간대와 상관없음) · 커밋된 골든 일치
//   실행: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "tools/golden/*.test.ts"
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { decode, encode } from './codec.ts';
import { DATA_DIR, FORMAT, ROOT, buildAll, check } from './golden.ts';
import { MODULES } from './registry.ts';
import { d, rng } from './scenarios/kit.ts';

describe('codec', () => {
  test('Date · NaN · Infinity를 태그로 감싸고 되돌림', () => {
    const value = { at: d('2026-11-16T10:00:00+09:00'), list: [1, Number.NaN, Infinity, -Infinity, null, 'x', true], nested: { when: new Date(0) } };
    const encoded = encode(value);
    assert.deepEqual(encoded, {
      at: { $date: '2026-11-16T01:00:00.000Z' },
      list: [1, { $num: 'NaN' }, { $num: 'Infinity' }, { $num: '-Infinity' }, null, 'x', true],
      nested: { when: { $date: '1970-01-01T00:00:00.000Z' } },
    });
    const back = decode(JSON.parse(JSON.stringify(encoded))) as typeof value;
    assert.equal(back.at.getTime(), value.at.getTime());
    assert.ok(Number.isNaN(back.list[1] as number) && back.list[2] === Infinity && back.list[3] === -Infinity);
  });

  test('-0은 0으로, undefined 속성은 빠지고 배열 안 undefined는 null (JSON.stringify와 같음)', () => {
    assert.equal(Object.is(encode(-0) as number, 0), true);
    assert.deepEqual(encode({ a: undefined, b: 1 }), { b: 1 });
    assert.deepEqual(encode([undefined, 1]), [null, 1]);
    assert.equal(JSON.stringify(encode({ n: -0, a: [undefined] })), JSON.stringify({ n: -0, a: [undefined] }));
  });

  test('지원하지 않는 값은 조용히 넘기지 않고 멈춤', () => {
    assert.throws(() => encode({ f: () => 1 }), /골든에 못 넣는 값/);
    assert.throws(() => encode({ m: new Map() }), /골든에 못 넣는 객체/);
    assert.throws(() => encode({ s: new Set() }), /골든에 못 넣는 객체/);
    assert.throws(() => encode(10n), /골든에 못 넣는 값/);
    assert.throws(() => encode(new Date(Number.NaN)), /잘못된 Date/);
    assert.throws(() => encode({ $date: 'x' }), /\$로 시작/);
    assert.throws(() => decode({ $num: 'abc' }), /알 수 없는 \$num/);
  });
});

describe('시나리오', () => {
  test('고정 씨앗 난수는 매번 같은 수열', () => {
    const a = rng(1234);
    const b = rng(1234);
    assert.deepEqual([a.int(0, 1000), a.int(0, 1000), a.int(0, 1000)], [b.int(0, 1000), b.int(0, 1000), b.int(0, 1000)]);
    assert.notDeepEqual(rng(1).int(0, 1e9), rng(2).int(0, 1e9));
  });

  test('모듈이 내보내는 함수는 모두 골든 사례가 하나 이상 있음 (새 함수를 만들면 사례도 추가)', () => {
    // 이어 부르는 함수(Plan을 인자로 받는 것)는 합친 함수의 사례로 덮임
    const viaComposite: Record<string, Record<string, string>> = {
      'plan-core': { toSuggestion: 'toSuggestionOfPlan', intensityReason: 'intensityReasonOf' },
      'commit-core': { diffAlarms: 'diffAlarmsOfPlan' },
    };
    const all = buildAll();
    const missing: string[] = [];
    for (const [module, ns] of Object.entries(MODULES)) {
      const covered = new Set((all.get(module) ?? []).map((c) => c.fn));
      for (const [name, value] of Object.entries(ns)) {
        if (typeof value !== 'function' || covered.has(name)) continue;
        const via = viaComposite[module]?.[name];
        if (via && covered.has(via)) continue;
        missing.push(`${module}.${name}`);
      }
    }
    assert.deepEqual(missing, [], `골든 사례가 없는 함수: ${missing.join(', ')}`);
  });

  test('모든 모듈에 상수 사례($constants)가 있고 값이 비어 있지 않음', () => {
    for (const [module, cases] of buildAll()) {
      const constants = cases.find((c) => c.fn === '$constants');
      assert.ok(constants, `${module}: $constants 없음`);
      if (module === 'types') assert.ok(Object.keys(constants.output as object).includes('KIND_LABEL'));
    }
  });

  test('사례 모양: id 유일 · args는 배열 · 결과와 오류가 동시에 없음 · 날짜는 UTC 글자', () => {
    const ids = new Set<string>();
    const dates: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.$date === 'string') dates.push(o.$date);
        Object.values(o).forEach(walk);
      }
    };
    for (const cases of buildAll().values()) {
      for (const c of cases) {
        assert.ok(!ids.has(c.id), `id 겹침: ${c.id}`);
        ids.add(c.id);
        assert.ok(Array.isArray(c.args), c.id);
        assert.ok(!(c.output !== undefined && c.error !== undefined), `결과와 오류가 같이 있음: ${c.id}`);
        walk(c.args);
        walk(c.output);
      }
    }
    assert.ok(dates.length > 1000);
    for (const date of dates) assert.match(date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('결정성', () => {
  test('두 번 뽑으면 글자까지 같음', () => {
    const text = (m: Map<string, unknown[]>) => JSON.stringify([...m]);
    assert.equal(text(buildAll()), text(buildAll()));
  });

  test('실행 PC의 시간대(TZ)와 상관없이 같은 골든이 나옴', () => {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Seoul', 'Pacific/Kiritimati']) {
      const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(ROOT, 'tools/golden/golden.ts'), 'check'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
      assert.equal(r.status, 0, `TZ=${tz}\n${r.stdout}${r.stderr}`);
    }
  });
});

describe('커밋된 골든', () => {
  test('지금 서버 TS 결과와 같음 (다르면 `golden.ts generate`로 새로 뽑아 같은 PR에)', () => {
    assert.equal(check(), 0);
  });

  test('파일 머리말: 형식 · 모듈 이름 · 기준 커밋(40자) · 소스 해시(64자)', () => {
    const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, Object.keys(MODULES).length);
    for (const file of files) {
      const parsed = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
      assert.equal(parsed.format, FORMAT);
      assert.equal(`${parsed.module}.json`, file);
      assert.match(parsed.baseCommit, /^[0-9a-f]{40}$/);
      assert.match(parsed.sourceSha256, /^[0-9a-f]{64}$/);
      assert.ok(Array.isArray(parsed.cases) && parsed.cases.length > 0);
    }
  });
});
