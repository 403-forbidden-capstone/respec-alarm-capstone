// 시험용 가짜 supabase 클라이언트 — 쿼리 빌더의 모양(어느 표에 무엇을 어떤 조건으로 읽고 썼는지)만 기록하고, 답은 시험이 정해 줌
//   진짜 PostgREST의 동작(RLS · 임베드)은 흉내 내지 않음 — 쿼리 순서 · 조건 · 쓰는 값을 확인하는 용도 (칸 이름 오타는 tsc가 잡음)
export type Result = { data: unknown; error: unknown };
export type Op = {
  table: string;
  kind: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  columns?: string;
  payload?: unknown;
  options?: unknown;
  filters: [string, string, unknown][]; // [연산, 칸, 값]
  returning: boolean; // 쓴 뒤 .select()로 행을 돌려받는지
  single?: 'single' | 'maybeSingle';
};

export function createFake() {
  const ops: Op[] = [];
  const rpcCalls: { name: string; args: unknown }[] = [];
  // 표마다 답: `${표}.${select|insert|update|upsert|delete}`. 함수면 그 쓰기/읽기를 보고 정함. 없으면 빈 읽기
  const answers = new Map<string, Result | ((op: Op) => Result)>();
  const rpcAnswers = new Map<string, Result | ((args: unknown) => Result)>();

  class Builder implements PromiseLike<Result> {
    readonly op: Op;
    constructor(table: string) {
      this.op = { table, kind: 'select', filters: [], returning: false };
      ops.push(this.op);
    }
    select(columns?: string) {
      if (this.op.kind === 'select') this.op.columns = columns;
      else this.op.returning = true;
      return this;
    }
    insert(payload: unknown) {
      this.op.kind = 'insert';
      this.op.payload = payload;
      return this;
    }
    update(payload: unknown) {
      this.op.kind = 'update';
      this.op.payload = payload;
      return this;
    }
    upsert(payload: unknown, options?: unknown) {
      this.op.kind = 'upsert';
      this.op.payload = payload;
      this.op.options = options;
      return this;
    }
    delete() {
      this.op.kind = 'delete';
      return this;
    }
    eq(column: string, value: unknown) {
      this.op.filters.push(['eq', column, value]);
      return this;
    }
    in(column: string, value: unknown) {
      this.op.filters.push(['in', column, value]);
      return this;
    }
    gte(column: string, value: unknown) {
      this.op.filters.push(['gte', column, value]);
      return this;
    }
    lt(column: string, value: unknown) {
      this.op.filters.push(['lt', column, value]);
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    single() {
      this.op.single = 'single';
      return this;
    }
    maybeSingle() {
      this.op.single = 'maybeSingle';
      return this;
    }
    then<A = Result, B = never>(onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null) {
      const answer = answers.get(`${this.op.table}.${this.op.kind}`);
      const result: Result = typeof answer === 'function' ? answer(this.op) : (answer ?? { data: this.op.kind === 'select' ? [] : null, error: null });
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
  }

  const client = {
    from: (table: string) => new Builder(table),
    rpc: (name: string, args?: unknown) => {
      rpcCalls.push({ name, args });
      const answer = rpcAnswers.get(name);
      const result: Result = typeof answer === 'function' ? answer(args) : (answer ?? { data: [], error: null });
      return Promise.resolve(result);
    },
  };

  return {
    client,
    ops,
    rpcCalls,
    answer: (key: string, value: Result | ((op: Op) => Result)) => answers.set(key, value),
    answerRpc: (name: string, value: Result | ((args: unknown) => Result)) => rpcAnswers.set(name, value),
    reset: () => {
      ops.length = 0;
      rpcCalls.length = 0;
      answers.clear();
      rpcAnswers.clear();
    },
    opsOf: (table: string, kind?: Op['kind']) => ops.filter((o) => o.table === table && (kind == null || o.kind === kind)),
  };
}
