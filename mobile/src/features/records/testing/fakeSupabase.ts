// 시험용 가짜 Supabase 클라이언트 — features/*/real.ts가 어떤 테이블에 어떤 조건으로 읽고 쓰는지(순서 포함)를 확인하는 데 씀
// 앱 코드는 이 파일을 불러오지 않음 (시험만). 쓰는 법:
//   jest.mock('@/lib/supabase', () => ({ supabase: jest.requireActual<typeof import('@/features/records/testing/fakeSupabase')>('@/features/records/testing/fakeSupabase').fakeClient }));
//   import { calls, onCall, resetFake } from '@/features/records/testing/fakeSupabase';
//   onCall((call) => (call.table === 'daily_records' ? { data: [...] } : undefined));  // 돌려줄 값 (안 돌려주면 data null)
// 쿼리 엔진은 아님 — 조건(eq · gte …)은 기록만 하고 돌려줄 값은 시험이 정함. maybeSingle · single이면 배열의 첫 줄
export type FakeCall = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  columns?: string;
  payload?: unknown;
  options?: unknown;
  filters: { method: string; args: unknown[] }[];
  single: boolean;
};
export type FakeReply = { data?: unknown; error?: { code?: string; message: string } | null };

export const calls: FakeCall[] = [];
let reply: (call: FakeCall) => FakeReply | undefined = () => undefined;

export function onCall(handler: (call: FakeCall) => FakeReply | undefined) {
  reply = handler;
}

export function resetFake() {
  calls.length = 0;
  reply = () => undefined;
}

// 조건 이름으로 찾기 — filterOf(call, 'eq', 'user_id') → ['user_id', 'user-1']
export function filterOf(call: FakeCall, method: string, column: string): unknown[] | undefined {
  return call.filters.find((f) => f.method === method && f.args[0] === column)?.args;
}

const FILTERS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'or', 'order', 'limit', 'like', 'ilike'];

function from(table: string) {
  const call: FakeCall = { table, op: 'select', filters: [], single: false };
  let opChosen = false;
  const chain: Record<string, unknown> = {};
  const choose = (op: FakeCall['op'], payload: unknown, options?: unknown) => {
    call.op = op;
    call.payload = payload;
    call.options = options;
    opChosen = true;
    return chain;
  };
  chain.select = (columns?: string) => {
    if (!opChosen) call.op = 'select'; // insert · update 뒤의 select는 "돌려받기"
    call.columns = columns;
    return chain;
  };
  chain.insert = (rows: unknown) => choose('insert', rows);
  chain.update = (values: unknown) => choose('update', values);
  chain.delete = () => choose('delete', undefined);
  chain.upsert = (rows: unknown, options?: unknown) => choose('upsert', rows, options);
  for (const method of FILTERS) {
    chain[method] = (...args: unknown[]) => {
      call.filters.push({ method, args });
      return chain;
    };
  }
  chain.maybeSingle = () => {
    call.single = true;
    return chain;
  };
  chain.single = chain.maybeSingle;
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
    calls.push(call);
    const r = reply(call) ?? {};
    let data = r.data ?? null;
    if (call.single && Array.isArray(data)) data = data[0] ?? null;
    return Promise.resolve({ data, error: r.error ?? null }).then(resolve, reject);
  };
  return chain;
}

export const fakeClient = {
  from,
  auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
};
