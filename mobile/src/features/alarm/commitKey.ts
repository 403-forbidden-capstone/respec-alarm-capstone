// alarm-commit 요청 키(Idempotency-Key) — "같은 요청 본문"마다 하나 (정할 일 0-10)
//   응답을 잃은 채(시간 초과 · 끊김) 같은 저장을 다시 누르면 같은 키로 다시 보냄 → 서버가 첫 결과를 그대로 돌려줘 약속 · 알람이 두 벌 생기지 않음
//   · 키는 요청 본문(JSON 글자)으로 찾음. 같은 본문이고 10분 안이면 같은 키, 본문이 바뀌었거나 10분이 지났으면 새 키
//   · 저장이 성공하면 지움 (다음 같은 본문은 새 저장 — 예: 같은 값으로 다시 저장해도 새 요청)
//   · 메모리에만 둠 (앱을 닫으면 사라짐 — 응답을 잃은 직후 다시 누르는 경우만 막으면 됨)
import { makeUuid } from '@capstone/alarm-core';

export const COMMIT_KEY_TTL_MS = 10 * 60_000;
const MAX_KEYS = 50; // 실패만 쌓이는 경우의 상한 (오래된 것부터 버림)

const keys = new Map<string, { key: string; at: number }>();

const bodyId = (body: unknown) => JSON.stringify(body);

// 이 본문에 쓸 키 — 10분 안에 같은 본문으로 만든 키가 있으면 그것(만든 시각은 그대로 둠 — 실패를 되풀이해도 10분 뒤엔 새 키)
export function commitKeyFor(body: unknown, atMs: number): string {
  const id = bodyId(body);
  const saved = keys.get(id);
  if (saved && atMs - saved.at < COMMIT_KEY_TTL_MS) return saved.key;
  const key = makeUuid();
  keys.delete(id);
  keys.set(id, { key, at: atMs });
  if (keys.size > MAX_KEYS) keys.delete(keys.keys().next().value as string);
  return key;
}

// 저장이 성공한 뒤 그 본문의 키를 지움
export function forgetCommitKey(body: unknown): void {
  keys.delete(bodyId(body));
}

export function clearCommitKeys(): void {
  keys.clear();
}
