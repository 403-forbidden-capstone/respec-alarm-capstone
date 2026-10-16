// 서비스 키 확인 — 배치(pg_cron → pg_net)나 서버끼리 부르는 함수(wake-check)가 호출한 쪽이 서비스 키를 가졌는지 봄
// 키 형식이 둘이라 둘 다 받음 (supabase/README.md "배치", pr_P3 "키 형식"):
//   · legacy service_role JWT (eyJ…) — SUPABASE_SERVICE_ROLE_KEY
//   · 새 secret 키 (sb_secret_…) — SUPABASE_SECRET_KEYS (이름 → 키 JSON 사전)
// 배치는 Authorization: Bearer 와 apikey 머리글 둘 다에 키를 싣고, 새 키는 apikey로만 보내는 게 맞음 → 두 머리글을 다 봄
// 순수 TS — node --test로 시험

// {"default": "sb_secret_…"} 같은 JSON 사전에서 값만. 깨졌거나 비었으면 빈 목록
export function parseKeyDictionary(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return Object.values(parsed as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && v.length > 0);
    }
  } catch {
    // JSON이 아니면 단일 키 문자열로 본다
    return [raw];
  }
  return [];
}

// 길이가 같을 때 모든 글자를 끝까지 비교 (일찍 끝나는 비교로 키를 한 글자씩 알아내지 못하게)
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 요청이 실은 키 후보 — apikey 머리글, Authorization: Bearer
export function keyCandidates(headers: Headers): string[] {
  const out: string[] = [];
  const apikey = headers.get('apikey');
  if (apikey) out.push(apikey.trim());
  const auth = headers.get('authorization');
  const match = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  if (match) out.push(match[1].trim());
  return out;
}

export function matchesAnyKey(headers: Headers, validKeys: readonly string[]): boolean {
  const valid = validKeys.filter((k) => k.length > 0);
  if (!valid.length) return false;
  let ok = false;
  for (const candidate of keyCandidates(headers)) {
    for (const key of valid) if (timingSafeEqual(candidate, key)) ok = true;
  }
  return ok;
}
