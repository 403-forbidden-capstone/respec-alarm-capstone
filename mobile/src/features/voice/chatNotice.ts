// AI 대화 안내(ChatNotice)의 문구 · 버튼 구성 — 부품과 시험이 같은 함수를 씀

// failed = AI가 지금 답하지 못함 · busy = 분당 사용량(요청이 몰림, 잠시 뒤 다시) · limit = 하루 사용량에 닿음 · turn = 이 대화가 길어 말 상한에 닿음
export type NoticeKind = 'failed' | 'busy' | 'limit' | 'turn';
export type NoticeAction = 'retry' | 'manual' | 'done';

const DONE_LINE = '마치면 지금까지의 이야기로 하루 기록을 만들어요';

// 문구는 여기 한 곳에서 (밤 화면이라 차분하게, 기술 단어 · 자책 없이). body의 줄바꿈은 그대로 두 줄로 그림
export function noticeCopy(kind: NoticeKind): { title: string; body: string } {
  if (kind === 'failed') return { title: 'AI가 지금 답하지 못해요', body: '내가 한 말은 그대로 있어요. 잠시 뒤에 다시 해 보세요' };
  if (kind === 'busy') return { title: '지금 AI 요청이 몰렸어요', body: '내가 한 말은 그대로 있어요. 1분쯤 뒤에 다시 해 보세요' };
  if (kind === 'turn') return { title: '오늘 대화가 길어져서 여기까지예요', body: `이 대화에서 보낼 수 있는 말을 다 썼어요. 내일 새 대화에서 이어가요\n${DONE_LINE}` };
  return { title: '오늘 AI 대화는 여기까지예요', body: `오늘 쓸 수 있는 AI 사용량을 다 썼어요. 지금까지 나눈 이야기는 그대로 남아 있고, 내일 또 이야기해요\n${DONE_LINE}` };
}

const retryable = (kind: NoticeKind) => kind === 'failed' || kind === 'busy';

// 1차 행동 — 진한 버튼 하나. 다시 해 볼 수 있으면 다시 시도, 한도면 대화 마치기
export function primaryAction(kind: NoticeKind): NoticeAction {
  return retryable(kind) ? 'retry' : 'done';
}

// 보여 줄 버튼을 순서대로 — 1차가 맨 앞, 그다음 보조. 콜백이 없는 버튼은 뺌, 한도(limit · turn)에는 다시 시도가 없음
export function noticeActions(kind: NoticeKind, has: { hasRetry?: boolean; hasManual?: boolean; hasDone?: boolean }): NoticeAction[] {
  const order: NoticeAction[] = retryable(kind) ? ['retry', 'manual', 'done'] : ['done', 'manual'];
  const available: Record<NoticeAction, boolean> = { retry: !!has.hasRetry, manual: !!has.hasManual, done: !!has.hasDone };
  return order.filter((key) => available[key]);
}
