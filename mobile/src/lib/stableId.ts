// 같은 입력이면 늘 같은 UUID 모양 글자 — 쓰기가 중간에 끊겨 다시 시도해도 같은 번호가 되게 (서버가 같은 번호의 기록을 무시하는 client_event_id 등)
//   무작위 번호(AlarmCore.makeUuid)와 달리 "그 알람의 그 해제 같은 일"로 정해지므로, 두 번 쓰려 해도 한 줄만 남음
//   암호용이 아님 — 32비트 해시 네 개를 이어 붙인 128비트라 서로 다른 입력이 겹칠 일이 사실상 없는 정도면 충분

// FNV-1a 뒤에 마무리 섞기(murmur3 finalizer). seed가 다르면 같은 글자도 다른 값
function hash32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

const SEEDS = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d] as const;

// 입력 조각들(글자 · 숫자)로 UUID를 만듦. 조각 사이는 JSON으로 구분해 ('ab','c')와 ('a','bc')가 달라짐
export function stableUuid(...parts: readonly (string | number)[]): string {
  const text = JSON.stringify(parts);
  const hex = SEEDS.map((seed) => hash32(text, seed).toString(16).padStart(8, '0')).join('');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16); // 8 · 9 · a · b
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
