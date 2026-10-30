// 시험용 가짜 DB — supabase-js 쿼리 빌더 중 서버 함수가 쓰는 모양만 흉내 냄 (메모리 표). 배포되는 코드가 아님
//   from(t).select/insert/update/delete/upsert + eq · neq · is · in · not(is null) · gt · gte · lt · lte · order · limit + single · maybeSingle + 개수(count · head)
//   rpc(이름, 인자) — 시험이 rpcHandlers에 이름별로 답을 등록함 (호출은 rpcCalls에 남음). withRollRpc()는 alarm-roll이 쓰는 DB 함수 둘을 등록해 줌
//   기본키 만들기, alarms 유일 제약(참여 조건 + 종류), CASCADE 삭제
//   (L1 PR 4b) appointments.exception_kind(이번만 고친 · 지운 회차, 기본 NULL). roll_due_series 흉내는 기준 회차에서 예외 회차를 뺌
//   반복 회차 칸 (alarm_roll.sql): appointments · alarms(일정 없는 알람)는 insert 때 series_id · occurrence_on을 채우고(fill_series 트리거),
//     (만든 사람, 묶음, 날짜)가 겹치면 23505. 날짜는 만든 사람 profiles.timezone(없으면 Asia/Seoul)으로 셈
//   failOn으로 특정 표 · 동작을 실패시켜 되돌리기를 시험함
//   upsert(…, { onConflict, ignoreDuplicates: true })는 PostgREST처럼 새로 들어간 행만 돌려줌 (ON CONFLICT DO NOTHING … RETURNING). onConflict는 'a,b,c'처럼 여러 칸도 됨
//   임베드: appointment_participants를 읽을 때 `appointments!inner(…)` · `alarms!inner(…)`와 'alarms.alarm_type' 같은 점 붙은 거르기만 흉내 (그날 첫 일정 · 이동 기록 읽기용)
//   (L4) jsonb 칸 거르기: eq('server_state->>rev', '3') 같은 `->` · `->>` 경로 (낙관적 잠금 비교용). alarm_events를 읽을 때 `alarms(…, appointment_participants(…))` 왼쪽 임베드(앞 출발 읽기용).
//   (L4) 표: conversation_sessions · ai_calls · user_questions — 기본키 · 시각 기본값. 서버 키만 쓰는 두 칸 트리거(turns · server_state)는 흉내 안 냄
import { localDateKey } from './tz.ts';

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
  todos: 'todo_id',
  conversation_sessions: 'session_id',
  ai_calls: 'call_id',
  user_questions: 'question_id',
};

const DEFAULTS: Record<string, Row> = {
  alarms: { routine_id: null, step_order: null, snooze_limit: 3, recurrence_rule: null },
  appointments: { memo: null, exception_kind: null },
};

const DAY_MS = 86_400_000;

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
  now = new Date(); // DB 함수 흉내가 created_at 같은 칸에 찍는 "지금" — 시험이 시계를 옮기며 바꿈
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

  // alarm_roll.sql의 DB 함수 둘 (roll_insert_occurrence · roll_due_series)을 같은 규칙으로 흉내 내서 등록. 이미 등록한 handler는 덮지 않음
  withRollRpc(): this {
    this.rpcHandlers.roll_insert_occurrence ??= (args) => rollInsertOccurrence(this, args);
    this.rpcHandlers.roll_due_series ??= (args) => rollDueSeries(this, args);
    return this;
  }

  timezoneOf(userId: unknown): string {
    const profile = this.rows('profiles').find((p) => p.user_id === userId);
    return typeof profile?.timezone === 'string' ? profile.timezone : 'Asia/Seoul';
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
  private embedFilters: { rel: string; test: (embedded: Row) => boolean }[] = [];
  private columns = '';
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

  select(columns?: string, options?: { count?: 'exact'; head?: boolean }) {
    this.returning = true;
    this.columns = columns ?? '';
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

  // 'alarms.alarm_type'처럼 점이 붙은 칸은 임베드한 쪽의 칸 (PostgREST 임베드 거르기)
  private where(col: string, test: (value: unknown) => boolean) {
    const dot = col.indexOf('.');
    if (col.includes('->')) {
      // jsonb 경로: `a->b->>c` (->> 는 글자로 꺼냄, 없으면 null)
      const parts = col.split(/->>?/);
      const asText = col.includes('->>');
      this.filters.push((r) => {
        let v: unknown = r[parts[0]];
        for (const key of parts.slice(1)) v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
        return test(asText ? (v == null ? null : String(v)) : v);
      });
    } else if (dot < 0) this.filters.push((r) => test(r[col]));
    else {
      const field = col.slice(dot + 1);
      this.embedFilters.push({ rel: col.slice(0, dot), test: (embedded) => test(embedded[field]) });
    }
    return this;
  }
  eq(col: string, val: unknown) {
    return this.where(col, (v) => v === val);
  }
  neq(col: string, val: unknown) {
    return this.where(col, (v) => v !== val);
  }
  is(col: string, val: null) {
    return this.where(col, (v) => (v ?? null) === val);
  }
  not(col: string, operator: string, val: unknown) {
    if (operator !== 'is' || val !== null) throw new Error(`FakeDb: not(${col}, ${operator}, …)은 아직 흉내 내지 않아요`);
    return this.where(col, (v) => (v ?? null) !== null);
  }
  in(col: string, vals: unknown[]) {
    return this.where(col, (v) => vals.includes(v));
  }
  gt(col: string, val: unknown) {
    return this.where(col, (v) => (compare(v, val) ?? -1) > 0);
  }
  gte(col: string, val: unknown) {
    return this.where(col, (v) => (compare(v, val) ?? -1) >= 0);
  }
  lte(col: string, val: unknown) {
    return this.where(col, (v) => (compare(v, val) ?? 1) <= 0);
  }
  lt(col: string, val: unknown) {
    return this.where(col, (v) => (compare(v, val) ?? 1) < 0);
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

  // 임베드(`…!inner(…)`)를 붙인 참여 한 줄. 안쪽에 거를 조건에 맞는 행이 없으면 null (inner join)
  //   appointments는 참여 → 약속(하나), alarms는 참여 → 알람(여러 개, 거른 것만 남김)
  private withEmbeds(parent: Row, rels: string[]): Row | null {
    const out: Row = { ...parent };
    for (const rel of rels) {
      const passes = (embedded: Row) => this.embedFilters.filter((f) => f.rel === rel).every((f) => f.test(embedded));
      if (this.table === 'appointment_participants' && rel === 'appointments') {
        const found = this.db.rows('appointments').find((a) => a.appointment_id === parent.appointment_id);
        if (!found || !passes(found)) return null;
        out[rel] = { ...found };
      } else if (this.table === 'appointment_participants' && rel === 'alarms') {
        const found = this.db.rows('alarms').filter((a) => a.participant_id === parent.participant_id && passes(a));
        if (!found.length) return null;
        out[rel] = found.map((a) => ({ ...a }));
      } else {
        throw new Error(`FakeDb: ${this.table}의 임베드 ${rel}!inner는 아직 흉내 내지 않아요`);
      }
    }
    return out;
  }

  // alarm_roll.sql의 fill_series 트리거 — series_id가 없으면 자기 id, 날짜는 만든 사람 시간대의 약속(알람) 날짜. 알람은 약속 · 루틴 알람이 아닐 때만
  private fillSeries(row: Row) {
    const { db, table } = this;
    if (table === 'appointments') {
      row.series_id ??= row.appointment_id;
      if (row.occurrence_on == null && typeof row.appointment_at === 'string') row.occurrence_on = localDateKey(new Date(row.appointment_at), db.timezoneOf(row.creator_id));
    } else if (table === 'alarms' && row.participant_id == null && row.routine_id == null) {
      row.series_id ??= row.alarm_id;
      if (row.occurrence_on == null && typeof row.scheduled_at === 'string') row.occurrence_on = localDateKey(new Date(row.scheduled_at), db.timezoneOf(row.user_id));
    }
  }

  // L4 표의 칸 기본값 (init_schema · ai_conversation_state.sql) — 시각은 db.now
  private fillDefaults(row: Row) {
    const stamp = this.db.now.toISOString();
    if (this.table === 'conversation_sessions') {
      row.started_at ??= stamp;
      row.created_at ??= stamp;
      row.ended_at ??= null;
      row.apply_status ??= 'PENDING';
      row.turns ??= [];
      row.server_state ??= {};
    } else if (this.table === 'ai_calls') {
      row.created_at ??= stamp;
      row.flags ??= [];
      row.io ??= null;
    } else if (this.table === 'user_questions') {
      row.asked_at ??= stamp;
      row.answered_at ??= null;
    }
  }

  // alarm_events를 읽을 때 `alarms(…, appointment_participants(…))` 왼쪽 임베드 — 없는 쪽은 null (PostgREST 왼쪽 조인). 거른 뒤에 붙임
  private withLeftEmbeds(rows: Row[]): Row[] {
    if (this.table !== 'alarm_events' || !/(^|[,\s])alarms\(/.test(this.columns)) return rows;
    const nested = /appointment_participants\(/.test(this.columns);
    return rows.map((r) => {
      const alarm = this.db.rows('alarms').find((a) => a.alarm_id === r.alarm_id);
      if (!alarm) return { ...r, alarms: null };
      const part = nested ? this.db.rows('appointment_participants').find((p) => p.participant_id === alarm.participant_id) : undefined;
      return { ...r, alarms: { ...alarm, ...(nested ? { appointment_participants: part ? { ...part } : null } : {}) } };
    });
  }

  // 기본키 · 기본값을 채워 넣음. alarms는 (참여 조건, 종류) 유일 제약을 지킴. 반복 회차는 (만든 사람, 묶음, 날짜) 유일 제약.
  // 어기면 이번에 넣은 것을 모두 되돌리고 오류 결과
  private insertRows(incoming: Row[], made: Row[]): Result | null {
    const { db, table } = this;
    const all = db.rows(table);
    const duplicate = (name: string): Result => {
      for (const done of made) all.splice(all.indexOf(done), 1);
      made.length = 0;
      return { data: null, error: { message: `duplicate key value violates unique constraint "${name}"`, code: '23505' } };
    };
    for (const r of incoming) {
      const row: Row = { ...DEFAULTS[table], ...structuredClone(r) }; // jsonb 칸을 DB처럼 복사해 담음 (넣은 쪽이 나중에 고쳐도 표는 안 변함)
      if (PK[table] && row[PK[table]] === undefined) row[PK[table]] = db.newId();
      this.fillDefaults(row);
      this.fillSeries(row);
      if (table === 'alarms' && row.participant_id != null && all.some((a) => a.participant_id === row.participant_id && a.alarm_type === row.alarm_type)) {
        return duplicate('alarms_participant_type_key');
      }
      if (table === 'appointments' && all.some((a) => a.creator_id === row.creator_id && a.series_id === row.series_id && a.occurrence_on === row.occurrence_on)) {
        return duplicate('appointments_series_occurrence_key');
      }
      if (table === 'alarms' && row.series_id != null && all.some((a) => a.user_id === row.user_id && a.series_id === row.series_id && a.occurrence_on === row.occurrence_on)) {
        return duplicate('alarms_series_occurrence_key');
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
      const keys = onConflict ? onConflict.split(',').map((k) => k.trim()) : [];
      const made: Row[] = [];
      for (const r of incoming) {
        const existing = keys.length ? all.find((a) => keys.every((k) => a[k] !== undefined && a[k] === r[k])) : undefined;
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
      for (const r of data) Object.assign(r, structuredClone(this.payload));
    } else if (this.op === 'delete') {
      const gone = all.filter((r) => this.filters.every((f) => f(r)));
      db.tables[table] = all.filter((r) => !gone.includes(r));
      db.cascade(table, gone);
      data = gone;
    } else {
      const rels = [...this.columns.matchAll(/(\w+)!inner\(/g)].map((m) => m[1]);
      for (const f of this.embedFilters) if (!rels.includes(f.rel)) throw new Error(`FakeDb: ${f.rel}.… 거르기는 select에 ${f.rel}!inner(…)가 있어야 해요`);
      const source: Row[] = rels.length ? all.flatMap((r): Row[] => { const joined = this.withEmbeds(r, rels); return joined ? [joined] : []; }) : all;
      data = this.withLeftEmbeds(source.filter((r) => this.filters.every((f) => f(r))));
      if (this.ordering) {
        const { col, ascending } = this.ordering;
        data = [...data].sort((x, y) => (compare(x[col], y[col]) ?? 0) * (ascending ? 1 : -1));
      }
      if (this.max != null) data = data.slice(0, this.max);
    }

    const copy = data.map((r) => structuredClone(r)); // 읽은 쪽이 jsonb 칸을 고쳐도 표는 안 변함
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

// ---------------------------------------------------------------------------
// alarm_roll.sql의 DB 함수 흉내
// ---------------------------------------------------------------------------

const text = (v: unknown): string | null => (v == null ? null : String(v));

// roll_insert_occurrence — 같은 (만든 사람, 묶음, 날짜)가 있으면 null, 없으면 약속 · 참여 · 알람 · 준비물을 쓰고 약속 id (함수가 한 트랜잭션이라 중간 실패는 흉내 안 냄)
function rollInsertOccurrence(db: FakeDb, args: Record<string, unknown>): string | null {
  const ap = (args.p_appointment ?? {}) as Row;
  const pt = (args.p_participant ?? {}) as Row;
  const alarms = (args.p_alarms ?? []) as Row[];
  const items = (args.p_items ?? []) as Row[];
  if (!ap.creator_id || !ap.series_id || !ap.occurrence_on) throw new Error('creator_id · series_id · occurrence_on이 필요함');
  if (db.rows('appointments').some((a) => a.creator_id === ap.creator_id && a.series_id === ap.series_id && a.occurrence_on === ap.occurrence_on)) return null;

  const appointmentId = db.newId();
  db.rows('appointments').push({
    appointment_id: appointmentId,
    creator_id: ap.creator_id,
    group_id: ap.group_id ?? null,
    series_id: ap.series_id,
    occurrence_on: ap.occurrence_on,
    title: ap.title,
    appointment_at: ap.appointment_at,
    dest_name: ap.dest_name,
    dest_lat: ap.dest_lat ?? null,
    dest_lng: ap.dest_lng ?? null,
    dest_radius_m: ap.dest_radius_m ?? null,
    importance: ap.importance ?? 'NORMAL',
    recurrence_rule: ap.recurrence_rule ?? null,
    memo: ap.memo ?? null,
    exception_kind: null,
    created_at: db.now.toISOString(),
  });
  const participantId = db.newId();
  db.rows('appointment_participants').push({
    participant_id: participantId,
    appointment_id: appointmentId,
    user_id: ap.creator_id,
    origin_name: pt.origin_name ?? null,
    origin_lat: pt.origin_lat ?? null,
    origin_lng: pt.origin_lng ?? null,
    transport_type: pt.transport_type ?? 'TRANSIT',
    est_travel_minutes: pt.est_travel_minutes ?? null,
    travel_source: pt.travel_source ?? 'API',
    prepare_minutes: pt.prepare_minutes ?? 60,
    buffer_minutes: pt.buffer_minutes ?? 10,
    actual_travel_minutes: null,
    departed_at: null,
    arrived_at: null,
  });
  for (const a of alarms) {
    db.rows('alarms').push({
      ...DEFAULTS.alarms,
      alarm_id: db.newId(),
      user_id: ap.creator_id,
      participant_id: participantId,
      alarm_type: a.alarm_type,
      scheduled_at: a.scheduled_at,
      intensity: a.intensity ?? 'NORMAL',
      voice_tone: a.voice_tone ?? 'NEUTRAL',
      sound_key: a.sound_key ?? null,
      is_enabled: a.is_enabled ?? true,
      time_source: a.time_source ?? 'AUTO',
      intensity_source: a.intensity_source ?? 'AUTO',
      last_calculated_at: a.last_calculated_at ?? db.now.toISOString(),
    });
  }
  for (const i of items) {
    const title = (text(i.title) ?? '').trim().slice(0, 100);
    if (!title) continue;
    db.rows('todos').push({ todo_id: db.newId(), user_id: ap.creator_id, appointment_id: appointmentId, title, todo_type: 'ITEM', due_date: i.due_date ?? ap.occurrence_on, is_done: false });
  }
  return appointmentId;
}

// roll_due_series — 같은 조건으로 거르고 급한 순(due_at, user_id, series_id)으로 p_limit개
//   APPOINTMENT: 묶음의 가장 늦은 회차에 규칙이 있고 개인 약속 · 대기 중 아님 · (약속 시각 < 지금 + 14일 또는 재시도 때가 지난 날짜가 있음)
//   STANDALONE: 일정 없는 알람 묶음의 가장 늦은 행에 규칙 · 시각 < 지금 + 14일. ROUTINE: 켜 둔 루틴 · 요일 있음 · 켜진 단계 알람 중 시각이 지난 것
function rollDueSeries(db: FakeDb, args: Record<string, unknown>) {
  const now = args.p_now ? Date.parse(String(args.p_now)) : db.now.getTime();
  const limit = args.p_limit == null ? 50 : Number(args.p_limit);
  const horizon = now + 14 * DAY_MS;
  const utcYesterday = new Date(now - DAY_MS).toISOString().slice(0, 10);
  type Due = { user_id: string; series_id: string; kind: string; template_id: string; due_at: number };
  const due: Due[] = [];

  const at = (r: Row, col: string) => Date.parse(String(r[col]));
  const newest = (rows: Row[], user: string, id: string, atCol: string) => {
    const groups = new Map<string, Row>();
    for (const r of rows) {
      if (r.series_id == null) continue;
      const key = `${r[user]}|${r.series_id}`;
      const cur = groups.get(key);
      const better =
        !cur ||
        String(r.occurrence_on) > String(cur.occurrence_on) ||
        (r.occurrence_on === cur.occurrence_on && (at(r, atCol) > at(cur, atCol) || (at(r, atCol) === at(cur, atCol) && String(r[id]) < String(cur[id]))));
      if (better) groups.set(key, r);
    }
    return [...groups.values()];
  };

  const attempts = db.rows('roll_attempts').filter((a) => a.skipped !== true);
  const pendingOf = (user: unknown, series: unknown) => {
    const mine = attempts.filter((a) => a.user_id === user && a.series_id === series);
    return {
      waiting: mine.some((a) => at(a, 'next_try_at') > now),
      retryDue: mine.some((a) => at(a, 'next_try_at') <= now && String(a.occurrence_on) >= utcYesterday),
    };
  };

  // 기준 회차(template_id · 규칙 · 공동 약속)는 예외 아닌 행 중 가장 늦은 것 → 없으면 EDITED 중 가장 늦은 것, CANCELED는 기준이 아님 (20261030150000_appointment_edit.sql의 base_appointment)
  //   다음 회차 시각(due_at)을 세는 기준은 예외까지 포함한 가장 늦은 행
  const baseOf = (latest: Row): Row | undefined => {
    const mine = db.rows('appointments').filter((x) => x.creator_id === latest.creator_id && x.series_id === latest.series_id && x.exception_kind !== 'CANCELED');
    const rank = (x: Row) => (x.exception_kind == null ? 0 : 1);
    return [...mine].sort(
      (x, y) =>
        rank(x) - rank(y) ||
        (String(x.occurrence_on) < String(y.occurrence_on) ? 1 : String(x.occurrence_on) > String(y.occurrence_on) ? -1 : 0) ||
        at(y, 'appointment_at') - at(x, 'appointment_at') ||
        (String(x.appointment_id) < String(y.appointment_id) ? -1 : 1),
    )[0];
  };
  for (const a of newest(db.rows('appointments'), 'creator_id', 'appointment_id', 'appointment_at')) {
    const base = baseOf(a);
    if (!base || base.recurrence_rule == null || base.group_id != null) continue;
    const p = pendingOf(a.creator_id, a.series_id);
    const when = at(a, 'appointment_at');
    if (p.waiting || !(when < horizon || p.retryDue)) continue;
    due.push({ user_id: String(a.creator_id), series_id: String(a.series_id), kind: 'APPOINTMENT', template_id: String(base.appointment_id), due_at: when });
  }
  for (const s of newest(db.rows('alarms').filter((r) => r.participant_id == null && r.routine_id == null), 'user_id', 'alarm_id', 'scheduled_at')) {
    const when = at(s, 'scheduled_at');
    if (s.recurrence_rule == null || !(when < horizon)) continue;
    due.push({ user_id: String(s.user_id), series_id: String(s.series_id), kind: 'STANDALONE', template_id: String(s.alarm_id), due_at: when });
  }
  for (const r of db.rows('routines')) {
    if (r.is_active !== true || !String(r.repeat_days ?? '').trim()) continue;
    const past = db.rows('alarms').filter((a) => a.routine_id === r.routine_id && a.is_enabled === true && at(a, 'scheduled_at') < now);
    if (!past.length) continue;
    due.push({ user_id: String(r.user_id), series_id: String(r.routine_id), kind: 'ROUTINE', template_id: String(r.routine_id), due_at: Math.min(...past.map((a) => at(a, 'scheduled_at'))) });
  }

  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  due.sort((x, y) => x.due_at - y.due_at || cmp(x.user_id, y.user_id) || cmp(x.series_id, y.series_id));
  return due.slice(0, limit).map(({ due_at: _dueAt, ...row }) => row);
}
