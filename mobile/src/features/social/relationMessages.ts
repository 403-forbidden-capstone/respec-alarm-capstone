// 친구 관계 서버 함수가 돌려주는 상태 → 문구 (친구_논리설계.md 3장, 시험: __tests__/relations.test.ts)
import { formatWait } from '@/lib/format';

// 상대가 그 사이 취소 · 거절했거나 이미 처리됨 — 화면은 이 문구와 함께 목록을 새로 고침 (3-28)
export const MESSAGE_GONE = '이미 처리됐을 수 있어요';
// 어느 쪽이든 친구 100명 (3-12) — 요청 · 수락 둘 다 같은 문구
export const MESSAGE_FRIEND_LIMIT = '친구는 100명까지 만들 수 있어요';

export const messageLimit = (retryAfterSeconds: number) => `잠시 뒤 다시 해 주세요(${formatWait(retryAfterSeconds)})`;
