// 요청 본문 읽기 · 검사 — 모양이 틀리면 VALIDATION_FAILED(400) + details.issues[{ path, message }]
// 라이브러리 없이 작게: 필드별로 읽으면서 문제를 모아 두었다가 finish()에서 한 번에 던짐
// 순수 TS — node --test로 시험
import { HttpError } from './errors.ts';

export type Issue = { path: string; message: string };

const MAX_BODY_CHARS = 100_000;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) throw new HttpError('VALIDATION_FAILED', '요청이 너무 커요');
  if (!text.trim()) throw new HttpError('VALIDATION_FAILED', '요청 본문(JSON)이 비어 있어요');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('VALIDATION_FAILED', '요청 본문이 JSON 형식이 아니에요');
  }
}

export function parseIso(value: string): Date | undefined {
  if (!ISO_8601.test(value)) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

type Opts = { required?: boolean };

export class Reader {
  readonly path: string;
  readonly value: Record<string, unknown>;
  readonly issues: Issue[];

  constructor(value: Record<string, unknown>, path: string, issues: Issue[]) {
    this.value = value;
    this.path = path;
    this.issues = issues;
  }

  // 본문 전체 — 객체가 아니면 바로 던짐
  static root(raw: unknown): Reader {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError('VALIDATION_FAILED', '요청 본문은 JSON 객체여야 해요');
    }
    return new Reader(raw as Record<string, unknown>, '', []);
  }

  private at(key: string): string {
    return this.path ? `${this.path}.${key}` : key;
  }

  private problem(key: string, message: string): undefined {
    this.issues.push({ path: this.at(key), message });
    return undefined;
  }

  // null · 없음을 같게 취급해 "없음"으로 돌려줌. 필수인데 없으면 문제로 기록
  private present(key: string, required?: boolean): unknown {
    const v = this.value[key];
    if (v === undefined || v === null) {
      if (required) this.problem(key, '필수 값이에요');
      return undefined;
    }
    return v;
  }

  has(key: string): boolean {
    return this.value[key] !== undefined;
  }

  // 키가 있고 null이면 true — "자동으로 되돌림" 같은 명시적 null을 구분할 때
  isNull(key: string): boolean {
    return this.value[key] === null;
  }

  string(key: string, opts: Opts & { min?: number; max?: number; pattern?: RegExp } = {}): string | undefined {
    const v = this.present(key, opts.required);
    if (v === undefined) return undefined;
    if (typeof v !== 'string') return this.problem(key, '글자여야 해요');
    const s = v.trim();
    if (opts.min != null && s.length < opts.min) return this.problem(key, `${opts.min}자 이상이어야 해요`);
    if (opts.max != null && s.length > opts.max) return this.problem(key, `${opts.max}자 이하여야 해요`);
    if (opts.pattern && !opts.pattern.test(s)) return this.problem(key, '형식이 맞지 않아요');
    return s;
  }

  number(key: string, opts: Opts & { min?: number; max?: number } = {}): number | undefined {
    const v = this.present(key, opts.required);
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.problem(key, '숫자여야 해요');
    if (opts.min != null && v < opts.min) return this.problem(key, `${opts.min} 이상이어야 해요`);
    if (opts.max != null && v > opts.max) return this.problem(key, `${opts.max} 이하여야 해요`);
    return v;
  }

  int(key: string, opts: Opts & { min?: number; max?: number } = {}): number | undefined {
    const v = this.number(key, opts);
    if (v === undefined) return undefined;
    if (!Number.isInteger(v)) return this.problem(key, '정수여야 해요');
    return v;
  }

  bool(key: string, opts: Opts = {}): boolean | undefined {
    const v = this.present(key, opts.required);
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') return this.problem(key, 'true · false여야 해요');
    return v;
  }

  oneOf<T extends string>(key: string, values: readonly T[], opts: Opts = {}): T | undefined {
    const v = this.present(key, opts.required);
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      return this.problem(key, `${values.join(' · ')} 중 하나여야 해요`);
    }
    return v as T;
  }

  uuid(key: string, opts: Opts = {}): string | undefined {
    const v = this.present(key, opts.required);
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !UUID.test(v)) return this.problem(key, 'UUID 형식이 아니에요');
    return v.toLowerCase();
  }

  // ISO 8601 + 오프셋 (5장 5.2 "시각 표기")
  date(key: string, opts: Opts = {}): Date | undefined {
    const v = this.present(key, opts.required);
    if (v === undefined) return undefined;
    const d = typeof v === 'string' ? parseIso(v) : undefined;
    return d ?? this.problem(key, '시각은 오프셋이 있는 ISO 8601이어야 해요 (예: 2026-10-20T10:00:00+09:00)');
  }

  object(key: string, opts: Opts = {}): Reader | undefined {
    const v = this.present(key, opts.required);
    if (v === undefined) return undefined;
    if (typeof v !== 'object' || Array.isArray(v)) return this.problem(key, '객체여야 해요');
    return new Reader(v as Record<string, unknown>, this.at(key), this.issues);
  }

  // 글자 배열 (예: kinds)
  stringList<T extends string>(key: string, values: readonly T[], opts: Opts & { max?: number } = {}): T[] | undefined {
    const v = this.present(key, opts.required);
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) return this.problem(key, '배열이어야 해요');
    if (opts.max != null && v.length > opts.max) return this.problem(key, `${opts.max}개 이하여야 해요`);
    const out: T[] = [];
    for (const item of v) {
      if (typeof item !== 'string' || !(values as readonly string[]).includes(item)) {
        return this.problem(key, `${values.join(' · ')} 중에서만 고를 수 있어요`);
      }
      if (!out.includes(item as T)) out.push(item as T);
    }
    return out;
  }

  // 객체 배열 — 각 칸을 Reader로
  objects(key: string, opts: Opts & { max?: number } = {}): Reader[] | undefined {
    const v = this.present(key, opts.required);
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) return this.problem(key, '배열이어야 해요');
    if (opts.max != null && v.length > opts.max) return this.problem(key, `${opts.max}개 이하여야 해요`);
    const out: Reader[] = [];
    v.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        this.problem(`${key}[${i}]`, '객체여야 해요');
        return;
      }
      out.push(new Reader(item as Record<string, unknown>, `${this.at(key)}[${i}]`, this.issues));
    });
    return out;
  }

  // 어떤 JSON 값이든 (user_edit_logs의 auto_value · edited_value). 너무 크면 문제로 기록
  json(key: string, maxChars = 2_000): unknown {
    const v = this.value[key];
    if (v === undefined) return undefined;
    if (JSON.stringify(v).length > maxChars) return this.problem(key, `${maxChars}자 이하여야 해요`);
    return v;
  }

  problemAt(key: string, message: string): void {
    this.problem(key, message);
  }

  // 모은 문제가 있으면 던짐 — 마지막에 한 번만 부름
  finish(): void {
    if (this.issues.length) {
      throw new HttpError('VALIDATION_FAILED', '입력값을 확인해 주세요', { issues: this.issues });
    }
  }
}
