// 아이디 바꾸기 결과를 화면 문구로 — 순수 함수 (시험: __tests__/handle.test.ts, 시험케이스 2-04 · 2-07 · 2-25 · 2-50)
import { parseDbTime } from '@/lib/dbTime';
import { dateParts, formatWait, spokenTime } from '@/lib/format';

// change_my_handle 결과 — SAME = 지금 아이디와 같음(바뀐 것 없음)
export type HandleChange =
  | { status: 'OK'; handle: string; nextChangeAt: Date | null }
  | { status: 'SAME' }
  | { status: 'INVALID' }
  | { status: 'RESERVED' }
  | { status: 'TAKEN' }
  | { status: 'LIMIT'; nextChangeAt: Date } // 30일에 1번
  | { status: 'BUSY'; retryAfterSeconds: number }; // 검색과 같은 1분 10회 · 하루 100회에 걸림 (바꾸기 시도도 셈)

// "12월 1일 오후 11시" — 한국 시간, 분이 0이 아니면 분까지
export function nextChangeLabel(at: Date): string {
  const { month, day } = dateParts(at);
  return `${month}월 ${day}일 ${spokenTime(at)}`;
}

// 저장하지 못한 이유 한 줄. 바뀌었거나(OK) 그대로(SAME)면 null
export function handleChangeMessage(result: HandleChange): string | null {
  switch (result.status) {
    case 'TAKEN':
      return '이미 있는 아이디예요';
    case 'INVALID':
      return '영문 소문자 · 숫자 · _ 3~20자로 써 주세요';
    case 'RESERVED':
      return '쓸 수 없는 아이디예요'; // respec_로 시작 · 예약어 10개
    case 'LIMIT':
      return `${nextChangeLabel(result.nextChangeAt)}부터 바꿀 수 있어요`;
    case 'BUSY':
      return `잠시 뒤 다시 해 주세요(${formatWait(result.retryAfterSeconds)})`;
    default:
      return null;
  }
}

// 아이디 줄 · 바꾸기 시트의 안내 — highlight = '바꿔 보세요' 강조(자동 아이디), locked = 지금은 못 바꿈
export function handleHint(
  profile: { changedAt: string | null; nextChangeAt: string | null },
  now: Date,
): { highlight: boolean; text: string; locked: boolean } {
  if (!profile.changedAt) {
    return { highlight: true, text: '지금은 자동으로 만든 아이디예요. 처음 바꾸는 건 30일 제한에 안 세요', locked: false };
  }
  const next = profile.nextChangeAt ? parseDbTime(profile.nextChangeAt) : null;
  if (next && next.getTime() > now.getTime()) return { highlight: false, text: `${nextChangeLabel(next)}부터 바꿀 수 있어요`, locked: true };
  return { highlight: false, text: '지금 바꿀 수 있어요', locked: false };
}
