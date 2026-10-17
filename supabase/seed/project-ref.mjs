// 시드가 넣을 프로젝트 확인 — SUPABASE_URL의 프로젝트 ref가 .env의 SEED_PROJECT_REF와 같은지
//   서비스 키로 RLS를 건너뛰어 쓰고 계정까지 지우므로, 다른 프로젝트의 URL · 키를 .env에 둔 채 실행하는 실수를 막음 (#100 "dev ref 확인")
//   SEED_PROJECT_REF가 비어 있으면 확인하지 않음 (프로젝트를 보여 주고 --yes를 받는 것만)

// https://<ref>.supabase.co → <ref>
export function projectRef(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`SUPABASE_URL이 주소 모양이 아니에요: ${url}`);
  }
  return host.split('.')[0];
}

// expected(SEED_PROJECT_REF)가 있으면 URL의 ref와 같아야 하고, 다르면 던짐. 없거나 비어 있으면 확인 안 함
export function checkProjectRef(url, expected) {
  const ref = projectRef(url);
  const want = (expected ?? '').trim().toLowerCase();
  if (!want) return { ref, checked: false };
  if (ref.toLowerCase() !== want) {
    throw new Error(
      `SUPABASE_URL의 프로젝트(${ref})가 SEED_PROJECT_REF(${want})와 달라서 멈췄어요. 다른 프로젝트의 주소 · 키를 .env에 둔 건 아닌지 확인해 주세요 (SEED_PROJECT_REF에는 주소의 앞부분 ref만 적어요)`,
    );
  }
  return { ref, checked: true };
}
