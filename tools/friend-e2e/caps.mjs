// 지금 로컬 DB에 뭐가 있는지 읽기 — PostgREST 루트(OpenAPI)에서 표 · 칼럼 · 함수 이름을 가져옴
// 기능이 아직 없으면 그 단계를 SKIP하는 근거로 씀 (장 PR이 머지돼 DB가 바뀌면 다음 실행부터 자동으로 FAIL / PASS로 바뀜)
export async function readCaps(url, serviceKey) {
  const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!res.ok) throw new Error(`로컬 DB 구조를 못 읽음 (${res.status}) — 로컬 스택이 떠 있나요? (npx supabase start)`);
  return capsFromOpenApi(await res.json());
}

export function capsFromOpenApi(doc) {
  const tables = new Set();
  const rpcs = new Set();
  for (const p of Object.keys(doc.paths ?? {})) {
    if (p.startsWith('/rpc/')) rpcs.add(p.slice(5));
    else if (p !== '/') tables.add(p.slice(1));
  }
  const cols = new Map();
  for (const [t, def] of Object.entries(doc.definitions ?? {})) cols.set(t, new Set(Object.keys(def.properties ?? {})));
  return {
    tables,
    rpcs,
    hasTable: (t) => tables.has(t),
    hasCol: (t, c) => cols.get(t)?.has(c) ?? false,
    hasRpc: (r) => rpcs.has(r),
  };
}
