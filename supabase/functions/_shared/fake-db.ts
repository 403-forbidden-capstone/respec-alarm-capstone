// 시험용 가짜 DB — supabase-js 쿼리 빌더 중 서버 함수가 쓰는 모양만 흉내 냄 (메모리 표). 배포되는 코드가 아님
//   from(t).select/insert/update/delete + eq · is · in + single · maybeSingle, 기본키 만들기, alarms 유일 제약(참여 조건 + 종류), CASCADE 삭제
//   failOn으로 특정 표 · 동작을 실패시켜 되돌리기를 시험함
type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'update' | 'delete';
type Result = { data: unknown; error: { message: string; code?: string } | null };

const PK: Record<string, string> = {
  appointments: 'appointment_id',
  appointment_participants: 'participant_id',
  alarms: 'alarm_id',
  user_edit_logs: 'edit_id',
};

const DEFAULTS: Record<string, Row> = {
  alarms: { routine_id: null, step_order: null, snooze_limit: 3, recurrence_rule: null },
  appointments: { memo: null },
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  failOn: { table: string; op: Op }[] = [];
  calls: string[] = [];
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

  private db: FakeDb;
  private table: string;

  constructor(db: FakeDb, table: string) {
    this.db = db;
    this.table = table;
  }

  select(_columns?: string) {
    this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert';
    this.payload = rows;
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
  is(col: string, val: null) {
    this.filters.push((r) => (r[col] ?? null) === val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
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

  private run(): Result {
    const { db, table } = this;
    db.calls.push(`${this.op} ${table}`);
    if (db.failOn.some((f) => f.table === table && f.op === this.op)) return { data: null, error: { message: `injected failure: ${this.op} ${table}`, code: 'XX000' } };
    const all = db.rows(table);
    let data: Row[] = [];

    if (this.op === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const made: Row[] = [];
      for (const r of incoming) {
        const row: Row = { ...DEFAULTS[table], ...r };
        if (PK[table] && row[PK[table]] === undefined) row[PK[table]] = db.newId();
        if (table === 'alarms' && row.participant_id != null && all.some((a) => a.participant_id === row.participant_id && a.alarm_type === row.alarm_type)) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint "alarms_participant_type_key"', code: '23505' } };
        }
        made.push(row);
      }
      all.push(...made);
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
    }

    const copy = data.map((r) => ({ ...r }));
    if (this.op !== 'select' && !this.returning) return { data: null, error: null };
    if (this.one === 'single') {
      return copy.length === 1 ? { data: copy[0], error: null } : { data: null, error: { message: `expected 1 row, got ${copy.length}`, code: 'PGRST116' } };
    }
    if (this.one === 'maybe') {
      return copy.length <= 1 ? { data: copy[0] ?? null, error: null } : { data: null, error: { message: 'multiple rows', code: 'PGRST116' } };
    }
    return { data: copy, error: null };
  }
}
