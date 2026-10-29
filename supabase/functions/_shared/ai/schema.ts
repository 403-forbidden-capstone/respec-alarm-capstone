// 기준 JSON Schema 다루기 — 실험실(ai-lab) src/lib/schema.ts에서 옮김. 순수 TS (Node · Deno API 없음, 외부 패키지 없음)
// 기준(정규) 스키마는 schemas/<id>.ts 하나뿐(실험실 schemas/<id>.json과 같은 내용, 지문으로 대조). API에 보낼 변형은 toApiSchema가 만든다.
// 모델이 낸 출력은 믿지 않는 입력이라, 검증은 언제나 기준 스키마 전체로 한다 — API가 못 거는 pattern · minimum 등도 여기서 잡힘.
// 실험실은 ajv로 검증했지만 서버 함수에서는 패키지를 늘리지 않으려고 같은 오류 문구를 내는 검증기를 직접 둠(아래 "검증").
// 스키마가 쓰는 키워드 밖의 것은 조용히 넘기지 않고 던짐(ajv strict와 같은 이유: 오타 · 빠뜨린 검사를 크게 터뜨리려고).

export type JsonSchema = { [key: string]: unknown };

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// API용 변형
// ---------------------------------------------------------------------------

// Claude 구조화 출력이 받는 문자열 format (SDK transform-json-schema와 같은 목록)
export const API_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

// 그대로 두는 키워드. 나머지(pattern · minimum · maxLength · not · if …)는 빼고 description 힌트로 옮김
const KEEP = new Set([
  'type', 'enum', 'const', 'description', 'title', 'properties', 'required', 'additionalProperties',
  'items', 'anyOf', 'allOf', 'oneOf', '$ref', '$defs', 'definitions', 'format', 'minItems',
]);
// 힌트 없이 그냥 버리는 메타 키워드
const DROP_SILENT = new Set(['$id', '$schema', '$comment']);

// API 복잡도 상한 (실험실 2026-10-09 smoke 실측: extract.v1 → 400 "too many parameters with union types (21 …) limit: 16").
// union = anyOf 또는 type 배열을 가진 칸. 선택(optional) 칸 상한 24는 문서 기억값(21개는 통과 실측).
export const API_UNION_LIMIT = 16;
export const API_OPTIONAL_LIMIT = 24;

// null 허용 칸을 API에 어떻게 보낼지 (기준 스키마 · 검증은 그대로, 응답은 fromApiOutput이 기준 모양으로 되돌림).
//   union    — 그대로 anyOf [X, null]
//   sentinel — 칸은 required로 두고 null 대신 고를 값을 줌: 문자열 "" · 문자열 enum에 "NULL" 추가 · 최솟값 ≥ 1인 정수 0.
//              불리언 · 객체 등 대신할 값이 없는 칸은 union 유지
//   optional — X로 바꾸고 required에서 뺌, 빠진 칸은 null로 채움.
//              (실험실 10/9 실측: Haiku가 칸을 빼지 않고 "NORMAL" · "WALK" · "" · 0 같은 값을 지어 넣음 → 비교용으로만)
//   auto     — union이 상한(16) 안이면 union, 넘으면 sentinel (기본)
export type NullableMode = 'union' | 'sentinel' | 'optional' | 'auto';
export type AppliedNullableMode = Exclude<NullableMode, 'auto'>;

export interface ApiSchemaOptions {
  // 뺀 제약을 description 끝에 {pattern: "...", maximum: 5} 로 붙임 (기본 true — 모델이 형식을 보게)
  hints?: boolean;
  // 타입 없는 enum · const에 type을 채움 (모두 같은 원시 타입일 때만, 기본 true)
  inferEnumType?: boolean;
  nullable?: NullableMode;
  // 뺀 · 바꾼 것의 경로를 여기 모음 ("/properties/x/pattern")
  removed?: string[];
}

interface WalkOpts {
  hints: boolean;
  inferEnumType: boolean;
  nullable: AppliedNullableMode;
  removed: string[];
}

export interface ApiSchemaStats {
  unions: number; // anyOf · type 배열 칸 수
  optional: number; // required에 없는 속성 수
  objects: number;
  properties: number;
}

export interface ApiSchemaInfo {
  schema: JsonSchema;
  mode: AppliedNullableMode;
  stats: ApiSchemaStats;
  removed: string[];
}

// 기준 스키마 → Claude structured output용 스키마. 원본은 건드리지 않음(깊은 복사).
// 속성 이름은 키워드로 보지 않는다 — properties 안의 "pattern" · "title" · "type" 같은 속성은 그대로.
// oneOf → anyOf, 객체는 additionalProperties: false 강제, minItems는 0 · 1만 남김.
// union 칸이 API 상한을 넘으면 null 허용 칸을 대신 값(sentinel)으로 바꿈 (nullable 옵션).
export function toApiSchema(schema: JsonSchema, opts: ApiSchemaOptions = {}): JsonSchema {
  const info = toApiSchemaInfo(schema, opts);
  if (opts.removed) opts.removed.push(...info.removed);
  return info.schema;
}

// toApiSchema + 어떤 null 방식을 골랐는지 · 복잡도
export function toApiSchemaInfo(schema: JsonSchema, opts: ApiSchemaOptions = {}): ApiSchemaInfo {
  const base = { hints: opts.hints ?? true, inferEnumType: opts.inferEnumType ?? true };
  const want = opts.nullable ?? 'auto';
  const build = (mode: AppliedNullableMode): ApiSchemaInfo => {
    const removed: string[] = [];
    const s = walk(schema, '', { ...base, nullable: mode, removed });
    return { schema: s, mode, stats: apiSchemaStats(s), removed };
  };
  if (want !== 'auto') return build(want);
  const asUnion = build('union');
  return asUnion.stats.unions <= API_UNION_LIMIT ? asUnion : build('sentinel');
}

export interface Sentinel {
  value: string | number;
  note: string;
}

// 기준 스키마의 null 허용 칸 하나에 쓸 대신 값. 인코딩(walk)과 디코딩(decodeSentinels)이 같은 함수를 써서 어긋나지 않게 한다.
// 대신 값이 없는 칸(불리언 · 객체 · 배열 · 최솟값 없는 수)은 null. (시험이 모델 응답을 만들 때도 씀)
export function sentinelFor(raw: unknown): Sentinel | null {
  if (!isPlainObject(raw)) return null;
  const nn = nonNullBranch(raw);
  if (!nn) return null;
  const t = typeof nn.type === 'string' ? nn.type : Array.isArray(nn.enum) ? primitiveTypeOf(nn.enum) : null;
  if (Array.isArray(nn.enum)) {
    if (t !== 'string') return null;
    const v = nn.enum.includes('NULL') ? '__NULL__' : 'NULL';
    return { value: v, note: `"${v}" = null (해당 없음 · 말하지 않음)` };
  }
  if (t === 'string' && nn.const === undefined) return { value: '', note: '빈 문자열 "" = null (해당 없음 · 말하지 않음)' };
  if ((t === 'integer' || t === 'number') && typeof nn.minimum === 'number' && nn.minimum > 0) {
    return { value: 0, note: '0 = null (해당 없음 · 말하지 않음)' };
  }
  return null;
}

// API 복잡도 세기 — 상한 점검용
export function apiSchemaStats(schema: JsonSchema): ApiSchemaStats {
  const st: ApiSchemaStats = { unions: 0, optional: 0, objects: 0, properties: 0 };
  const visit = (n: unknown) => {
    if (!isPlainObject(n)) return;
    if ((Array.isArray(n.anyOf) && n.anyOf.length > 1) || (Array.isArray(n.type) && n.type.length > 1)) st.unions++;
    if (isPlainObject(n.properties)) {
      const names = Object.keys(n.properties);
      const req = Array.isArray(n.required) ? n.required : [];
      st.objects++;
      st.properties += names.length;
      st.optional += names.filter((k) => !req.includes(k)).length;
      for (const s of Object.values(n.properties)) visit(s);
    }
    for (const k of ['anyOf', 'allOf']) if (Array.isArray(n[k])) (n[k] as unknown[]).forEach(visit);
    if (n.items) visit(n.items);
    if (isPlainObject(n.$defs)) Object.values(n.$defs).forEach(visit);
  };
  visit(schema);
  return st;
}

// API 상한 위반 목록 (없으면 빈 배열)
export function apiLimitProblems(schema: JsonSchema): string[] {
  const st = apiSchemaStats(schema);
  const out: string[] = [];
  if (st.unions > API_UNION_LIMIT) out.push(`union 칸 ${st.unions}개 > API 상한 ${API_UNION_LIMIT}`);
  if (st.optional > API_OPTIONAL_LIMIT) out.push(`선택 칸 ${st.optional}개 > API 상한 ${API_OPTIONAL_LIMIT}`);
  return out;
}

const isNullSchema = (s: unknown): boolean =>
  isPlainObject(s) && s.type === 'null' && Object.keys(s).every((k) => k === 'type' || k === 'description');

// anyOf [X, null] 또는 type [T, "null"] 이면 null 아닌 쪽을 돌려줌
function nonNullBranch(s: JsonSchema): JsonSchema | null {
  if (Array.isArray(s.anyOf) && s.anyOf.length === 2) {
    const i = s.anyOf.findIndex(isNullSchema);
    if (i < 0) return null;
    const other = s.anyOf[1 - i];
    if (!isPlainObject(other)) return null;
    const { anyOf: _a, ...outer } = s;
    const merged: JsonSchema = { ...other, ...outer };
    const d = [outer.description, other.description].filter((x) => typeof x === 'string' && x).join('\n\n');
    if (d) merged.description = d;
    return merged;
  }
  if (Array.isArray(s.type) && s.type.length === 2 && s.type.includes('null')) {
    const out: JsonSchema = { ...s, type: s.type.find((t) => t !== 'null') };
    // type [string, null] + enum [..., null] → enum에서도 null을 빼야 type string과 맞음
    if (Array.isArray(out.enum)) out.enum = out.enum.filter((v) => v !== null);
    return out;
  }
  return null;
}

function walk(node: unknown, path: string, o: WalkOpts): JsonSchema {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    // true/false 스키마 등 — API가 못 받으므로 빈 객체로
    o.removed.push(`${path || '/'}(boolean schema)`);
    return {};
  }
  const src = node as JsonSchema;
  const out: JsonSchema = {};
  const hint: Record<string, unknown> = {};
  const isObject = src.type === 'object' || (Array.isArray(src.type) && src.type.includes('object')) || isPlainObject(src.properties);
  const madeOptional: string[] = [];

  for (const [key, value] of Object.entries(src)) {
    const at = `${path}/${key}`;
    if (DROP_SILENT.has(key)) {
      o.removed.push(at);
      continue;
    }
    if (!KEEP.has(key)) {
      hint[key] = value;
      o.removed.push(at);
      continue;
    }
    switch (key) {
      case 'properties': {
        if (!isPlainObject(value)) break;
        const m: JsonSchema = {};
        for (const [name, sub] of Object.entries(value)) {
          let s = walk(sub, `${at}/${name}`, o);
          if (o.nullable === 'optional') {
            const nn = nonNullBranch(s);
            if (nn) {
              s = nn;
              madeOptional.push(name);
              o.removed.push(`${at}/${name}(nullable→optional)`);
            }
          } else if (o.nullable === 'sentinel') {
            const sen = sentinelFor(sub);
            const nn = sen ? nonNullBranch(s) : null;
            if (sen && nn) {
              if (Array.isArray(nn.enum)) nn.enum = [...nn.enum, sen.value];
              const notes = [typeof nn.description === 'string' ? nn.description : ''];
              // "" 대신 값은 format(date · date-time …)과 같이 못 냄 → format이 남으면 모델이 값을 지어냄. 힌트로 옮김
              if (sen.value === '' && typeof nn.format === 'string') {
                if (o.hints) notes.push(`{format: ${JSON.stringify(nn.format)}}`);
                delete nn.format;
                o.removed.push(`${at}/${name}/format(sentinel)`);
              }
              notes.push(sen.note);
              nn.description = notes.filter((x) => x).join('\n\n');
              s = nn;
              o.removed.push(`${at}/${name}(null→${JSON.stringify(sen.value)})`);
            }
          }
          m[name] = s;
        }
        out[key] = m;
        break;
      }
      case '$defs':
      case 'definitions': {
        if (!isPlainObject(value)) break;
        const m: JsonSchema = {};
        for (const [name, sub] of Object.entries(value)) m[name] = walk(sub, `${at}/${name}`, o);
        out[key] = m;
        break;
      }
      case 'items': {
        if (Array.isArray(value)) {
          // 옛 튜플 문법 — API 미지원
          hint[key] = value;
          o.removed.push(at);
        } else out[key] = walk(value, at, o);
        break;
      }
      case 'anyOf':
      case 'allOf':
      case 'oneOf': {
        if (!Array.isArray(value)) break;
        const target = key === 'oneOf' ? 'anyOf' : key;
        if (key === 'oneOf') o.removed.push(`${at}(→anyOf)`);
        out[target] = value.map((sub, i) => walk(sub, `${at}/${i}`, o));
        break;
      }
      case 'additionalProperties': {
        // 객체에서는 false만 허용 — 아래에서 강제
        if (value !== false) o.removed.push(`${at}(→false)`);
        break;
      }
      case 'format': {
        if (typeof value === 'string' && API_FORMATS.has(value)) out.format = value;
        else {
          hint[key] = value;
          o.removed.push(at);
        }
        break;
      }
      case 'minItems': {
        if (value === 0 || value === 1) out.minItems = value;
        else {
          hint[key] = value;
          o.removed.push(at);
        }
        break;
      }
      default:
        out[key] = clone(value);
    }
  }

  if (isObject) out.additionalProperties = false;
  if (madeOptional.length && Array.isArray(out.required)) {
    out.required = (out.required as unknown[]).filter((n) => !madeOptional.includes(String(n)));
  }

  if (o.inferEnumType && out.type === undefined && !out.anyOf && !out.allOf && !out.$ref) {
    const vals = Array.isArray(out.enum) ? out.enum : 'const' in out ? [out.const] : null;
    const t = vals ? primitiveTypeOf(vals) : null;
    if (t) out.type = t;
  }

  if (o.hints && Object.keys(hint).length > 0) {
    const text = '{' + Object.entries(hint).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ') + '}';
    out.description = typeof out.description === 'string' && out.description ? `${out.description}\n\n${text}` : text;
  }
  return out;
}

function primitiveTypeOf(vals: unknown[]): string | null {
  if (vals.length === 0) return null;
  const kinds = new Set(vals.map((v) => (v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v)));
  if (kinds.size !== 1) return null;
  const k = [...kinds][0];
  return k === 'string' || k === 'integer' || k === 'number' || k === 'boolean' ? k : null;
}

// 같은 스키마 객체로 부르면 한 번만 만든다 (요청마다 스키마를 다시 훑지 않게). 돌려준 값은 얼어 있음
const apiCache = new WeakMap<object, ApiSchemaInfo>();

// 기준 스키마 → API 변형 (캐시, auto 방식)
export function apiSchemaInfo(schema: JsonSchema): ApiSchemaInfo {
  const hit = apiCache.get(schema);
  if (hit) return hit;
  const info = deepFreeze(toApiSchemaInfo(schema));
  apiCache.set(schema, info);
  return info;
}

export function apiSchema(schema: JsonSchema): JsonSchema {
  return apiSchemaInfo(schema).schema;
}

// API 응답 → 기준 스키마 모양. apiSchema()가 고른 null 방식에 맞춰 되돌린다.
// changed에는 바꾼 칸 경로가 쌓인다 (sentinel이면 대신 값 → null, optional이면 빠진 칸 → null).
export function fromApiOutput(schema: JsonSchema, data: unknown, changed: string[] = []): unknown {
  const { mode } = apiSchemaInfo(schema);
  if (mode === 'sentinel') return decodeSentinels(schema, data, changed);
  if (mode === 'optional') return restoreNulls(schema, data, changed);
  return data;
}

// API 스키마에 남으면 안 되는 키워드가 있는지 (시험 · 점검용) — 속성 이름은 제외하고 키워드 자리만 본다
export function findUnsupported(schema: JsonSchema): string[] {
  const bad: string[] = [];
  const visit = (node: unknown, path: string) => {
    if (!isPlainObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const at = `${path}/${k}`;
      if (!KEEP.has(k) || k === 'oneOf') bad.push(at);
      if (k === 'format' && !(typeof v === 'string' && API_FORMATS.has(v))) bad.push(at);
      if (k === 'minItems' && v !== 0 && v !== 1) bad.push(at);
      if ((k === 'properties' || k === '$defs' || k === 'definitions') && isPlainObject(v)) {
        for (const [name, sub] of Object.entries(v)) visit(sub, `${at}/${name}`);
      } else if ((k === 'anyOf' || k === 'allOf' || k === 'oneOf') && Array.isArray(v)) {
        v.forEach((sub, i) => visit(sub, `${at}/${i}`));
      } else if (k === 'items' || k === 'additionalProperties') {
        visit(v, at);
      }
    }
    if ((node.type === 'object' || isPlainObject(node.properties)) && node.additionalProperties !== false) bad.push(`${path}/additionalProperties(≠false)`);
  };
  visit(schema, '');
  return bad;
}

// ---------------------------------------------------------------------------
// API 출력 → 기준 모양
// ---------------------------------------------------------------------------

function allowsNull(s: unknown): boolean {
  if (!isPlainObject(s)) return false;
  if (s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null'))) return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  if (Array.isArray(s.anyOf)) return s.anyOf.some(allowsNull);
  return false;
}

// 선택 칸으로 보낸 null 허용 칸을 모델이 빼먹었으면 null로 채워 기준 스키마 모양으로 되돌림.
// 기준 스키마가 required이면서 null을 허용하는 칸만 채운다(그 밖의 빠진 칸은 그대로 → validate가 잡음).
// 속성 순서는 기준 스키마 순서로 맞추고, 모르는 칸은 뒤에 그대로 둔다(validate가 잡음). 순수 함수.
export function restoreNulls(schema: JsonSchema, data: unknown, filled: string[] = []): unknown {
  return fill(schema, data, '', filled, schema);
}

function fill(s0: unknown, d: unknown, path: string, filled: string[], root: unknown): unknown {
  const s = deref(s0, root);
  if (!isPlainObject(s) || d === null || typeof d !== 'object') return d;
  if (Array.isArray(s.anyOf)) {
    const branch = pickBranch(s, d, root);
    return branch ? fill(branch, d, path, filled, root) : d;
  }
  if (Array.isArray(d)) {
    return isPlainObject(s.items) ? d.map((x, i) => fill(s.items, x, `${path}/${i}`, filled, root)) : d;
  }
  if (!isPlainObject(s.properties)) return d;
  const src = d as Record<string, unknown>;
  const req = Array.isArray(s.required) ? s.required : [];
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(s.properties)) {
    if (hasOwn(src, name)) setOwn(out, name, fill(sub, src[name], `${path}/${name}`, filled, root));
    else if (req.includes(name) && allowsNull(sub)) {
      // sub는 $ref를 안 따라간 그대로 — walk(optional)도 $ref 칸은 선택 칸으로 안 바꾸므로 같은 기준
      setOwn(out, name, null);
      filled.push(`${path}/${name}`);
    }
  }
  for (const [k, v] of Object.entries(src)) if (!hasOwn(out, k) && !hasOwn(s.properties, k)) setOwn(out, k, v);
  return out;
}

// anyOf 안에서 데이터 모양(객체 · 배열)에 맞는 갈래 고르기 ($ref 갈래는 따라가서 봄)
function pickBranch(s: JsonSchema, d: object, root: unknown): JsonSchema | null {
  if (!Array.isArray(s.anyOf)) return null;
  for (const x0 of s.anyOf) {
    const x = deref(x0, root);
    if (!isPlainObject(x)) continue;
    const fits = Array.isArray(d) ? x.type === 'array' || x.items !== undefined : x.type === 'object' || isPlainObject(x.properties);
    if (fits) return x;
  }
  return null;
}

// 문서 안 $ref("#/$defs/Appt" 등)를 따라감. 못 찾으면 그대로, 순환이면 32번에서 멈춤.
// walk는 $defs 안의 칸까지 대신 값으로 바꾸므로, 되돌릴 때도 $ref를 따라가야 짝이 맞는다.
function deref(node: unknown, root: unknown): unknown {
  let cur = node;
  for (let i = 0; i < 32 && isPlainObject(cur) && typeof cur.$ref === 'string'; i++) {
    const target = resolvePointer(root, cur.$ref);
    if (target === undefined) return cur;
    cur = target;
  }
  return cur;
}

function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined; // 바깥 문서 참조는 안 따라감
  let cur: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let key: string;
    try {
      key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (Array.isArray(cur)) {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else if (isPlainObject(cur) && hasOwn(cur, key)) cur = cur[key];
    else return undefined;
  }
  return cur;
}

// sentinel 방식으로 받은 응답의 대신 값을 null로 되돌림. 순수 함수.
// 문자열 칸은 "" 말고 공백뿐인 글 · "null"(대소문자 무관) · 설명 문구 그대로인 "없음" · "해당 없음" · "말하지 않음"도 null로 본다 —
// 실측에서 모델이 "null"을 글자로 쓴 적이 있고, enum 칸의 "NULL"이나 설명 '(해당 없음 · 말하지 않음)'을 값으로 베낄 수 있음.
// 글 전체가 그 말일 때만 — "특별한 일 없음" 같은 문장은 그대로.
export function decodeSentinels(schema: JsonSchema, data: unknown, changed: string[] = []): unknown {
  return dec(schema, data, '', changed, schema);
}

// 공백을 다 뺀 뒤 이 말과 같으면 null로 봄 (소문자 비교)
const NULL_WORDS = new Set(['null', '없음', '해당없음', '말하지않음']);
const isNullText = (v: unknown): boolean => {
  if (typeof v !== 'string') return false;
  const t = v.replace(/\s+/g, '').toLowerCase();
  return t === '' || NULL_WORDS.has(t);
};

function dec(s0: unknown, d: unknown, path: string, changed: string[], root: unknown): unknown {
  const s = deref(s0, root);
  if (!isPlainObject(s) || d === null || typeof d !== 'object') return d;
  const branch = pickBranch(s, d, root);
  if (branch) return dec(branch, d, path, changed, root);
  if (Array.isArray(d)) return isPlainObject(s.items) ? d.map((x, i) => dec(s.items, x, `${path}/${i}`, changed, root)) : d;
  if (!isPlainObject(s.properties)) return d;
  const props = s.properties;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    const sub = hasOwn(props, k) ? props[k] : undefined;
    // sentinelFor는 $ref를 안 따라간 칸 그대로 — walk가 대신 값을 정할 때와 같은 기준이어야 짝이 맞음
    const sen = sub === undefined ? null : sentinelFor(sub);
    if (sen && (v === sen.value || (sen.value === '' && isNullText(v)))) {
      setOwn(out, k, null);
      changed.push(`${path}/${k}`);
    } else setOwn(out, k, sub === undefined ? v : dec(sub, v, `${path}/${k}`, changed, root));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 검증 (기준 스키마 전체) — ajv와 같은 오류 문구: "경로: must have required property 'x'"
// ---------------------------------------------------------------------------
// 지원하는 키워드: type · properties · required · additionalProperties(false만) · items(스키마 하나) · enum · anyOf · pattern · minimum · maximum · maxLength
// 그 밖의 검사 키워드는 처음 쓸 때 던짐. 설명용 키워드(아래 ANNOTATION)는 무시.
// 오류 문구 · 순서는 ajv(allErrors)와 같게 맞춤: type → enum · anyOf → 숫자 · 글자 · 배열 · 객체 키워드 순.
// anyOf는 갈래마다 난 오류를 모두 싣고 끝에 'must match a schema in anyOf'를 붙임.

const ANNOTATION = new Set(['$id', '$schema', '$comment', 'title', 'description', 'default', 'examples']);
const CHECKED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'pattern', 'minimum', 'maximum', 'maxLength']);
const TYPE_NAMES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);

const patterns = new Map<string, RegExp>();
const verified = new WeakSet<object>();

function patternOf(src: string): RegExp {
  let re = patterns.get(src);
  if (!re) {
    re = new RegExp(src, 'u'); // ajv도 u 플래그로 컴파일
    patterns.set(src, re);
  }
  return re;
}

// 검사 전에 한 번 훑어 모르는 키워드 · 틀린 모양을 던진다 (스키마 객체마다 한 번)
function verifySchema(node: unknown, at: string): void {
  if (!isPlainObject(node)) throw new Error(`스키마 ${at || '(root)'}: 객체여야 함 (true/false 스키마는 지원 안 함)`);
  for (const [k, v] of Object.entries(node)) {
    if (ANNOTATION.has(k)) continue;
    if (!CHECKED.has(k)) throw new Error(`스키마 ${at || '(root)'}: 지원 안 하는 키워드 '${k}' (validate가 지원하는 것만 쓸 수 있음)`);
    switch (k) {
      case 'type': {
        const names = Array.isArray(v) ? v : [v];
        if (names.length === 0 || !names.every((t) => typeof t === 'string' && TYPE_NAMES.has(t))) throw new Error(`스키마 ${at || '(root)'}: type이 틀림`);
        break;
      }
      case 'properties': {
        if (!isPlainObject(v)) throw new Error(`스키마 ${at || '(root)'}: properties는 객체`);
        for (const [name, sub] of Object.entries(v)) verifySchema(sub, `${at}/properties/${name}`);
        break;
      }
      case 'required':
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`스키마 ${at || '(root)'}: required는 글자 목록`);
        break;
      case 'additionalProperties':
        if (v !== false && v !== true) throw new Error(`스키마 ${at || '(root)'}: additionalProperties는 true · false만 지원`);
        break;
      case 'items':
        verifySchema(v, `${at}/items`);
        break;
      case 'enum':
        if (!Array.isArray(v) || v.length === 0) throw new Error(`스키마 ${at || '(root)'}: enum은 비지 않은 목록`);
        break;
      case 'anyOf':
        if (!Array.isArray(v) || v.length === 0) throw new Error(`스키마 ${at || '(root)'}: anyOf는 비지 않은 목록`);
        v.forEach((sub, i) => verifySchema(sub, `${at}/anyOf/${i}`));
        break;
      case 'pattern':
        if (typeof v !== 'string') throw new Error(`스키마 ${at || '(root)'}: pattern은 글자`);
        patternOf(v);
        break;
      case 'minimum':
      case 'maximum':
      case 'maxLength':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`스키마 ${at || '(root)'}: ${k}는 수`);
        break;
    }
  }
}

function isType(t: string, d: unknown): boolean {
  switch (t) {
    case 'string': return typeof d === 'string';
    case 'number': return typeof d === 'number' && Number.isFinite(d);
    case 'integer': return typeof d === 'number' && Number.isInteger(d);
    case 'boolean': return typeof d === 'boolean';
    case 'null': return d === null;
    case 'array': return Array.isArray(d);
    case 'object': return typeof d === 'object' && d !== null && !Array.isArray(d);
    default: return false;
  }
}

// 글자 수는 ajv처럼 유니코드 글자(서로게이트 쌍 = 1) 기준
function ucs2length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if ((d & 0xfc00) === 0xdc00) i++;
    }
  }
  return n;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const pointer = (path: string, key: string | number): string => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

// 한 칸을 검사해 오류 줄을 out에 쌓는다. 줄 = "경로: 문구" (경로는 JSON 포인터, 맨 위는 "(root)")
function check(node: JsonSchema, data: unknown, path: string, out: string[]): void {
  const where = path || '(root)';
  const push = (msg: string) => {
    const line = `${where}: ${msg}`;
    if (!out.includes(line)) out.push(line);
  };

  if (node.type !== undefined) {
    const names = Array.isArray(node.type) ? (node.type as string[]) : [node.type as string];
    if (!names.some((t) => isType(t, data))) push(`must be ${names.join(',')}`);
  }

  if (Array.isArray(node.enum) && !node.enum.some((v) => deepEqual(v, data))) {
    push(`must be equal to one of the allowed values (${node.enum.map((v) => JSON.stringify(v)).join('|')})`);
  }

  if (Array.isArray(node.anyOf)) {
    // 한 갈래라도 통과하면 갈래들의 오류는 버림. 모두 실패하면 갈래마다의 오류를 싣고 anyOf 오류를 붙임
    let passed = false;
    const branchErrors: string[] = [];
    for (const branch of node.anyOf) {
      const sub: string[] = [];
      check(branch as JsonSchema, data, path, sub);
      if (sub.length === 0) {
        passed = true;
        break;
      }
      branchErrors.push(...sub);
    }
    if (!passed) {
      for (const e of branchErrors) if (!out.includes(e)) out.push(e);
      push('must match a schema in anyOf');
    }
  }

  if (typeof data === 'number') {
    if (typeof node.maximum === 'number' && data > node.maximum) push(`must be <= ${node.maximum}`);
    if (typeof node.minimum === 'number' && data < node.minimum) push(`must be >= ${node.minimum}`);
  }

  if (typeof data === 'string') {
    if (typeof node.maxLength === 'number' && ucs2length(data) > node.maxLength) push(`must NOT have more than ${node.maxLength} characters`);
    if (typeof node.pattern === 'string' && !patternOf(node.pattern).test(data)) push(`must match pattern "${node.pattern}"`);
  }

  if (Array.isArray(data)) {
    if (isPlainObject(node.items)) {
      const items = node.items;
      data.forEach((x, i) => check(items, x, pointer(path, i), out));
    }
  } else if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    const props = isPlainObject(node.properties) ? node.properties : {};
    if (Array.isArray(node.required)) {
      for (const name of node.required as string[]) if (!hasOwn(obj, name) || obj[name] === undefined) push(`must have required property '${name}'`);
    }
    if (node.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!hasOwn(props, k)) push(`must NOT have additional properties '${k}'`);
    }
    for (const [name, sub] of Object.entries(props)) {
      if (hasOwn(obj, name) && obj[name] !== undefined) check(sub as JsonSchema, obj[name], pointer(path, name), out);
    }
  }
}

// 기준 스키마로 검증. errors는 "경로: 문구" 문자열 (중복 제거). 스키마가 지원 밖 키워드를 쓰면 던짐
export function validate(schema: JsonSchema, data: unknown): ValidationResult {
  if (!verified.has(schema)) {
    verifySchema(schema, '');
    verified.add(schema);
  }
  const errors: string[] = [];
  check(schema, data, '', errors);
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 지문 (sha)
// ---------------------------------------------------------------------------

// FNV-1a 32비트, UTF-8 바이트 기준, 8자리 16진 — 순수 JS (Deno · Node 공통). 보안용 아님
export function fnv1aHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// 스키마 짧은 지문 6자리. 공백 · 줄바꿈은 무시하지만 키 순서는 반영한다
// (구조화 출력은 속성 순서대로 생성하므로 순서가 바뀌면 다른 스키마로 본다). 실험실 장부의 schema_id 지문과 같은 계산.
export function schemaSha(schema: JsonSchema): string {
  return fnv1aHex(JSON.stringify(schema)).slice(0, 6);
}

// ---------------------------------------------------------------------------
// 도우미
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is JsonSchema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// "__proto__" 같은 이름도 프로토타입을 건드리지 않고 그냥 칸으로
function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}
