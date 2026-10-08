// 사용자에게 그대로 보여 줄 오류 — api.ts가 이유를 해요체 한국어로 던질 때만 씀
// 그 밖의 오류(네트워크 · DB 원문 · 내부 칼럼 이름이 든 문구)는 화면이 기본 문구로 바꿔 보여 줌
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

// 토스트에 쓸 문구 — UserError면 그 이유, 아니면 기본 문구
export function userMessage(e: unknown, fallback = '하지 못했어요. 다시 해 주세요'): string {
  return e instanceof UserError ? e.message : fallback;
}
