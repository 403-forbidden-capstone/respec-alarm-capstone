// ③ 수면 전후 음성 AI — 이 기능에서 쓰는 타입
// 이름은 DB(conversation_sessions)를 따르고, 화면에 바로 쓰기 좋게 모양만 바꿈
import type { AlarmKind, Importance } from '@/features/alarm/types';

// 대화 한 줄 — card = AI가 대화에서 찾은 카드 (내용은 Conversation.cards에서 cardId로 찾음)
export type ChatMessage = {
  id: string;
  who: 'ai' | 'me' | 'card';
  text: string; // card면 빈 글자
  at: Date;
  cardId?: string; // card일 때 — 카드 번호(서버 ref c1 …)
};

// 카드 종류 (서버 voice-turn cards[].kind, 설계 메모 2.2)
//   APPT_NEW = 새 약속 + 알람 · ALARM_EDIT = 있는 약속의 알람 바꾸기 · ALARM_NEW = 약속 없는 알람 · APPT_OPEN = 있는 약속 고치기(일정 열기만)
export type CardKind = 'APPT_NEW' | 'ALARM_EDIT' | 'ALARM_NEW' | 'APPT_OPEN';

// 카드 상태 — 대기(NEEDS_ESTIMATE) → 계산 중(ESTIMATING, 앱 안에서만) → 준비(READY) | 장소 필요(NEEDS_PLACE) | 실패(FAILED) → 저장(SAVED) | 저장 안 함(REJECTED)
export type CardStatus = 'NEEDS_ESTIMATE' | 'ESTIMATING' | 'READY' | 'NEEDS_PLACE' | 'FAILED' | 'SAVED' | 'REJECTED';

// 카드에 보여 줄 알람 한 줄 (계산이 끝난 READY 카드)
export type CardAlarm = { kind: AlarmKind; at: Date; enabled: boolean };

export type ConversationCard = {
  id: string;
  kind: CardKind;
  status: CardStatus;
  firstOfDay: boolean; // 그날 첫 일정 — 알람 줄을 자세히 보임. 아니면 "출발 알림" 한 줄 (D36)
  highlight: boolean; // 말로 "응"이라고 해서 강조 (저장은 아님)
  summary: string; // 서버가 준 한 줄 — 10/30(금) 10:00 캡스톤 발표 · 강남역
  title: string;
  at: Date | null; // 약속 시각 (APPT_NEW) · 알람 시각 (ALARM_NEW)
  place: string;
  importance: Importance | null;
  items: string[]; // 준비물 — 카드와 같이 저장
  alarms: CardAlarm[]; // 계산한 알람 (READY일 때만)
  question: string | null; // 목업: 내일 오후 2시 스터디로 저장할까요?
  error: string | null; // 실패 · 장소 필요 이유 (사용자에게 보일 글)
  appointmentId: string | null; // 저장한 뒤 · 알람 바꾸기 대상
  group: CardGroup | null; // 그룹 · 개인 일정 고르기 (새 일정 카드, 말에 가입한 그룹 이름이 나올 때만). 없으면 개인 일정
};

// 새 일정 카드를 그룹 일정으로 걸지 (서버 types.ts CardGroup) — ASK면 고르기 전이라 저장 안 함. candidates = 고를 수 있는 가입 그룹
export type CardGroup = {
  choice: 'ASK' | 'GROUP' | 'PERSONAL';
  id: string | null;
  candidates: { id: string; name: string }[];
  missing?: string; // 말한 그룹이 가입한 그룹에 없음('가족') — 후보 없이 개인 일정만 고를 수 있음
};

// 남은 대화 한도 — reached가 있으면 오류가 아니라 "오늘 대화는 여기까지"
export type Limits = {
  turnsLeft: number | null;
  sessionsLeftToday: number | null;
  reached: 'TURN' | 'DAY' | null; // TURN = 대화 길이(대화당 말 수), DAY = 하루 사용량(대화 수 · AI 호출 수)
};

// AI가 지금 답하지 못함 — 대화 · 카드는 남기고 [다시 시도] · [직접 일정 만들기]
//   rateLimited = 분당 사용량(요청이 몰림) — 잠시 뒤 다시 하면 됨 (서버 details.code RATE_LIMITED)
// extractFailed = 일정일 수도 있는 말의 추출(T2F)을 못 해 말이 저장되지 않음 — [다시 시도]가 추출부터 다시
export type Unavailable = { code: string; message: string; canRetry: boolean; rateLimited?: boolean; timedOut?: boolean; extractFailed?: boolean };

// 다음 차례 — 내 말(대본 문장, 목업만. 실데이터는 빈 글자) · AI 답 · 못 말함(null)
export type NextTurn = { who: 'me'; text: string } | { who: 'ai' } | null;

export type Conversation = {
  source: 'MOCK' | 'REAL'; // REAL = 서버 대화(텍스트만) — 화면이 말하기 · 완료 동작을 가름
  messages: ChatMessage[];
  next: NextTurn;
  cards: ConversationCard[]; // 카드 여러 장 (D36)
  limits: Limits | null; // 목업은 null
  unavailable: Unavailable | null;
  ask?: string[] | null; // 음성 차례만: 일정에서 아직 모르는 것 (서버 voice-turn ask) — Live가 소리로 되물음
  notice?: TurnNotice | null; // 방금 보낸 말의 일정 추출을 못 함 (서버 voice-turn notice) — 화면이 일정일 수도 있는 말이면 알림
};

export type TurnNotice = 'RATE_LIMITED' | 'EXTRACT_FAILED';

// 대화에서 고친 기록 한 건의 결과 (설계 메모 2.2 fixes → results.fixes) — 앱이 L2 함수로 반영한 뒤 서버에 돌려줌
export type FixResult = { id: string; ok: boolean; error: string | null };
