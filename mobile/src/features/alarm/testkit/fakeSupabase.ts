// 실데이터 시험용 가짜 Supabase 쿼리 빌더 — 쿼리 한 줄(테이블 · 동작 · 거른 조건 · 쓴 값)을 기록하고, 시험이 정한 결과를 돌려줌
// 진짜 PostgREST의 동작(임베드 · 필터 · RLS)은 흉내 내지 않음: 쿼리 모양이 의도대로인지와 쓰는 순서만 확인하고, 행 → 화면 변환은 map.test.ts가 맡음
// (__tests__ 밖에 둔 이유: jest가 그 폴더 안 파일을 시험 파일로 읽음)

export type FakeCall = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: unknown; // insert · update · upsert로 쓴 값
  columns?: string; // select 글자 (update 뒤 select도 포함)
  options?: unknown; // select · upsert 옵션
  filters: [method: string, ...args: unknown[]][];
  single: boolean; // maybeSingle · single
};

export type FakeResult = { data?: unknown; error?: { code?: string | null; message?: string } | null; count?: number | null };
export type FakeHandler = (call: FakeCall) => FakeResult | undefined | Promise<FakeResult | undefined>;

const FILTERS = ['eq', 'neq', 'in', 'is', 'not', 'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'or'] as const;

export function fakeBuilder(table: string, handler: FakeHandler) {
  const call: FakeCall = { table, op: 'select', filters: [], single: false };
  const builder: Record<string, unknown> = {};
  for (const method of FILTERS) {
    builder[method] = (...args: unknown[]) => {
      call.filters.push([method, ...args]);
      return builder;
    };
  }
  builder.select = (columns?: string, options?: unknown) => {
    call.columns = columns;
    if (options !== undefined) call.options = options;
    return builder;
  };
  for (const op of ['insert', 'update', 'upsert', 'delete'] as const) {
    builder[op] = (payload?: unknown, options?: unknown) => {
      call.op = op;
      call.payload = payload;
      if (options !== undefined) call.options = options;
      return builder;
    };
  }
  for (const name of ['maybeSingle', 'single']) {
    builder[name] = () => {
      call.single = true;
      return builder;
    };
  }
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(handler(call)).then((result) => ({ data: null, error: null, ...result }), reject).then(resolve, reject);
  return builder;
}

// 조건 찾기: 쿼리에 걸린 거르기 조건 중 이 메서드 · 첫 인자인 줄의 나머지 인자
export function filterArgs(call: FakeCall, method: string, column: string): unknown[] | undefined {
  return call.filters.find(([m, c]) => m === method && c === column)?.slice(2);
}
