// 프롬프트 템플릿 채우기 — 머스태시 문법 일부만. 실험실(ai-lab) src/lib/render.ts의 렌더러 부분을 옮김. 순수 TS (Node · Deno API 없음)
// 지원: {{name}} · {{a.b}} · {{#list}}…{{/list}}(배열 반복, {{.}} = 지금 항목) · {{#flag}}…{{/flag}}(참이면 한 번)
//       {{^name}}…{{/name}}(빈 배열 · 거짓이면) · {{! 주석}}. HTML 이스케이프 없음.
// 엄격함: 모르는 이름 · null · 객체를 그대로 넣으면 바로 RenderError(오타 · 빠진 값을 크게 터뜨리기 위해). 서버 코드 쪽 버그라 HTTP 500으로 올라감.
// 섹션 · 주석 태그만 있는 줄은 줄째 지운다(빈 줄이 남지 않게). 넣은 값은 다시 채우지 않는다(사용자 말 속 {{…}} 무시).
// 같은 입력 → 같은 바이트(프롬프트 캐시가 흔들리지 않게).
// md 머리말 읽기 · 지문은 여기 없음 — 프롬프트 글은 prompts/gen.mjs가 .ts 모듈로 굳혀 두고, 서버는 파일을 읽지 않는다.

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

// ---------------------------------------------------------------------------
// 구문 트리
// ---------------------------------------------------------------------------

interface TextNode {
  t: 'text';
  s: string;
}
interface VarNode {
  t: 'var';
  name: string;
  line: number;
}
interface SectionNode {
  t: 'section';
  name: string;
  inverted: boolean;
  children: Node[];
  line: number;
}
type Node = TextNode | VarNode | SectionNode;

type TagKind = 'var' | 'section' | 'inverted' | 'close' | 'comment';
// 태그 첫 글자 → 종류. {{&name}}은 이스케이프가 없으니 {{name}}과 같다.
const SIGIL_KIND: Record<string, TagKind | undefined> = { '!': 'comment', '#': 'section', '^': 'inverted', '/': 'close', '&': 'var' };

// 이름 규칙: "." 또는 a · a.b · list.0 (첫 마디는 숫자로 시작 못 함)
const NAME_RE = /^(?:\.|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)$/;
const BLANK_BEFORE_RE = /^[ \t]*$/;
const BLANK_AFTER_RE = /^[ \t\r]*$/;

function parse(tpl: string): Node[] {
  if (typeof tpl !== 'string') throw new RenderError('render: 템플릿이 문자열이 아님');
  const root: Node[] = [];
  const open: SectionNode[] = [];
  let out = root;
  let i = 0;

  // 줄 번호 — 위치가 앞으로만 가므로 이어서 센다
  let lineCursor = 0;
  let lineNo = 1;
  const lineOf = (pos: number): number => {
    for (; lineCursor < pos; lineCursor++) if (tpl.charCodeAt(lineCursor) === 10) lineNo++;
    return lineNo;
  };
  const pushText = (s: string): void => {
    if (s !== '') out.push({ t: 'text', s });
  };

  while (i < tpl.length) {
    const start = tpl.indexOf('{{', i);
    if (start < 0) {
      pushText(tpl.slice(i));
      break;
    }
    const line = lineOf(start);
    const close = tpl.indexOf('}}', start + 2);
    if (close < 0) throw new RenderError(`render: 닫히지 않은 태그 '{{' (${line}번째 줄)`);
    const raw = tpl.slice(start + 2, close).trim();
    let end = close + 2;

    // 태그 종류
    const sigil = raw.charAt(0);
    if (sigil === '>') throw new RenderError(`render: 부분 템플릿 {{>…}}은 지원하지 않음 (${line}번째 줄)`);
    if (sigil === '=') throw new RenderError(`render: 구분자 바꾸기 {{=…=}}는 지원하지 않음 (${line}번째 줄)`);
    if (sigil === '{') throw new RenderError(`render: {{{…}}}는 지원하지 않음 — 이스케이프가 없으니 {{name}}으로 충분 (${line}번째 줄)`);
    const marked = SIGIL_KIND[sigil];
    const kind: TagKind = marked ?? 'var';
    const name = kind === 'comment' ? '' : marked !== undefined ? raw.slice(1).trim() : raw;

    if (kind !== 'comment' && !NAME_RE.test(name)) {
      throw new RenderError(`render: 잘못된 이름 '{{${raw}}}' (${line}번째 줄)`);
    }

    // 섹션 · 주석 태그 하나만 있는 줄은 줄째 지운다
    let textEnd = start;
    if (kind !== 'var') {
      const lineStart = tpl.lastIndexOf('\n', start - 1) + 1;
      const nl = tpl.indexOf('\n', end);
      const lineEnd = nl < 0 ? tpl.length : nl;
      if (lineStart >= i && BLANK_BEFORE_RE.test(tpl.slice(lineStart, start)) && BLANK_AFTER_RE.test(tpl.slice(end, lineEnd))) {
        textEnd = lineStart;
        end = nl < 0 ? tpl.length : nl + 1;
      }
    }
    pushText(tpl.slice(i, textEnd));
    i = end;

    if (kind === 'comment') continue;
    if (kind === 'var') {
      out.push({ t: 'var', name, line });
    } else if (kind === 'section' || kind === 'inverted') {
      if (name === '.') throw new RenderError(`render: 섹션 이름으로 '.'은 쓸 수 없음 (${line}번째 줄)`);
      const node: SectionNode = { t: 'section', name, inverted: kind === 'inverted', children: [], line };
      out.push(node);
      open.push(node);
      out = node.children;
    } else {
      const top = open.pop();
      if (!top) throw new RenderError(`render: 열린 섹션 없이 {{/${name}}} (${line}번째 줄)`);
      if (top.name !== name) {
        throw new RenderError(`render: {{/${name}}}가 열린 섹션 {{${top.inverted ? '^' : '#'}${top.name}}}(${top.line}번째 줄)와 다름 (${line}번째 줄)`);
      }
      const parent = open[open.length - 1];
      out = parent ? parent.children : root;
    }
  }
  const unclosed = open[open.length - 1];
  if (unclosed) {
    throw new RenderError(`render: 닫히지 않은 섹션 {{${unclosed.inverted ? '^' : '#'}${unclosed.name}}} (${unclosed.line}번째 줄)`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// 값 찾기 · 출력
// ---------------------------------------------------------------------------

function hasKey(scope: unknown, key: string): boolean {
  if (scope === null || typeof scope !== 'object') return false;
  if (Array.isArray(scope)) return key === 'length' || (/^\d+$/.test(key) && Number(key) < scope.length);
  return Object.prototype.hasOwnProperty.call(scope, key);
}

// 안쪽 범위부터 찾는다. 첫 마디를 찾은 범위에서만 나머지 마디를 따라간다(위로 되돌아가지 않음).
function lookup(name: string, stack: unknown[], line: number): unknown {
  if (name === '.') return stack[stack.length - 1];
  const segs = name.split('.');
  const head = segs[0] as string;
  for (let k = stack.length - 1; k >= 0; k--) {
    const scope = stack[k];
    if (!hasKey(scope, head)) continue;
    let v: unknown = (scope as Record<string, unknown>)[head];
    for (let s = 1; s < segs.length; s++) {
      const seg = segs[s] as string;
      if (!hasKey(v, seg)) throw new RenderError(`render: 모르는 변수 {{${name}}} — '${seg}' 없음 (${line}번째 줄)`);
      v = (v as Record<string, unknown>)[seg];
    }
    if (v === undefined) throw new RenderError(`render: 변수 {{${name}}} 값이 undefined (${line}번째 줄)`);
    return v;
  }
  throw new RenderError(`render: 모르는 변수 {{${name}}} (${line}번째 줄)`);
}

function toText(v: unknown, name: string, line: number): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RenderError(`render: {{${name}}} 값이 유한한 수가 아님 (${line}번째 줄)`);
    return String(v);
  }
  if (typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v === null) throw new RenderError(`render: {{${name}}} 값이 null — 섹션({{#…}}/{{^…}})으로 감싸 주세요 (${line}번째 줄)`);
  if (Array.isArray(v)) throw new RenderError(`render: {{${name}}}는 배열 — {{#${name}}}…{{/${name}}}로 반복해 주세요 (${line}번째 줄)`);
  throw new RenderError(`render: {{${name}}} 값을 글자로 넣을 수 없음(${typeof v}) (${line}번째 줄)`);
}

function truthy(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
}

function emit(nodes: Node[], stack: unknown[], out: string[]): void {
  for (const n of nodes) {
    if (n.t === 'text') {
      out.push(n.s);
    } else if (n.t === 'var') {
      out.push(toText(lookup(n.name, stack, n.line), n.name, n.line));
    } else {
      const v = lookup(n.name, stack, n.line);
      if (n.inverted) {
        if (!truthy(v)) emit(n.children, stack, out);
      } else if (Array.isArray(v)) {
        for (const item of v) emit(n.children, [...stack, item], out);
      } else if (truthy(v)) {
        emit(n.children, [...stack, v], out);
      }
    }
  }
}

// 템플릿을 채운다. 모르는 이름 · null · 객체를 그대로 넣으면 RenderError.
export function render(template: string, vars: Record<string, unknown>): string {
  if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) throw new RenderError('render: vars는 객체여야 함');
  const out: string[] = [];
  emit(parse(template), [vars], out);
  return out.join('');
}

// 템플릿이 쓰는 이름 목록(처음 나온 순서, '.' 제외). 실행 전에 빠진 값을 미리 확인할 때 쓴다.
export function templateVars(template: string): string[] {
  const seen: string[] = [];
  const walk = (nodes: Node[]): void => {
    for (const n of nodes) {
      if (n.t === 'text') continue;
      if (n.name !== '.' && !seen.includes(n.name)) seen.push(n.name);
      if (n.t === 'section') walk(n.children);
    }
  };
  walk(parse(template));
  return seen;
}
