// 골든 도구 시험 — 부호화 · 함수 빠짐 없음 · 결정성(시간대와 상관없음) · 커밋된 골든 일치
//   실행: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "tools/golden/*.test.ts"
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { decode, encode } from './codec.ts';
import { DATA_DIR, FORMAT, ROOT, buildAll, check, runOne, sameGoldenCase } from './golden.ts';
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

describe('golden comparison', () => {
  const base = { id: 'travel/haversineKm/sample', fn: 'haversineKm', args: [1, 2], output: { distance: 8009.972817262573 } };

  test('platform-dependent final digits in fractional outputs are tolerated', () => {
    assert.ok(sameGoldenCase(base, { ...base, output: { distance: 8009.972817262571 } }));
  });

  test('meaningful fractional changes and integer differences fail', () => {
    assert.ok(!sameGoldenCase(base, { ...base, output: { distance: 8009.9 } }));
    assert.ok(!sameGoldenCase({ ...base, output: { minutes: 35 } }, { ...base, output: { minutes: 36 } }));
  });

  test('arguments, errors, field presence and structure remain strict', () => {
    assert.ok(!sameGoldenCase(base, { ...base, args: [1, 3] }));
    assert.ok(!sameGoldenCase(base, { ...base, output: { distance: 8009.972817262573, extra: true } }));
    assert.ok(!sameGoldenCase(base, { ...base, output: { distance: 8009.972817262573 }, error: { name: 'Error', message: 'x' } }));
    assert.ok(!sameGoldenCase({ ...base, output: 1 }, { ...base, output: 1.0000000000000002 }));
    assert.ok(!sameGoldenCase({ ...base, output: { nested: [0.1, 'x'] } }, { ...base, output: { nested: [0.1, 'y'] } }));
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

describe('도구 실행', () => {
  test('골든에 못 넣는 결과(Map · $ 키 · 잘못된 Date)는 "함수가 던진 오류" 사례가 되지 않고 멈춤', () => {
    MODULES.__fake = { returnsMap: () => new Map(), returnsDollarKey: () => ({ $x: 1 }), returnsBadDate: () => new Date(Number.NaN), throwsOwn: () => { throw new RangeError('내가 던짐'); }, returnsNothing: () => undefined };
    try {
      for (const fn of ['returnsMap', 'returnsDollarKey', 'returnsBadDate']) assert.throws(() => runOne('__fake', fn, []), /골든에 못 넣는|\$로 시작|잘못된 Date/, fn);
      assert.deepEqual(runOne('__fake', 'throwsOwn', []), { error: { name: 'RangeError', message: '내가 던짐' } });
      assert.deepEqual(runOne('__fake', 'returnsNothing', []), {});
    } finally {
      delete MODULES.__fake;
    }
  });

  test('심볼릭 링크 · 정션 경로로 열어도 check가 돌고 결과를 말함 (조용히 통과하지 않음)', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-link-'));
    const link = join(dir, 'golden');
    try {
      symlinkSync(join(ROOT, 'tools/golden'), link, 'junction');
    } catch {
      rmSync(dir, { recursive: true, force: true });
      t.skip('이 환경에서는 링크를 못 만듦');
      return;
    }
    try {
      const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(link, 'golden.ts'), 'check'], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /골든 일치/);
      const usage = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(link, 'golden.ts')], { encoding: 'utf8' });
      assert.equal(usage.status, 2);
      assert.match(usage.stderr, /사용법/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
