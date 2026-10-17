// 시험용 가짜 DB — supabase-js 쿼리 빌더 중 서버 함수가 쓰는 모양만 흉내 냄 (메모리 표). 배포되는 코드가 아님
//   from(t).select/insert/update/delete/upsert + eq · neq · is · in · not(is null) · gte · lt · order · limit + single · maybeSingle + 개수(count · head)
//   rpc(이름, 인자) — 시험이 rpcHandlers에 이름별로 답을 등록함 (호출은 rpcCalls에 남음)
//   기본키 만들기, alarms 유일 제약(참여 조건 + 종류), CASCADE 삭제
//   failOn으로 특정 표 · 동작을 실패시켜 되돌리기를 시험함
//   upsert(…, { onConflict, ignoreDuplicates: true })는 PostgREST처럼 새로 들어간 행만 돌려줌 (ON CONFLICT DO NOTHING … RETURNING)
type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'update' | 'delete' | 'upsert';
type DbError = { message: string; code?: string };
type Result = { data: unknown; error: DbError | null; count?: number | null };

const PK: Record<string, string> = {
  appointments: 'appointment_id',
  appointment_participants: 'participant_id',
  alarms: 'alarm_id',
  user_edit_logs: 'edit_id',
  alarm_events: 'event_id',
};

const DEFAULTS: Record<string, Row> = {
  alarms: { routine_id: null, step_order: null, snooze_limit: 3, recurrence_rule: null },
  appointments: { memo: null },
};

// 시각 글자(ISO 8601)끼리는 시각으로, 그 밖에는 값 그대로 비교. 비교할 수 없으면 null
const comparable = (v: unknown): unknown => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
const compare = (a: unknown, b: unknown): number | null => {
  const x = comparable(a);
  const y = comparable(b);
  if (x == null || y == null) return null;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  failOn: { table: string; op: Op }[] = [];
  calls: string[] = [];
  rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {};
  rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  private seq = 0;

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  newId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  // 시험이 등록한 handler의 값을 돌려줌. 등록이 없으면 "없는 함수" 오류, handler가 던지면 DB 오류로
  rpc(name: string, args: Record<string, unknown> = {}): PromiseLike<Result> {
    this.calls.push(`rpc ${name}`);
    this.rpcCalls.push({ name, args });
    const handler = this.rpcHandlers[name];
    if (!handler) return Promise.resolve({ data: null, error: { message: `function ${name} does not exist`, code: '42883' } });
    try {
      return Promise.resolve({ data: handler(args), error: null });
    } catch (e) {
      return Promise.resolve({ data: null, error: { message: e instanceof Error ? e.message : String(e), code: 'XX000' } });
    }
  }

  cascade(table: string, removed: Row[]) {
    const ids = new Set(removed.map((r) => r[PK[table]]));
    if (table === 'appointments') {
      const parts = this.rows('appointment_participants').filter((p) => ids.has(p.appointment_id));
      this.tables.appointment_participants = this.rows('appointment_participants').filter((p) => !ids.has(p.appointment_id));
      this.cascade('appointment_participants', parts);
    }
    if (table === 'appointment_participants') {
      this.tables.alarms = this.rows('alarms').filter((a) => !ids.has(a.participant_id));
    }
  }
}

class FakeQuery implements PromiseLike<Result> {
  private op: Op = 'select';
  private payload: Row | Row[] | undefined;
  private filters: ((r: Row) => boolean)[] = [];
  private returning = false;
  private one: 'single' | 'maybe' | undefined;
  private countMode = false;
  private headOnly = false;
  private ordering: { col: string; ascending: boolean } | undefined;
  private max: number | undefined;
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};

  private db: FakeDb;
  private table: string;

  constructor(db: FakeDb, table: string) {
    this.db = db;
    this.table = table;
  }

  select(_columns?: string, options?: { count?: 'exact'; head?: boolean }) {
    this.returning = true;
    this.countMode = options?.count != null;
    this.headOnly = options?.head === true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert';
    this.payload = rows;
    return this;
  }
  upsert(rows: Row | Row[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = 'upsert';
    this.payload = rows;
    this.upsertOptions = options;
    return this;
  }
  update(patch: Row) {
    this.op = 'update';
    this.payload = patch;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  neq(col: string, val: unknown) {
    this.filters.push((r) => r[col] !== val);
    return this;
  }
  is(col: string, val: null) {
    this.filters.push((r) => (r[col] ?? null) === val);
    return this;
  }
  not(col: string, operator: string, val: unknown) {
    if (operator !== 'is' || val !== null) throw new Error(`FakeDb: not(${col}, ${operator}, …)은 아직 흉내 내지 않아요`);
    this.filters.push((r) => (r[col] ?? null) !== null);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push((r) => (compare(r[col], val) ?? -1) >= 0);
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push((r) => (compare(r[col], val) ?? 1) < 0);
    return this;
  }
  order(col: string, options: { ascending?: boolean } = {}) {
    this.ordering = { col, ascending: options.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  single() {
    this.one = 'single';
    return this;
  }
  maybeSingle() {
    this.one = 'maybe';
    return this;
  }

  then<R1 = Result, R2 = never>(onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  // 기본키 · 기본값을 채워 넣음. alarms는 (참여 조건, 종류) 유일 제약을 지킴. 어기면 이번에 넣은 것을 모두 되돌리고 오류 결과
  private insertRows(incoming: Row[], made: Row[]): Result | null {
    const { db, table } = this;
    const all = db.rows(table);
    for (const r of incoming) {
      const row: Row = { ...DEFAULTS[table], ...r };
      if (PK[table] && row[PK[table]] === undefined) row[PK[table]] = db.newId();
      if (table === 'alarms' && row.participant_id != null && all.some((a) => a.participant_id === row.participant_id && a.alarm_type === row.alarm_type)) {
        for (const done of made) all.splice(all.indexOf(done), 1);
        made.length = 0;
        return { data: null, error: { message: 'duplicate key value violates unique constraint "alarms_participant_type_key"', code: '23505' } };
      }
      made.push(row);
      all.push(row);
    }
    return null;
  }

  private run(): Result {
    const { db, table } = this;
    db.calls.push(`${this.op} ${table}`);
    if (db.failOn.some((f) => f.table === table && f.op === this.op)) return { data: null, error: { message: `injected failure: ${this.op} ${table}`, code: 'XX000' } };
    const all = db.rows(table);
    const incoming = this.payload === undefined ? [] : Array.isArray(this.payload) ? this.payload : [this.payload];
    let data: Row[] = [];

    if (this.op === 'insert') {
      const made: Row[] = [];
      const failed = this.insertRows(incoming, made);
      if (failed) return failed;
      data = made;
    } else if (this.op === 'upsert') {
      const { onConflict, ignoreDuplicates } = this.upsertOptions;
      const made: Row[] = [];
      for (const r of incoming) {
        const existing = onConflict ? all.find((a) => a[onConflict] !== undefined && a[onConflict] === r[onConflict]) : undefined;
        if (existing) {
          if (!ignoreDuplicates) {
            Object.assign(existing, r);
            made.push(existing);
          }
          continue; // ignoreDuplicates면 건너뜀 — 돌려주는 행에도 없음 (ON CONFLICT DO NOTHING … RETURNING)
        }
        const failed = this.insertRows([r], made);
        if (failed) return failed;
      }
      data = made;
    } else if (this.op === 'update') {
      data = all.filter((r) => this.filters.every((f) => f(r)));
      for (const r of data) Object.assign(r, this.payload);
    } else if (this.op === 'delete') {
      const gone = all.filter((r) => this.filters.every((f) => f(r)));
      db.tables[table] = all.filter((r) => !gone.includes(r));
      db.cascade(table, gone);
      data = gone;
    } else {
      data = all.filter((r) => this.filters.every((f) => f(r)));
      if (this.ordering) {
        const { col, ascending } = this.ordering;
        data = [...data].sort((x, y) => (compare(x[col], y[col]) ?? 0) * (ascending ? 1 : -1));
      }
      if (this.max != null) data = data.slice(0, this.max);
    }

    const copy = data.map((r) => ({ ...r }));
    const count = this.countMode ? copy.length : undefined;
    if (this.op !== 'select' && !this.returning) return { data: null, error: null };
    if (this.headOnly) return { data: null, error: null, count };
    if (this.one === 'single') {
      return copy.length === 1 ? { data: copy[0], error: null } : { data: null, error: { message: `expected 1 row, got ${copy.length}`, code: 'PGRST116' } };
    }
    if (this.one === 'maybe') {
      return copy.length <= 1 ? { data: copy[0] ?? null, error: null } : { data: null, error: { message: 'multiple rows', code: 'PGRST116' } };
    }
    return { data: copy, error: null, ...(count != null ? { count } : {}) };
  }
}
