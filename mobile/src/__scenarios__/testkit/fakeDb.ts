// 시나리오 시험용 가짜 서버 — 표마다 메모리 저장소를 두고 supabase 클라이언트처럼 답함
//   앱이 무엇을 썼나(writes) · 무엇을 읽었나(reads) · 어떤 서버 함수 · RPC를 불렀나를 기록하는 것이 목적
//   서버 쪽 규칙(트리거 · RPC 계산 · RLS)은 흉내 내지 않음 — 서버 계산은 supabase/tests의 서버 쪽 시나리오가 따로 봄.
//   그래서 "출발 기록이 들어오면 서버가 신호를 보낸다" 같은 효과는 시나리오가 시드를 직접 바꿔서 만듦
//   쿼리 줄 기록은 features/alarm/testkit/fakeSupabase(fakeBuilder)를 그대로 씀 — 기존 시험과 같은 방식
import { fakeBuilder, type FakeCall, type FakeResult } from '@/features/alarm/testkit/fakeSupabase';

export type Row = Record<string, unknown>;

export type WriteLog = { table: string; op: 'insert' | 'update' | 'upsert' | 'delete'; payload: unknown; matched: number; filters: FakeCall['filters']; at: number };
export type ReadLog = { table: string; columns?: string; filters: FakeCall['filters'] };
export type RpcLog = { name: string; args: unknown };
export type EdgeLog = { name: string; body: unknown };

// 표가 서로 가리키는 관계 — select 글자의 임베드(예: appointment_participants(appointments(title)))를 펼칠 때만 씀
type Relation = { table: string; local: string; remote: string; many?: boolean };
const RELATIONS: Record<string, Record<string, Relation>> = {
  alarms: {
    appointment_participants: { table: 'appointment_participants', local: 'participant_id', remote: 'participant_id' },
    routines: { table: 'routines', local: 'routine_id', remote: 'routine_id' },
  },
  appointment_participants: {
    appointments: { table: 'appointments', local: 'appointment_id', remote: 'appointment_id' },
    alarms: { table: 'alarms', local: 'participant_id', remote: 'participant_id', many: true },
  },
  appointments: { groups: { table: 'groups', local: 'group_id', remote: 'group_id' } },
  alarm_events: { alarms: { table: 'alarms', local: 'alarm_id', remote: 'alarm_id' } },
};

// 겹침(유일 키) — insert가 겹치면 23505, upsert는 이 키로 같은 줄을 찾음
const UNIQUE_KEYS: Record<string, string[]> = {
  alarm_events: ['client_event_id'],
  daily_records: ['user_id', 'record_date'],
};

type Node = { embeds: { name: string; inner: boolean; node: Node }[] };

// select 글자에서 임베드 이름만 뽑아 트리로 — 칸 이름은 안 봄 (가짜는 줄 전체를 돌려줌)
function parseSelect(text: string): Node {
  let i = 0;
  const walk = (): Node => {
    const node: Node = { embeds: [] };
    let token = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '(') {
        i += 1;
        const inner = token.includes('!inner');
        const name = token.split('!')[0].split(':').pop()!.trim();
        node.embeds.push({ name, inner, node: walk() });
        token = '';
      } else if (ch === ')') {
        i += 1;
        return node;
      } else if (ch === ',') {
        token = '';
        i += 1;
      } else {
        token += ch;
        i += 1;
      }
    }
    return node;
  };
  return walk();
}

const pathValue = (row: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) => (value == null ? value : (value as Row)[key]), row);

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function passes(row: Row, [method, ...args]: FakeCall['filters'][number]): boolean {
  const [col, val] = args as [string, unknown];
  const value = pathValue(row, col);
  switch (method) {
    case 'eq':
      // 시각 글자는 모양이 달라도(Z · +00:00) 같은 순간이면 같음
      return value === val || (typeof value === 'string' && typeof val === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && /^\d{4}-\d\d-\d\dT/.test(val) && Date.parse(value) === Date.parse(val));
    case 'neq':
      return value !== val;
    case 'in':
      return (val as unknown[]).includes(value);
    case 'is':
      return val === null ? value == null : value === val;
    case 'not': {
      const [, op, operand] = args as [string, string, unknown];
      if (op === 'is') return operand === null ? value != null : value !== operand;
      if (op === 'eq') return value !== operand;
      return true;
    }
    case 'gt':
      return value != null && compare(value, val) > 0;
    case 'gte':
      return value != null && compare(value, val) >= 0;
    case 'lt':
      return value != null && compare(value, val) < 0;
    case 'lte':
      return value != null && compare(value, val) <= 0;
    default:
      return true; // order · limit · or(참조 표 조건)은 따로 처리하거나 거르지 않음
  }
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  writes: WriteLog[] = [];
  reads: ReadLog[] = [];
  rpcs: RpcLog[] = [];
  edges: EdgeLog[] = [];
  userId: string | null = null;
  offline = false;
  rpcHandlers: Record<string, (args: unknown) => FakeResult> = {};
  edgeHandlers: Record<string, (body: unknown) => unknown> = {};
  // 시계 — 쓰기 기록에 시각을 남김 (시나리오가 시계를 옮기면 따라감)
  clock: () => number = () => Date.now();
  private serial = 0;

  reset() {
    this.tables = {};
    this.writes = [];
    this.reads = [];
    this.rpcs = [];
    this.edges = [];
    this.userId = null;
    this.offline = false;
    this.rpcHandlers = {};
    this.edgeHandlers = {};
    this.serial = 0;
  }

  seed(table: string, rows: Row[]) {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((row) => ({ ...row }))];
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  // 시나리오가 서버 쪽 변화(다른 사람이 바꿈 · 트리거 효과)를 만들 때 — 쓰기 기록에는 안 남김
  patch(table: string, where: Row, patch: Row): number {
    let n = 0;
    for (const row of this.rows(table)) {
      if (Object.entries(where).every(([k, v]) => row[k] === v)) {
        Object.assign(row, patch);
        n += 1;
      }
    }
    return n;
  }

  remove(table: string, where: Row): number {
    const keep = this.rows(table).filter((row) => !Object.entries(where).every(([k, v]) => row[k] === v));
    const n = this.rows(table).length - keep.length;
    this.tables[table] = keep;
    return n;
  }

  // 폰 네이티브가 앱 없이 서버에 직접 쓴 것(DeviceUpload) — 앱이 쓴 것과 구분해 기록
  nativeWrites: WriteLog[] = [];
  nativeInsert(table: string, row: Row) {
    const key = UNIQUE_KEYS[table];
    if (key && this.rows(table).some((r) => key.every((k) => r[k] === row[k]))) return; // 같은 번호는 무시 (upsert ignoreDuplicates)
    this.tables[table] = [...this.rows(table), { ...row }];
    this.nativeWrites.push({ table, op: 'insert', payload: row, matched: 1, filters: [], at: this.clock() });
  }

  from(table: string) {
    return fakeBuilder(table, (call) => this.execute(call));
  }

  rpc(name: string, args?: unknown) {
    const run = (): Promise<FakeResult> => {
      this.rpcs.push({ name, args });
      if (this.offline) return Promise.resolve({ data: null, error: { code: '', message: 'Network request failed' } });
      return Promise.resolve({ data: null, error: null, ...(this.rpcHandlers[name]?.(args) ?? {}) });
    };
    return { then: (resolve: (v: FakeResult) => unknown, reject?: (r: unknown) => unknown) => run().then(resolve, reject) };
  }

  async callEdge(name: string, body: unknown): Promise<unknown> {
    this.edges.push({ name, body });
    if (this.offline) throw Object.assign(new Error('NETWORK'), { code: 'NETWORK' });
    const handler = this.edgeHandlers[name];
    if (handler) return handler(body);
    if (name === 'alarm-roll') return { created: [], ring_packages: [] };
    if (name === 'alarm-briefing') return { enabled: false, gemini: 'NOT_NEEDED', rule: null, clips: [], audio: [] };
    throw Object.assign(new Error(`서버 함수 ${name} 답이 정해지지 않음`), { code: 'UNKNOWN' });
  }

  private resolveEmbeds(row: Row, table: string, node: Node): Row | null {
    const out: Row = { ...row };
    for (const embed of node.embeds) {
      const relation = RELATIONS[table]?.[embed.name];
      if (!relation) continue;
      const matches = this.rows(relation.table).filter((r) => r[relation.remote] === row[relation.local] && row[relation.local] != null);
      const resolved = matches.map((m) => this.resolveEmbeds(m, relation.table, embed.node)).filter((m): m is Row => m != null);
      if (relation.many) out[embed.name] = resolved;
      else out[embed.name] = resolved[0] ?? null;
      if (embed.inner && (relation.many ? resolved.length === 0 : resolved.length === 0)) return null;
    }
    return out;
  }

  private execute(call: FakeCall): FakeResult {
    if (this.offline) return { data: null, error: { code: '', message: 'Network request failed' } };
    const filters = call.filters.filter(([m]) => m !== 'order' && m !== 'limit');
    const matches = (row: Row) => filters.every((f) => passes(row, f));
    const table = this.rows(call.table);

    if (call.op === 'select') {
      this.reads.push({ table: call.table, columns: call.columns, filters: call.filters });
      const node = parseSelect(call.columns ?? '');
      let rows = table.map((row) => this.resolveEmbeds(row, call.table, node)).filter((row): row is Row => row != null && matches(row));
      for (const [method, col, opt] of call.filters) {
        if (method === 'order') {
          const asc = (opt as { ascending?: boolean } | undefined)?.ascending !== false;
          rows = [...rows].sort((a, b) => (asc ? 1 : -1) * compare(pathValue(a, col as string), pathValue(b, col as string)));
        }
      }
      const limit = call.filters.find(([m]) => m === 'limit')?.[1] as number | undefined;
      if (limit != null) rows = rows.slice(0, limit);
      return { data: call.single ? (rows[0] ?? null) : rows, error: null };
    }

    const log = (matched: number) => this.writes.push({ table: call.table, op: call.op as WriteLog['op'], payload: call.payload, matched, filters: call.filters, at: this.clock() });
    const withId = (row: Row): Row => {
      const copy = { ...row };
      this.serial += 1;
      if (copy[`${call.table}_id`] === undefined && copy.id === undefined) copy._rowid = this.serial;
      return copy;
    };
    const returning = (rows: Row[]): FakeResult => ({ data: call.columns !== undefined ? (call.single ? (rows[0] ?? null) : rows) : null, error: null });
    const key = UNIQUE_KEYS[call.table];

    if (call.op === 'insert') {
      const incoming = (Array.isArray(call.payload) ? call.payload : [call.payload]) as Row[];
      for (const row of incoming) {
        if (key && table.some((r) => key.every((k) => r[k] === row[k]))) {
          log(0);
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
      }
      const added = incoming.map(withId);
      this.tables[call.table] = [...table, ...added];
      log(added.length);
      return returning(added);
    }
    if (call.op === 'upsert') {
      const incoming = (Array.isArray(call.payload) ? call.payload : [call.payload]) as Row[];
      const onConflict = (call.options as { onConflict?: string; ignoreDuplicates?: boolean } | undefined)?.onConflict;
      const ignore = (call.options as { ignoreDuplicates?: boolean } | undefined)?.ignoreDuplicates === true;
      const cols = onConflict ? onConflict.split(',').map((s) => s.trim()) : (key ?? []);
      const written: Row[] = [];
      for (const row of incoming) {
        const existing = cols.length ? this.rows(call.table).find((r) => cols.every((k) => r[k] === row[k])) : undefined;
        if (existing) {
          if (!ignore) {
            Object.assign(existing, row);
            written.push(existing);
          }
        } else {
          const added = withId(row);
          this.tables[call.table] = [...this.rows(call.table), added];
          written.push(added);
        }
      }
      log(written.length);
      return returning(written);
    }
    if (call.op === 'update') {
      const hit = table.filter(matches);
      for (const row of hit) Object.assign(row, call.payload as Row);
      log(hit.length);
      return returning(hit);
    }
    // delete
    const hit = table.filter(matches);
    this.tables[call.table] = table.filter((r) => !hit.includes(r));
    log(hit.length);
    return returning(hit);
  }
}

export const db = new FakeDb();
