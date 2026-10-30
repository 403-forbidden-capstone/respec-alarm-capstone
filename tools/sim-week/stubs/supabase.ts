// '@/lib/supabase' 껍데기 — 앱 파일의 순수 함수만 Node에서 부르려고 loader.mjs 가 대신 끼움.
// 이 클라이언트를 쓰면(= DB를 부르는 함수를 불렀다면) 바로 던짐. 시험 하네스는 DB 없이 돌아야 하므로.
const fail = (path: string): never => {
  throw new Error(`sim-week: 앱의 DB 호출(supabase${path})은 하네스에서 못 부름 — 순수 함수만 부를 것`);
};

function chain(path: string): unknown {
  return new Proxy(function () {}, {
    get: (_t, prop) => chain(`${path}.${String(prop)}`),
    apply: () => fail(path),
  });
}

export const supabase = chain('') as never;
