// 스키마 변형 · 되돌림 · 검증 시험 — 실험실(ai-lab) tests/llm.test.ts의 schema · 검토 사례와 gold · e4 시험의 validate 사례를 옮김.
// 실험실은 ajv로 검증했고 여기는 직접 만든 검증기라서, 오류 문구가 ajv와 같은지(경로: must have required property 'x' …)를 사례로 고정함.
// (옮길 때 실험실 ajv와 같은 입력 약 2.8만 건으로 오류 목록 전체가 같은지도 한 번 대조했음 — PR 본문)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  apiLimitProblems, apiSchemaInfo, apiSchemaStats, decodeSentinels, deepFreeze, findUnsupported, fnv1aHex, fromApiOutput,
  restoreNulls, schemaSha, toApiSchema, toApiSchemaInfo, validate, type JsonSchema,
} from './schema.ts';
import { SCHEMAS, schemaOf, type SchemaId } from './schemas/index.ts';

const extract = schemaOf('extract.v1');

// JSON Schema 키워드 자리(속성 이름 제외)에 쓰인 키 모음
function keywordKeys(schema: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (n: unknown) => {
    if (typeof n !== 'object' || n === null || Array.isArray(n)) return;
    for (const [k, v] of Object.entries(n)) {
      out.add(k);
      if ((k === 'properties' || k === '$defs') && typeof v === 'object' && v !== null) Object.values(v).forEach(visit);
      else if (k === 'anyOf' && Array.isArray(v)) v.forEach(visit);
      else if (k === 'items') visit(v);
    }
  };
  visit(schema);
  return out;
}

const goodExtract = () => ({
  schema_version: '2.0-lab.1',
  appointments: [
    { ref: null, title: '스터디', date: '2026-10-09', time: '14:00', place: '도서관', importance: null, transport: null, repeat: null, save: 'UNCONFIRMED', unclear: null },
  ],
  todos: [{ title: '노트북 충전기', type: 'ITEM', due_date: '2026-10-09', appointment_ref: null }],
  importance_updates: [],
  alarm_changes: [],
  fact_feedback: [],
  reason_tags: [],
  prep_adjustment: null,
  daily_record: { sleep_time: null, sleep_satisfaction: null, condition_note: null },
  safety_flag: false,
});

describe('스키마 7개 — 실험실과 같은 내용인지 지문으로 대조', () => {
  // 실험실 장부(runs/ledger.jsonl)의 schema_id "id#지문"과 같은 값 (JSON.stringify의 FNV-1a 앞 6자리, 키 순서 포함)
  const SHA: Record<SchemaId, string> = {
    't1-reply.v1': '90471a',
    'extract.v1': '2e9832',
    'extract-fast.v1': 'dc9043',
    't4-diary.v1': 'ba0576',
    't5-journal.v1': 'af6752',
    'assist-e4.v1': '718628',
    't3-reason.v1': '72294f',
    'extract-fast.v2': '23cc5e', // 서버 판 (extract-fast.v1 + 준비물 items, T2F.v2-d)
    'extract-fast.v3': 'c6f404', // 서버 판 (extract-fast.v2 + 나가기 전 할 일 pre_tasks · 기상 답 wake_reply, T2F.v2-e)
    'extract.v2': 'ca990a', // 서버 판 (실험실 장부에 없음 — extract.v1 + 대화 끝 정리 칸)
  };

  it('지문이 같고, $id가 id와 같음', () => {
    assert.deepEqual(Object.keys(SCHEMAS).sort(), Object.keys(SHA).sort());
    for (const [id, sha] of Object.entries(SHA)) {
      const s = schemaOf(id);
      assert.equal(schemaSha(s), sha, id);
      assert.equal(s.$id, id);
    }
  });

  it('API 변형이 상한 안이고 지원 안 되는 키워드가 없음 — extract만 sentinel', () => {
    for (const [id, s] of Object.entries(SCHEMAS)) {
      const info = apiSchemaInfo(s);
      assert.deepEqual(apiLimitProblems(info.schema), [], id);
      assert.deepEqual(findUnsupported(info.schema), [], id);
      assert.equal(info.mode, id.startsWith('extract.v') ? 'sentinel' : 'union', id);
    }
  });

  it('모두 검증기가 지원하는 키워드만 씀 (모르는 키워드면 던짐)', () => {
    // 비어 있는 입력이라도 컴파일은 되어야 함 — 던지면 지원 밖 키워드가 있다는 뜻
    for (const [id, s] of Object.entries(SCHEMAS)) assert.doesNotThrow(() => validate(s, {}), id);
  });

  it('돌려주는 객체는 얼어 있음', () => {
    assert.throws(() => {
      (schemaOf('t4-diary.v1') as { type: string }).type = 'string';
    });
    assert.throws(() => schemaOf('nope.v9'), /스키마 없음/);
    assert.throws(() => schemaOf('toString'), /스키마 없음/);
  });
});

describe('toApiSchema', () => {
  it('extract.v1: pattern · minimum · maximum · maxLength · $id 없음, 원본은 그대로', () => {
    const removed: string[] = [];
    const api = toApiSchema(extract, { removed });
    const keys = keywordKeys(api);
    for (const k of ['pattern', 'minimum', 'maximum', 'maxLength', '$id']) assert.ok(!keys.has(k), `${k} 남음`);
    assert.deepEqual(findUnsupported(api), []);
    assert.ok(removed.some((p) => p.endsWith('/time/anyOf/0/pattern')));
    // 원본(기준) 스키마는 안 바뀜
    assert.ok(keywordKeys(extract).has('pattern'));
    // 뺀 제약은 description 힌트로 (union 상한 때문에 time은 선택 칸 string으로 바뀜)
    // deno-lint-ignore no-explicit-any
    const a = api as any;
    const tm = a.properties.appointments.items.properties.time;
    assert.equal(tm.type, 'string');
    assert.match(tm.description, /pattern/);
    // 타입 없는 enum에 type 채움, 속성 이름 "type"(todos)은 그대로
    assert.equal(a.properties.todos.items.properties.type.type, 'string');
    assert.deepEqual(a.properties.todos.items.properties.type.enum, ['TASK', 'ITEM']);
    for (const id of ['t1-reply.v1', 't3-reason.v1', 't4-diary.v1', 't5-journal.v1']) {
      assert.deepEqual(findUnsupported(toApiSchema(schemaOf(id))), [], id);
    }
  });

  it('어려운 경우: 키워드와 같은 이름의 속성, format 거르기, oneOf, minItems, 불리언 스키마', () => {
    const s: JsonSchema = {
      $id: 'x.v1',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'X',
      type: 'object',
      properties: {
        pattern: { type: 'string', pattern: '^a$' }, // 속성 이름이 pattern
        title: { type: 'string', minLength: 1, description: '제목' },
        minimum: { type: 'integer', minimum: 0, multipleOf: 5 },
        email: { type: 'string', format: 'email' },
        re: { type: 'string', format: 'regex' },
        n32: { type: 'string', format: 'int32' },
        choice: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        list1: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, uniqueItems: true },
        list3: { type: 'array', items: { type: 'string' }, minItems: 3 },
        tuple: { type: 'array', items: [{ type: 'string' }] },
        nested: { type: 'object', properties: { a: { const: 3 } }, required: ['a'], additionalProperties: true },
        anything: true,
        cond: { type: 'string', not: { const: 'x' } },
      },
      required: ['pattern'],
      additionalProperties: false,
    };
    const removed: string[] = [];
    // deno-lint-ignore no-explicit-any
    const api = toApiSchema(s, { removed }) as any;
    assert.equal(api.$id, undefined);
    assert.equal(api.$schema, undefined);
    assert.equal(api.title, 'X');
    assert.deepEqual(Object.keys(api.properties), Object.keys(s.properties as object)); // 이름 · 순서 유지
    assert.equal(api.properties.pattern.type, 'string');
    assert.equal(api.properties.pattern.pattern, undefined);
    assert.equal(api.properties.title.description, '제목\n\n{minLength: 1}');
    assert.equal(api.properties.minimum.minimum, undefined);
    assert.match(api.properties.minimum.description, /multipleOf: 5/);
    assert.equal(api.properties.email.format, 'email');
    assert.equal(api.properties.re.format, undefined);
    assert.equal(api.properties.n32.format, undefined);
    assert.ok(Array.isArray(api.properties.choice.anyOf));
    assert.equal(api.properties.choice.oneOf, undefined);
    assert.equal(api.properties.list1.minItems, 1);
    assert.equal(api.properties.list1.maxItems, undefined);
    assert.equal(api.properties.list1.uniqueItems, undefined);
    assert.equal(api.properties.list3.minItems, undefined);
    assert.equal(api.properties.tuple.items, undefined);
    assert.equal(api.properties.nested.additionalProperties, false);
    assert.equal(api.properties.nested.properties.a.type, 'integer');
    assert.deepEqual(api.properties.anything, {});
    assert.equal(api.properties.cond.not, undefined);
    assert.equal(api.required[0], 'pattern');
    assert.deepEqual(findUnsupported(api), []);
    assert.ok(removed.includes('/properties/choice/oneOf(→anyOf)'));
    assert.ok(removed.includes('/properties/nested/additionalProperties(→false)'));
    // 힌트 끄기
    // deno-lint-ignore no-explicit-any
    const bare = toApiSchema(s, { hints: false }) as any;
    assert.equal(bare.properties.pattern.description, undefined);
    assert.equal(bare.properties.title.description, '제목');
    // 원본 안 바뀜
    // deno-lint-ignore no-explicit-any
    assert.equal((s.properties as any).pattern.pattern, '^a$');
  });

  it('union 상한(16): extract.v1(21개)은 auto면 대신 값(sentinel) — 칸은 모두 required, 불리언 · 객체만 union', () => {
    const asUnion = toApiSchema(extract, { nullable: 'union' });
    assert.deepEqual(apiSchemaStats(asUnion).unions, 21); // 실측 400 메시지의 21과 같음
    assert.equal(apiLimitProblems(asUnion).length, 1);
    const info = toApiSchemaInfo(extract);
    assert.equal(info.mode, 'sentinel');
    assert.equal(apiSchemaInfo(extract).mode, 'sentinel');
    // deno-lint-ignore no-explicit-any
    const auto = info.schema as any;
    assert.equal(info.stats.unions, 2); // alarm_changes.enabled(불리언) · prep_adjustment(객체)
    assert.equal(info.stats.optional, 0);
    assert.deepEqual(apiLimitProblems(auto), []);
    const appt = auto.properties.appointments.items;
    assert.deepEqual(appt.required, ['ref', 'title', 'date', 'time', 'place', 'importance', 'transport', 'repeat', 'save', 'unclear']);
    assert.deepEqual(appt.properties.importance.enum, ['LOW', 'NORMAL', 'HIGH', 'NULL']);
    assert.equal(appt.properties.importance.type, 'string');
    assert.match(appt.properties.importance.description, /"NULL" = null/);
    assert.equal(appt.properties.time.type, 'string');
    assert.match(appt.properties.time.description, /pattern[\s\S]*빈 문자열 "" = null/);
    assert.deepEqual(appt.properties.save.enum, ['CONFIRMED', 'DECLINED', 'UNCONFIRMED']); // null 안 되는 enum은 그대로
    const dr = auto.properties.daily_record.properties;
    assert.equal(dr.sleep_satisfaction.type, 'integer');
    assert.match(dr.sleep_satisfaction.description, /minimum: 1[\s\S]*0 = null/);
    assert.ok(Array.isArray(auto.properties.prep_adjustment.anyOf));
    assert.equal(auto.properties.prep_adjustment.anyOf[0].properties.minutes.type, 'integer'); // 객체 안 정수는 0
    assert.ok(Array.isArray(auto.properties.alarm_changes.items.properties.enabled.anyOf));
    assert.ok(info.removed.includes('/properties/appointments/items/properties/importance(null→"NULL")'));
    // union이 적으면 auto도 그대로
    const t5 = toApiSchemaInfo(schemaOf('t5-journal.v1'));
    assert.equal(t5.mode, 'union');
    // deno-lint-ignore no-explicit-any
    assert.ok(Array.isArray((t5.schema as any).properties.mood.anyOf));
    // optional 방식(비교용): 21칸이 선택 칸
    const opt = toApiSchemaInfo(extract, { nullable: 'optional' });
    assert.equal(opt.stats.unions, 0);
    assert.equal(opt.stats.optional, 21);
    // deno-lint-ignore no-explicit-any
    assert.deepEqual((opt.schema as any).properties.appointments.items.required, ['title', 'save']);
    // type 배열 꼴 nullable도 변환 · enum에 이미 "NULL"이 있으면 "__NULL__"
    // deno-lint-ignore no-explicit-any
    const arr = toApiSchema({ type: 'object', properties: { a: { type: ['string', 'null'], description: '가' } }, required: ['a'] }, { nullable: 'optional' }) as any;
    assert.deepEqual(arr.properties.a, { type: 'string', description: '가' });
    assert.deepEqual(arr.required, []);
    // deno-lint-ignore no-explicit-any
    const nn = toApiSchema({ type: 'object', properties: { e: { anyOf: [{ enum: ['NULL', 'X'] }, { type: 'null' }] } }, required: ['e'] }, { nullable: 'sentinel' }) as any;
    assert.deepEqual(nn.properties.e.enum, ['NULL', 'X', '__NULL__']);
  });

  it('sentinel: format이 붙은 null 허용 문자열은 format을 힌트로 옮김 (format이 남으면 ""를 못 내서 날짜를 지어냄)', () => {
    const s: JsonSchema = {
      type: 'object',
      properties: {
        d: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
        at: { anyOf: [{ type: 'string', format: 'date-time', description: '출발 시각' }, { type: 'null' }] },
        mail: { type: 'string', format: 'email' }, // null 안 되는 칸은 format 그대로
      },
      required: ['d', 'at', 'mail'],
      additionalProperties: false,
    };
    const removed: string[] = [];
    // deno-lint-ignore no-explicit-any
    const api = toApiSchema(s, { nullable: 'sentinel', removed }) as any;
    assert.equal(api.properties.d.type, 'string');
    assert.equal(api.properties.d.format, undefined);
    assert.match(api.properties.d.description, /format: "date"/);
    assert.match(api.properties.d.description, /빈 문자열 "" = null/);
    assert.equal(api.properties.at.format, undefined);
    assert.match(api.properties.at.description, /^출발 시각/);
    assert.equal(api.properties.mail.format, 'email');
    assert.ok(removed.some((p) => p.startsWith('/properties/d') && p.includes('format')), removed.join('\n'));
    assert.deepEqual(findUnsupported(api), []);
    const dec = decodeSentinels(s, { d: '', at: '2026-10-09T07:40:00+09:00', mail: 'a@b.kr' });
    assert.deepEqual(dec, { d: null, at: '2026-10-09T07:40:00+09:00', mail: 'a@b.kr' });
    // union 방식은 format 그대로
    // deno-lint-ignore no-explicit-any
    assert.equal((toApiSchema(s, { nullable: 'union' }) as any).properties.d.anyOf[0].format, 'date');
    // 힌트를 끄면 format도 description에 안 붙음 (대신 값 설명만)
    // deno-lint-ignore no-explicit-any
    const bare = toApiSchema(s, { nullable: 'sentinel', hints: false }) as any;
    assert.equal(bare.properties.d.format, undefined);
    assert.doesNotMatch(bare.properties.d.description, /format/);
  });

  it('type 배열 꼴 null 허용 enum: API enum에 null이 남지 않음 (type string과 모순 → 400 위험)', () => {
    const s: JsonSchema = { type: 'object', properties: { e: { type: ['string', 'null'], enum: ['A', 'B', null] } }, required: ['e'], additionalProperties: false };
    // deno-lint-ignore no-explicit-any
    const sen = toApiSchema(s, { nullable: 'sentinel' }) as any;
    assert.equal(sen.properties.e.type, 'string');
    assert.deepEqual(sen.properties.e.enum, ['A', 'B', 'NULL']);
    // deno-lint-ignore no-explicit-any
    const opt = toApiSchema(s, { nullable: 'optional' }) as any;
    assert.deepEqual(opt.properties.e.enum, ['A', 'B']);
    assert.deepEqual(decodeSentinels(s, { e: 'NULL' }), { e: null });
    assert.deepEqual(decodeSentinels(s, { e: 'A' }), { e: 'A' });
    assert.equal(validate(s, { e: null }).valid, true);
  });
});

describe('decodeSentinels · restoreNulls · fromApiOutput', () => {
  it('null 허용 칸의 대신 값만 null로, 진짜 값 · null 안 되는 칸은 그대로', () => {
    const enc = {
      schema_version: '2.0-lab.0',
      appointments: [{ ref: '', title: '', date: '2026-10-10', time: '09:00', place: 'null', importance: 'NULL', transport: 'NULL', repeat: 'NONE', save: 'UNCONFIRMED', unclear: '' }],
      todos: [{ title: '충전기', type: 'ITEM', due_date: '', appointment_ref: '' }],
      importance_updates: [],
      alarm_changes: [{ target: 'u0', appointment_ref: '', type: 'WAKE', date: '2026-10-10', time: '07:30', intensity: 'NULL', enabled: null, save: 'UNCONFIRMED' }],
      fact_feedback: [],
      reason_tags: [],
      prep_adjustment: { direction: 'MORE', minutes: 0 },
      daily_record: { sleep_time: '', sleep_satisfaction: 0, condition_note: '' },
      safety_flag: false,
    };
    const changed: string[] = [];
    // deno-lint-ignore no-explicit-any
    const dec = decodeSentinels(extract, enc, changed) as any;
    const a = dec.appointments[0];
    assert.equal(a.ref, null);
    assert.equal(a.title, ''); // title은 null 불가 → 그대로 (빈 제목은 따로 볼 몫)
    assert.equal(a.place, null); // "null" 글자도 null
    assert.equal(a.importance, null);
    assert.equal(a.repeat, 'NONE'); // 진짜 값
    assert.equal(dec.todos[0].type, 'ITEM');
    assert.equal(dec.todos[0].due_date, null);
    assert.equal(dec.alarm_changes[0].intensity, null);
    assert.equal(dec.alarm_changes[0].enabled, null);
    assert.deepEqual(dec.prep_adjustment, { direction: 'MORE', minutes: null });
    assert.deepEqual(dec.daily_record, { sleep_time: null, sleep_satisfaction: null, condition_note: null });
    assert.deepEqual(validate(extract, dec), { valid: true, errors: [] });
    assert.ok(changed.includes('/appointments/0/place') && changed.includes('/prep_adjustment/minutes'));
    // 안 되돌리면 기준 스키마에서 걸림
    assert.equal(validate(extract, enc).valid, false);
    // fromApiOutput은 고른 방식에 맞춰: union 스키마(t1-reply)는 손대지 않음
    const t1 = { reply: '네', acts: [{ type: 'REFLECT', ref: '' }], end: false };
    assert.deepEqual(fromApiOutput(schemaOf('t1-reply.v1'), t1), t1);
    // deno-lint-ignore no-explicit-any
    assert.equal((fromApiOutput(extract, enc) as any).appointments[0].ref, null);
  });

  it('$defs/$ref 안의 칸도 되돌림 (인코딩은 $defs까지 하는데 디코딩이 $ref를 안 따라가면 "" · 0이 남음)', () => {
    const s: JsonSchema = {
      type: 'object',
      $defs: {
        Appt: {
          type: 'object',
          properties: { place: { anyOf: [{ type: 'string' }, { type: 'null' }] }, n: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] } },
          required: ['place', 'n'],
          additionalProperties: false,
        },
      },
      properties: {
        a: { $ref: '#/$defs/Appt' },
        list: { type: 'array', items: { $ref: '#/$defs/Appt' } },
        maybe: { anyOf: [{ $ref: '#/$defs/Appt' }, { type: 'null' }] },
      },
      required: ['a', 'list', 'maybe'],
      additionalProperties: false,
    };
    // deno-lint-ignore no-explicit-any
    const api = toApiSchema(s, { nullable: 'sentinel' }) as any;
    assert.equal(api.$defs.Appt.properties.place.type, 'string'); // 인코딩은 $defs 안까지 됨
    const changed: string[] = [];
    const dec = decodeSentinels(s, { a: { place: '', n: 0 }, list: [{ place: '학교 도서관', n: 0 }], maybe: { place: '', n: 3 } }, changed);
    assert.deepEqual(dec, { a: { place: null, n: null }, list: [{ place: '학교 도서관', n: null }], maybe: { place: null, n: 3 } });
    assert.deepEqual(changed, ['/a/place', '/a/n', '/list/0/n', '/maybe/place']);
    // optional 방식도 $ref 안의 빠진 칸을 채움
    // deno-lint-ignore no-explicit-any
    const opt = toApiSchema(s, { nullable: 'optional' }) as any;
    assert.deepEqual(opt.$defs.Appt.required, []);
    const filled = restoreNulls(s, { a: {}, list: [{ place: 'x' }], maybe: null });
    assert.deepEqual(filled, { a: { place: null, n: null }, list: [{ place: 'x', n: null }], maybe: null });
    // 순환 $ref여도 멈춤
    const loop: JsonSchema = { $defs: { A: { $ref: '#/$defs/B' }, B: { $ref: '#/$defs/A' } }, type: 'object', properties: { x: { $ref: '#/$defs/A' } } };
    assert.deepEqual(decodeSentinels(loop, { x: { y: '' } }), { x: { y: '' } });
  });

  it('restoreNulls: 빠진 null 허용 칸만 null로 채우고 기준 순서로, 나머지 문제는 validate가 잡게 둠', () => {
    const sparse = {
      schema_version: '2.0-lab.0',
      appointments: [{ title: '시험', date: '2026-10-10', time: '09:00', save: 'UNCONFIRMED' }],
      todos: [],
      importance_updates: [],
      alarm_changes: [{ target: 'u0', type: 'WAKE', time: '07:30', save: 'UNCONFIRMED' }],
      fact_feedback: [],
      reason_tags: [],
      daily_record: {},
      safety_flag: false,
    };
    const filled: string[] = [];
    // deno-lint-ignore no-explicit-any
    const full = restoreNulls(extract, sparse, filled) as any;
    assert.deepEqual(validate(extract, full), { valid: true, errors: [] });
    assert.equal(full.prep_adjustment, null);
    assert.equal(full.appointments[0].place, null);
    assert.equal(full.alarm_changes[0].date, null);
    assert.equal(full.daily_record.sleep_time, null);
    assert.ok(filled.includes('/appointments/0/ref'));
    assert.ok(filled.includes('/prep_adjustment'));
    assert.deepEqual(Object.keys(full.appointments[0]), ['ref', 'title', 'date', 'time', 'place', 'importance', 'transport', 'repeat', 'save', 'unclear']);
    // null 안 되는 칸(title · safety_flag)은 안 채움 → validate가 잡음
    const noTitle = restoreNulls(extract, { ...sparse, safety_flag: undefined, appointments: [{ save: 'UNCONFIRMED' }] });
    const r = validate(extract, JSON.parse(JSON.stringify(noTitle)));
    assert.ok(r.errors.includes("/appointments/0: must have required property 'title'"));
    assert.ok(r.errors.includes("(root): must have required property 'safety_flag'"));
    // prep_adjustment 객체 안의 빠진 minutes도 채움 (anyOf 객체 쪽을 골라 들어감)
    // deno-lint-ignore no-explicit-any
    const pa = restoreNulls(extract, { ...sparse, prep_adjustment: { direction: 'MORE' } }) as any;
    assert.deepEqual(pa.prep_adjustment, { direction: 'MORE', minutes: null });
    // 모르는 칸 · __proto__ 는 그대로 남아 validate가 잡고, 프로토타입 오염 없음
    const evil = JSON.parse('{"schema_version":"x","__proto__":{"polluted":1},"extra":1}');
    // deno-lint-ignore no-explicit-any
    const out = restoreNulls(extract, evil) as any;
    // deno-lint-ignore no-explicit-any
    assert.equal(({} as any).polluted, undefined);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.ok(Object.keys(out).includes('__proto__'));
    assert.ok(validate(extract, out).errors.some((e) => e.includes("'extra'")));
  });

  it("대신 값 읽기: 공백뿐 · 'NULL' · ' Null ' 도 null, null 안 되는 칸 · 진짜 글은 그대로", () => {
    const enc = {
      schema_version: '2.0-lab.0',
      appointments: [{ ref: ' ', title: 'NULL', date: '2026-10-10', time: '  ', place: 'NULL', importance: 'NULL', transport: 'NULL', repeat: 'NULL', save: 'UNCONFIRMED', unclear: ' Null ' }],
      todos: [{ title: '', type: 'TASK', due_date: 'null', appointment_ref: 'a1' }],
      importance_updates: [], alarm_changes: [], fact_feedback: [], reason_tags: [], prep_adjustment: null,
      daily_record: { sleep_time: '\t', sleep_satisfaction: 0, condition_note: 'null이라고 썼지만 진짜 메모' },
      safety_flag: false,
    };
    // deno-lint-ignore no-explicit-any
    const dec = decodeSentinels(extract, enc) as any;
    const a = dec.appointments[0];
    assert.equal(a.ref, null);
    assert.equal(a.title, 'NULL'); // null 안 되는 칸은 그대로
    assert.equal(a.time, null);
    assert.equal(a.place, null);
    assert.equal(a.unclear, null);
    assert.equal(dec.todos[0].title, '');
    assert.equal(dec.todos[0].due_date, null);
    assert.equal(dec.todos[0].appointment_ref, 'a1');
    assert.equal(dec.daily_record.sleep_time, null);
    assert.equal(dec.daily_record.condition_note, 'null이라고 썼지만 진짜 메모');
    assert.deepEqual(validate(extract, dec), { valid: true, errors: [] });
  });

  it("대신 값 읽기: 설명 문구를 그대로 베낀 '해당 없음' · '말하지 않음' · '없음'도 null (문장 속 '없음'은 그대로)", () => {
    // sentinel 설명이 '빈 문자열 "" = null (해당 없음 · 말하지 않음)'이라 모델이 그 말을 값으로 쓸 수 있음
    const enc = {
      schema_version: '2.0-lab.0',
      appointments: [{ ref: '없음', title: '없음', date: '2026-10-10', time: '09:00', place: '해당 없음', importance: 'NULL', transport: 'NULL', repeat: 'NULL', save: 'UNCONFIRMED', unclear: '말하지 않음' }],
      todos: [], importance_updates: [], alarm_changes: [], fact_feedback: [], reason_tags: [], prep_adjustment: null,
      daily_record: { sleep_time: '해당없음', sleep_satisfaction: 0, condition_note: '특별한 일 없음' },
      safety_flag: false,
    };
    const changed: string[] = [];
    // deno-lint-ignore no-explicit-any
    const dec = decodeSentinels(extract, enc, changed) as any;
    const a = dec.appointments[0];
    assert.equal(a.ref, null);
    assert.equal(a.title, '없음'); // null 안 되는 칸
    assert.equal(a.place, null);
    assert.equal(a.unclear, null);
    assert.equal(dec.daily_record.sleep_time, null);
    assert.equal(dec.daily_record.condition_note, '특별한 일 없음');
    assert.ok(changed.includes('/appointments/0/place') && changed.includes('/daily_record/sleep_time'));
    assert.deepEqual(validate(extract, dec), { valid: true, errors: [] });
  });
});

describe('validate — ajv와 같은 오류 문구', () => {
  it("정상 통과, '7:40' · 빠진 칸 · 남는 칸 · 범위 · 길이 · enum을 잡음", () => {
    assert.deepEqual(validate(extract, goodExtract()), { valid: true, errors: [] });

    const badTime = goodExtract();
    badTime.appointments[0].time = '7:40';
    const r1 = validate(extract, badTime);
    assert.equal(r1.valid, false);
    // anyOf 칸이라 갈래마다의 오류가 먼저, 끝에 anyOf 오류
    assert.deepEqual(r1.errors.filter((e) => e.startsWith('/appointments/0/time')), [
      '/appointments/0/time: must match pattern "^([01]\\d|2[0-3]):[0-5]\\d$"',
      '/appointments/0/time: must be null',
      '/appointments/0/time: must match a schema in anyOf',
    ]);

    // deno-lint-ignore no-explicit-any
    const missing = goodExtract() as any;
    delete missing.appointments[0].place;
    delete missing.safety_flag;
    const r2 = validate(extract, missing);
    assert.ok(r2.errors.includes("/appointments/0: must have required property 'place'"), r2.errors.join('\n'));
    assert.ok(r2.errors.includes("(root): must have required property 'safety_flag'"));

    // deno-lint-ignore no-explicit-any
    const extra = goodExtract() as any;
    extra.appointments[0].start_at = '2026-10-09T14:00';
    assert.deepEqual(validate(extract, extra).errors, ["/appointments/0: must NOT have additional properties 'start_at'"]);

    // deno-lint-ignore no-explicit-any
    const range = goodExtract() as any;
    range.daily_record.sleep_satisfaction = 6;
    range.daily_record.condition_note = '가'.repeat(201);
    range.prep_adjustment = { direction: 'MORE', minutes: 0 };
    const r3 = validate(extract, range);
    assert.ok(r3.errors.includes('/daily_record/sleep_satisfaction: must be <= 5'), r3.errors.join('\n'));
    assert.ok(r3.errors.includes('/daily_record/condition_note: must NOT have more than 200 characters'));
    assert.ok(r3.errors.includes('/prep_adjustment/minutes: must be >= 1'), r3.errors.join('\n'));

    // deno-lint-ignore no-explicit-any
    const badEnum = goodExtract() as any;
    badEnum.todos[0].type = 'THING';
    assert.deepEqual(validate(extract, badEnum).errors, ['/todos/0/type: must be equal to one of the allowed values ("TASK"|"ITEM")']);

    // deno-lint-ignore no-explicit-any
    const date = goodExtract() as any;
    date.appointments[0].date = '10/9';
    assert.equal(validate(extract, date).valid, false);
  });

  it('type: 정수 · 불리언 · 객체 · 배열 · null 어긋남', () => {
    const t1 = schemaOf('t1-reply.v1');
    assert.deepEqual(validate(t1, { reply: 3, acts: {}, end: 'no' }).errors, [
      '/reply: must be string',
      '/acts: must be array',
      '/end: must be boolean',
    ]);
    assert.deepEqual(validate(t1, null).errors, ['(root): must be object']);
    assert.deepEqual(validate(t1, []).errors, ['(root): must be object']);
    const e4 = schemaOf('assist-e4.v1');
    // deno-lint-ignore no-explicit-any
    const r = validate(e4, { morning_minutes: 5.5, wake_offset: 31, travel_extra: 0, patterns: [], message: 'x' }) as any;
    assert.ok(r.errors.some((e: string) => e.startsWith('/morning_minutes: must be integer')), r.errors.join('\n'));
    assert.ok(r.errors.some((e: string) => e.startsWith('/wake_offset: must be <= ')), r.errors.join('\n'));
  });

  it('assist-e4: 범위 · 패턴 종류 · 빠진 message (실험실 e4 시험)', () => {
    const e4 = schemaOf('assist-e4.v1');
    const good = { morning_minutes: 60, wake_offset: 10, travel_extra: 0, patterns: [], message: '평소대로예요' };
    assert.equal(validate(e4, good).valid, true);
    assert.equal(validate(e4, { ...good, wake_offset: 31 }).valid, false);
    assert.equal(validate(e4, { ...good, morning_minutes: 5 }).valid, false);
    const { message: _m, ...noMsg } = good;
    assert.deepEqual(validate(e4, noMsg).errors, ["(root): must have required property 'message'"]);
    assert.equal(
      validate(e4, { ...good, patterns: [{ kind: 'NOPE', weekday: null, tag: null, effect_minutes: 3, evidence_ids: ['r1'] }] }).valid,
      false,
    );
  });

  it('검증 경계: 00:00 · 03:59 · 04:00 · 23:59는 통과, 24:00 · 7:40 · 전각 숫자 · 줄바꿈 · 초 · 오전은 실패', () => {
    const withTime = (t: string) => {
      // deno-lint-ignore no-explicit-any
      const x = goodExtract() as any;
      x.appointments[0].time = t;
      x.daily_record.sleep_time = t;
      x.alarm_changes = [{ target: 'u0', appointment_ref: null, type: 'WAKE', date: '2026-10-10', time: t, intensity: null, enabled: null, save: 'UNCONFIRMED' }];
      return x;
    };
    for (const t of ['00:00', '03:59', '04:00', '23:59']) assert.equal(validate(extract, withTime(t)).valid, true, t);
    for (const t of ['24:00', '7:40', '07:60', '０７:４０', '07:40\n', ' 07:40', '07:40:00', '오전 7:40', '7시 40분']) {
      const r = validate(extract, withTime(t));
      assert.equal(r.valid, false, JSON.stringify(t));
      assert.ok(r.errors.some((e) => e.startsWith('/appointments/0/time')), JSON.stringify(t));
    }
    for (const d of ['2026-10-9', '26-10-09', '２０２６-10-09', '10/9', '내일']) {
      // deno-lint-ignore no-explicit-any
      const x = goodExtract() as any;
      x.appointments[0].date = d;
      assert.equal(validate(extract, x).valid, false, d);
    }
  });

  it('글자 수는 유니코드 글자 기준 (이모지 하나 = 1)', () => {
    const s: JsonSchema = { type: 'object', properties: { a: { type: 'string', maxLength: 3 } }, required: ['a'] };
    assert.equal(validate(s, { a: '😀😀😀' }).valid, true);
    assert.equal(validate(s, { a: '😀😀😀😀' }).valid, false);
  });

  it('경로: JSON 포인터 이스케이프, __proto__ 같은 이름도 칸으로 취급', () => {
    const s: JsonSchema = { type: 'object', properties: { 'a/b': { type: 'string' }, 'c~d': { type: 'string' } }, additionalProperties: false };
    assert.deepEqual(validate(s, { 'a/b': 1, 'c~d': 2 }).errors, ['/a~1b: must be string', '/c~0d: must be string']);
    const evil = JSON.parse('{"__proto__":1}');
    assert.deepEqual(validate(s, evil).errors, ["(root): must NOT have additional properties '__proto__'"]);
  });

  it('지원 밖 키워드 · 틀린 모양은 처음 쓸 때 던짐 (조용히 통과시키지 않음)', () => {
    assert.throws(() => validate({ type: 'string', minLength: 1 }, 'x'), /지원 안 하는 키워드 'minLength'/);
    assert.throws(() => validate({ type: 'object', properties: { a: { format: 'date' } } }, {}), /지원 안 하는 키워드 'format'/);
    assert.throws(() => validate({ type: 'array', items: [{ type: 'string' }] }, []), /객체여야/);
    assert.throws(() => validate({ type: 'object', additionalProperties: { type: 'string' } }, {}), /additionalProperties/);
    assert.throws(() => validate({ type: 'strng' }, 'x'), /type이 틀림/);
    assert.throws(() => validate({ type: 'string', pattern: '(' }, 'x'));
    // 설명용 키워드는 통과
    assert.equal(validate({ $id: 'x.v1', $schema: 'x', title: 'T', description: 'd', type: 'string' }, 'x').valid, true);
  });

  it('type 배열 · enum의 null', () => {
    const s: JsonSchema = { type: 'object', properties: { e: { type: ['string', 'null'], enum: ['A', 'B', null] } }, required: ['e'] };
    assert.equal(validate(s, { e: null }).valid, true);
    assert.equal(validate(s, { e: 'A' }).valid, true);
    assert.deepEqual(validate(s, { e: 3 }).errors, [
      '/e: must be string,null',
      '/e: must be equal to one of the allowed values ("A"|"B"|null)',
    ]);
  });
});

describe('fnv1aHex · schemaSha · deepFreeze', () => {
  it('FNV-1a 알려진 값', () => {
    assert.equal(fnv1aHex(''), '811c9dc5');
    assert.equal(fnv1aHex('a'), 'e40c292c');
    assert.equal(fnv1aHex('foobar'), 'bf9cf968');
  });

  it('schemaSha: 6자리 · 안정 · 키 순서를 반영하고 공백은 무시', () => {
    assert.match(schemaSha(extract), /^[0-9a-f]{6}$/);
    assert.equal(schemaSha(extract), schemaSha(extract));
    assert.notEqual(schemaSha(extract), schemaSha(schemaOf('t1-reply.v1')));
    assert.notEqual(schemaSha({ a: 1, b: 2 }), schemaSha({ b: 2, a: 1 }));
  });

  it('deepFreeze: 안쪽까지 얼림, 이미 언 것은 그대로', () => {
    const o = deepFreeze({ a: { b: [1, { c: 2 }] } });
    assert.ok(Object.isFrozen(o.a.b[1]));
    assert.throws(() => {
      (o.a as { b: unknown }).b = 1;
    });
    assert.equal(deepFreeze(o), o);
  });
});
