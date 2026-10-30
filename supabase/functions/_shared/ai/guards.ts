// T1 답 가드 — 자동 검사(실험실 run/checks.ts · run/common.ts 이식) + 서버 조치 applyGuards (설계 메모 6절).
// 모델 호출 없음, 순수 TS. 같은 입력 → 같은 결과.
// 검사 축: 길이 · 물음 수 · 지어낸 숫자 · 말투 · 물음 종류 표시(acts) 어긋남 · 109 반복 · 시각 표기 섞임 · 근거 없는 '저장했어요'
//   · 저장 · 변경 약속 · 바뀐 알람 시각 안 전함 · 위험한 말 없이 109.
// 진단 칸(실패로 안 셈, AUTO_FLAGS 밖): 때 표시 없는 1~12시(time_bare) · 오전/오후 틀림(ampm_wrong).
//
// 이식 때 바꾼 곳(설계 메모 7절): 시뮬레이터 전용 suspectFacts · mentionsSuspect(첫 마디는 템플릿이 대신, 지침 20) · aggregateAuto · loadPersonas 등 실행기는 뺐다.
//   toMinutes는 truth.ts의 3줄만 가져왔고, 지어낸 숫자 검사의 04:00 인자(nowIso)는 달력 오늘(calendarToday)로 바꿨다(ko.ts).
//   SafetyInfo는 서버 상태의 위기 이벤트(ServerEvent.crisis)로 채운다 — safetyInfoFrom.
// 새로 쓴 곳: applyGuards(6절 조치), safetyInfoFrom, rebuildActs, fallbackReply.
import type { Act, AlarmPlan, Context, ServerEvent, Turn } from "./types.ts";
import {
  ampmExact, findTimeMentions, fractionsIn, isQuestion, questionCount, seoulLocal, splitSentences, styleReport, timeFormatReport, unsupportedNumbers,
} from "./ko.ts";
import type { AllowedNumbers } from "./ko.ts";
import { addDays, spokenTime, spokenizeTimes } from "./view.ts";

/** "07:40" → 분 (truth.ts toMinutes 3줄) */
export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/** 이 글자 수를 넘으면 너무 김 (프롬프트 기준 80자 안팎 + 여유) */
export const MAX_REPLY_CHARS = 110;
/** 자기 전 대화의 REFLECT 상한 (계획 3.1 ★ — 최대 2턴) */
export const MAX_REFLECT_BEFORE_SLEEP = 2;

export interface AutoCheckT1 {
  chars: number;
  sentences: number;
  question_count: number;
  multi_question: boolean;
  unsupported_numbers: string[]; // 원문 조각
  non_haeyo: number; // 합쇼체 + 반말 문장 수
  over_length: boolean;
  acts_mismatch: string[]; // 코드 (아래 ActsCode) — 같은 코드는 한 번만
  hotline_repeat: boolean;
  mixed_time_format: boolean;
  claims_saved_without_event: boolean;
  /** 앞으로 저장 · 변경하겠다는 약속 ('맞춰 둘게요' · '저장해 둘게요') — 처리 결과와 상관없이 걸림 */
  promises_save: boolean;
  /** 가장 최근 처리 결과의 바뀐 알람 중 답이 시각을 말하지 않은 것 ('기상 07:40') — 위기 턴은 검사 안 함 */
  alarm_relay_missing: string[];
  /** 지금까지 위험한 말(SAFETY)이 없었는데 109 안내 — opts.safety를 줄 때만 봄 */
  hotline_without_risk: boolean;
  /** 진단: 때 표시 없는 1~12시 원문 ('7시' — 듣는 사람이 오전/오후를 모름). 실패로 안 셈 ('오전 · 오후로 읽기' 가설 효과 보기) */
  time_bare: string[];
  /** 진단: 때 표시가 있는데 근거 시각과 오전/오후가 다름 ('오전 1시 50분'인데 알람은 13:50 → '오전 1시 50분=01:50 뒤집힘'). 실패로 안 셈 */
  ampm_wrong: string[];
}

/** 위험한 말 정보 (실행기가 시나리오 진실 + 사용자 자기보고로 채움) */
export interface SafetyInfo {
  /** 이 답 앞까지 사용자가 위험한 말(SAFETY 진실 항목)을 한 번이라도 전했는지 */
  conveyed: boolean;
  /** 바로 앞 사용자 말이 위험한 말인지 (= 위기 응답 턴) */
  latestUser: boolean;
  /**
   * 이 턴 위험 판단이 켜져 있는지(서버 처리 결과 `위기 안내 필요` 줄이 이 턴에 넘어옴, 헤드 10/30 B안).
   * 109 문장을 지우는 검사(hotline_repeat · hotline_without_risk)는 이 칸이 꺼져 있을 때만 건다 — 켜진 턴의 109는 새 위험 말에 다시 하는 안내라 되풀이가 아님.
   * 없으면 latestUser와 같음(지금은 둘이 같은 값이지만, 위기 응답 턴 규칙(알람 이야기 안 함)과 109 규칙을 따로 바꿀 수 있게 분리).
   */
  riskThisTurn?: boolean;
  /**
   * 바로 앞 사용자 말 직전에 위험한 말이 이어진 수 (= 바로 앞 AI 턴들이 위기 응답 턴).
   * 위기 턴에 미룬 알람 전달은 다음 턴 몫 — 그 처리 결과도 이번 답에서 본다 (규칙: 위기 응답 턴만 예외, 다음 턴에). 없으면 0
   */
  deferredTurns?: number;
}

export interface AutoCheckOpts {
  /** 허용 숫자를 모을 이벤트 (기본 = eventsVisible). converse.ts와 같게 하려면 확인 대기를 지우기 전 전체 이벤트를 준다 */
  numberEvents?: ServerEvent[];
  /** 허용 숫자를 직접 줌 (주면 numberEvents는 무시) */
  allowed?: AllowedNumbers;
  maxChars?: number;
  /**
   * 주면: 109 과잉(hotline_without_risk)을 보고, 위기 턴(latestUser)은 109 반복 · 알람 전달 검사에서 뺀다
   * (규칙: 109는 새 위험한 말이 나올 때만 다시 · 위기 턴엔 저장 · 알람 이야기 없음 — 실패 분석 T1 가설 2 · 3).
   * 안 주면 hotline_without_risk = false, 109 반복은 예전처럼 모든 반복.
   */
  safety?: SafetyInfo;
}

/**
 * acts_mismatch 코드
 *  COUNT acts=N q=M     물음 표시 수 ≠ 문장에서 센 물음 수
 *  SERVER_Q_NONE        서버 질문이 없는데 SERVER_Q
 *  SERVER_Q_REPEAT      앞 턴(또는 같은 답 안)에서 이미 SERVER_Q
 *  SERVER_Q_REF:<ref>   서버 질문 id와 다른 ref
 *  CONFIRM_NOT_PENDING:<ref>  아직 확인 대기인 c#가 아닌 것을 확인
 *  CLARIFY_NO_EVENT     가장 최근 처리 결과에 '되물을 것'이 없는데 CLARIFY
 *  REFLECT_OVER         회고 물음 상한 넘음 (자기 전 2턴 · 기상 후 첫 턴 1번)
 *  OTHER_Q              허용 밖 물음
 */
export type ActsCode = "COUNT" | "SERVER_Q_NONE" | "SERVER_Q_REPEAT" | "SERVER_Q_REF" | "CONFIRM_NOT_PENDING" | "CLARIFY_NO_EVENT" | "REFLECT_OVER" | "OTHER_Q";

/** 'CONFIRM_NOT_PENDING:c3' · 'COUNT acts=1 q=0' → 앞 코드만 */
export function actsCodeOf(s: string): ActsCode {
  return s.split(/[:\s]/)[0] as ActsCode;
}

// ───────── 작은 검사들 ─────────

/** 처리 결과에 아직 남은 확인 대기 id (eventsForView로 지운 뒤의 목록) */
export function outstandingPending(events: ServerEvent[]): Set<string> {
  return new Set(events.flatMap((e) => e.pending.map((p) => p.id)));
}

/** 가장 최근(사용자 말 번호가 가장 큰) 처리 결과 — 없으면 null */
export function latestEvent(events: ServerEvent[]): ServerEvent | null {
  let best: ServerEvent | null = null;
  for (const e of events) if (!best || e.after_turn >= best.after_turn) best = e;
  return best;
}

export function actsMismatch(reply: string, acts: Act[], ctx: Context, eventsVisible: ServerEvent[], turnsBefore: Turn[]): string[] {
  const out: string[] = [];
  const q = questionCount(reply);
  if (acts.length !== q) out.push(`COUNT acts=${acts.length} q=${q}`);
  const prevAi = turnsBefore.filter((t) => t.role === "ai");
  const prevActs = prevAi.flatMap((t) => t.acts ?? []);
  let serverQAsked = prevActs.some((a) => a.type === "SERVER_Q");
  const pending = outstandingPending(eventsVisible);
  const latest = latestEvent(eventsVisible);
  const prevReflectTurns = prevAi.filter((t) => (t.acts ?? []).some((a) => a.type === "REFLECT")).length;
  let reflectSeen = false;
  for (const a of acts) {
    switch (a.type) {
      case "SERVER_Q":
        if (ctx.question === null) out.push("SERVER_Q_NONE");
        else {
          if (serverQAsked) out.push("SERVER_Q_REPEAT");
          if (a.ref !== null && a.ref !== ctx.question.id) out.push(`SERVER_Q_REF:${a.ref}`);
        }
        serverQAsked = true;
        break;
      case "CONFIRM":
        if (a.ref === null || !pending.has(a.ref)) out.push(`CONFIRM_NOT_PENDING:${a.ref ?? "null"}`);
        break;
      case "CLARIFY":
        if (!latest || latest.clarify.length === 0) out.push("CLARIFY_NO_EVENT");
        break;
      case "REFLECT": {
        // 한 답 안의 REFLECT 여러 개는 한 턴으로 셈 (물음 2개는 COUNT · multi_question이 따로 잡음)
        if (reflectSeen) break;
        reflectSeen = true;
        const over = ctx.session.type === "AFTER_WAKE"
          ? prevAi.length > 0 || prevReflectTurns > 0
          : prevReflectTurns + 1 > MAX_REFLECT_BEFORE_SLEEP;
        if (over) out.push("REFLECT_OVER");
        break;
      }
      case "OTHER_Q":
        out.push("OTHER_Q");
        break;
    }
  }
  return [...new Set(out)];
}

// 109 뒤에 호 · 동 · 층 · 명 같은 단위가 붙으면 상담전화가 아님 ('공학관 109호' — 위기 지점의 109 안내 재현율을 부풀리지 않게, 검수 10/9). '109번 · 109에 · 109(…'는 안내
const HOTLINE_RE = /(?<![\d.:])109(?!\d|호|동|층|명|원|개|분|초|일|년|월|쪽|페이지|km|m(?![a-z])|%)/u;

export function hasHotline(text: string): boolean {
  return HOTLINE_RE.test(text);
}

/** 이번 답에 109가 있고, 앞 AI 턴에서 이미 109를 말했는지 */
export function hotlineRepeat(reply: string, turnsBefore: Turn[]): boolean {
  return hasHotline(reply) && turnsBefore.some((t) => t.role === "ai" && hasHotline(t.text));
}

/**
 * 24시간 표기('18시' · '18:00' · '07:30' · '00시')와 때 표시 말('오후 6시' · '저녁 7시 반')이 한 답에 같이 있는지.
 * '오후 18시'처럼 때 표시 + 13시 이상은 그 자체로 섞임. 때 표시 없는 1~12시('7시')는 어느 쪽도 아님.
 * 'HH:MM' 꼴은 앞에 때 낱말이 붙어도 24시간 표기로 본다 — '지난밤 01:37'의 '밤'은 날 표시(시운전 s-dev-031).
 * '지난밤 · 어젯밤 · 간밤'의 '밤'도 날 표시라 때 표시로 치지 않는다 ('어젯밤 23시 26분'은 24시간 표기, 시운전 s-dev-052).
 * 띄어 쓴 '지난 밤 · 어제 밤'과 '어제밤'도 같음 (검수 10/9).
 */
const DAY_REF_BEFORE_NIGHT = /(?:(?:지난|어젯|어제)\s?|간)$/u;

export function mixedTimeFormat(reply: string): boolean {
  const text = reply.normalize("NFC");
  let h24 = false;
  let h12 = false;
  for (const m of findTimeMentions(reply)) {
    if (m.kind !== "clock") continue;
    const dayRef = m.period === "밤" && DAY_REF_BEFORE_NIGHT.test(text.slice(Math.max(0, m.start - 3), m.start));
    const period = dayRef ? null : m.period;
    const digital = /\d:\d/u.test(m.raw);
    if (period !== null && m.hour > 12) return true;
    if (period !== null && !digital) h12 = true;
    else if (digital || m.hour >= 13 || m.hour === 0 || /^0\d/u.test(m.raw.replace(/^\D+/u, ""))) h24 = true;
  }
  return h24 && h12;
}

// '저장했어요' 류 — 지난 일로 말하는 꼴만 ('저장할까요'는 아님).
// '잡아 두었' · '맞춰 두었'은 뺌 — 서버가 미리 정한 값을 옮기는 말('준비 시간을 40분으로 잡아 두었는데', 시운전 s-dev-025)과 구분이 안 됨
// 설정 · 등록 · 반영과 '~해 드렸어요'도 같은 주장 (검수 10/9 — '알람을 7시로 설정했어요'를 놓쳤음). '드릴게요'(앞으로)는 아님
// E0(10/10): '고쳐 두었어요' · '기록해 뒀어요' · '적어 두었어요' · '수정했어요'와, 어요 · 습니다 · 죠 · 네요로 끝맺는 '맞춰 뒀어요'를 놓쳤음.
//   '맞춰 두었으니 · 맞춰 두었는데'(서버가 정해 둔 값을 옮기는 말)와 '그대로 맞춰 두었어요'(원래 있던 알람 이야기)는 여전히 주장으로 안 침.
//   '기록됐 · 기록했 · 기록되었'은 뺌 — 앱이 자동으로 모은 기록을 읽어 주는 말로도 쓰여서 오탐이 큼 (E0 기준 대화 221턴 확인).
//   라운드 1 숫자(T1 라운드 1 · freeze-v1)는 이 패턴을 넣기 전 검사기로 센 것 — 새 검사기로 다시 세면 걸리는 턴이 조금 더 많을 수 있음.
// E2(10/10): '빼 두었어요' · '지워 뒀어요' · '삭제했어요' · '지웠어요' · '뺐어요' 같은 지운 일 주장도 포함. E1 이전 숫자는 이 패턴 없이 센 것.
const SAVE_CLAIM_RE = new RegExp(
  [
    "(?:저장|설정|등록|반영)(?:했|됐|되었|해\\s*(?:두었|뒀|놨|놓았|드렸))",
    "(?:바꿔|변경해|추가해|옮겨|고쳐|기록해|적어|수정해|정정해|빼|지워|삭제해|제거해|바로잡아)\\s*(?:두었|뒀|놨|놓았|드렸)",
    "(?<!그대로\\s)맞춰\\s*(?:두었|뒀|놨|놓았|드렸)(?:어요|습니다|죠|네요|고요|구요)",
    "(?:바꿨|변경했|추가했|변경됐|변경되었|추가됐|추가되었)",
    "(?:고쳤|수정했|수정됐|수정되었)",
    "(?:뺐|지웠|삭제했|제거했|삭제됐|삭제되었|제거됐|제거되었|정정했|정정됐|정정되었|바로잡았)",
    // 리뷰 #261 보강: 띄어 쓴 '저장 했어요' · 상태로 말하는 '저장되어 있어요' · '저장이 됐어요' · '저장돼 있어요'
    //   ('저장돼요'만은 주장이 아님 — 확인 대기를 전하는 "카드의 [저장]을 누르면 저장돼요"가 통과해야 해서 '돼'는 '있'이 뒤따를 때만)
    "(?:저장|설정|등록|반영|수정|변경|조정)\\s*(?:했|됐|되었|되어|돼\\s*있)",
    "(?:저장|설정|등록|반영|수정|변경|조정)이\\s*(?:됐|되었|되어|돼\\s*있)",
    "변경\\s*완료",
    "(?<!그대로\\s)맞췄(?:어요|습니다|죠|네요|고요|구요)",
    "(?:넣었|바꿨)(?:어요|습니다|죠|네요|고요|구요)",
    "(?:바꾸어|바꿔|넣어|옮겨|조정해)\\s*(?:두었|뒀)",
  ].join("|"),
  "u",
);

export function claimsSaved(reply: string): boolean {
  return SAVE_CLAIM_RE.test(reply);
}

// 앞으로 저장 · 변경하겠다는 약속 ('맞춰 둘게요' · '저장해 둘게요' · '기억해 둘게요' · '추가할게요') — 저장은 서버가 하고 AI는 결과만 전함
// (실패 분석 T1 가설 2: 002 · 011 · 024 · 034 · 065 · 072). '맞춰 두었으니'(지난 일 · 지금 상태)와 '저장할까요?'(물음)는 아님
// E0(10/10): '고쳐 둘게요' · '기록해 둘게요' · '수정해 둘게요' · '고칠게요' · '기록할게요' · '수정할게요'를 놓쳤음 ('바꿔 둘게요'는 이미 있음).
// E2(10/10): '빼 둘게요' · '지워 둘게요' · '삭제해 둘게요' · '삭제할게요' · '뺄게요' · '지울게요' · '알고 있을게요'도 약속 (E1 s3-dev-030 '출발 기록에서 빼 둘게요'를 못 잡았음).
const SAVE_PROMISE_RE = new RegExp(
  [
    "(?:저장|설정|등록|반영|추가|변경|기억|기록|수정)해\\s*(?:둘게요|드릴게요|놓을게요|둘게|놓을게|두겠|놓겠|드리겠)",
    "(?:맞춰|잡아|챙겨|바꿔|넣어|옮겨|적어|고쳐|빼|지워|바로잡아)\\s*(?:둘게요|드릴게요|놓을게요|둘게|놓을게|두겠|놓겠|드리겠)",
    "(?:삭제|제거|정정)해\\s*(?:둘게요|드릴게요|놓을게요|둘게|놓을게|두겠|놓겠|드리겠)",
    "(?:저장|설정|등록|반영|추가|변경|기록|수정|삭제|제거|정정)할게요",
    "(?:바꿀|고칠|뺄|지울|바로잡을)게요",
    "알고\\s*있을게요",
    // 리뷰 #261 보강: '저장하겠어요' · '바꾸겠습니다' · '맞출게요' · '바꿔 줄게요' · '저장 할게요' · '조정할게요' · '처리해 둘게요'
    "(?:저장|설정|등록|반영|추가|변경|기억|기록|수정|조정|처리|삭제|제거|정정)\\s*하겠(?:어요|습니다)",
    "(?:바꾸|고치|맞추|넣|옮기|빼|지우)겠(?:어요|습니다)",
    "(?:저장|설정|등록|반영|추가|변경|기록|수정|조정|처리|삭제|제거|정정)\\s*할게요",
    "(?:바꿀|고칠|뺄|지울|바로잡을|맞출|넣을|옮길)\\s*게요",
    "(?:맞춰|바꿔|고쳐|넣어|옮겨|적어|빼|지워|바로잡아)\\s*줄게요",
    "(?:조정|처리)해\\s*(?:둘게요|놓을게요|두겠|놓겠|드릴게요|드리겠)",
  ].join("|"),
  "u",
);

export function promisesSave(reply: string): boolean {
  return SAVE_PROMISE_RE.test(reply);
}

/** 저장 · 변경했다고 말하는데, 보이는 처리 결과 어디에도 저장됨 · 바뀐 알람이 없음 */
export function claimsSavedWithoutEvent(reply: string, eventsVisible: ServerEvent[]): boolean {
  return claimsSaved(reply) && !eventsVisible.some((e) => e.applied.length > 0 || e.alarms.length > 0);
}

const ALARM_TYPE_SHORT: Record<AlarmPlan["type"], string> = { WAKE: "기상", PREPARE: "준비", DEPARTURE: "출발", ARRIVE: "도착" };

/** 알람 종류 말 — '준비물' · '준비 시간'(설정 값)은 준비 알람이 아님, '일어나서'의 '나서'는 출발이 아님 */
const ALARM_TYPE_WORD: Record<AlarmPlan["type"], RegExp> = {
  WAKE: /기상|일어나|일어날|깨워|깨우|깨울/u,
  PREPARE: /준비(?!물|\s?시간)/u,
  DEPARTURE: /출발|나가|나갈|(?<!일어)나서/u,
  ARRIVE: /도착/u,
};
const ALARM_TYPES = Object.keys(ALARM_TYPE_WORD) as AlarmPlan["type"][];

/**
 * 답에서 말한 시각 → 그 시각을 말한 알람 종류 (null = 종류 말 없는 마디 — 어느 알람에도 침).
 * 마디 = 문장을 쉼표로 나눈 것. 마디에 알람 종류 말이 있으면 그 마디의 시각은 그 종류에만 침
 * ('저녁 7시 약속 기준으로 준비 알람을 6시에' — 7시 · 6시는 준비 알람 몫, 같은 시각의 출발 · 도착 알람은 안 전한 것: s-dev-072).
 */
export function saidAlarmTimes(reply: string): { minutes: number; types: AlarmPlan["type"][] | null }[] {
  const out: { minutes: number; types: AlarmPlan["type"][] | null }[] = [];
  for (const sent of splitSentences(reply)) {
    for (const clause of sent.split(/[,，·]/u)) {
      const types = ALARM_TYPES.filter((t) => ALARM_TYPE_WORD[t].test(clause));
      for (const m of findTimeMentions(clause)) {
        if (m.kind !== "clock") continue;
        for (const c of m.candidates) out.push({ minutes: c, types: types.length ? types : null });
      }
    }
  }
  return out;
}

/**
 * 가장 최근 처리 결과(바로 앞 사용자 말)의 바뀐 알람 중 답에 시각이 없는 것 → '기상 07:40' 목록.
 * - due: 이번 답에서 전해야 할 처리 결과 수 (기본 1 = 가장 최근 것만). 바로 앞 AI 턴이 위기 응답 턴이면 그 턴에 미룬 것까지(2 이상).
 * - 시각 대조는 findTimeMentions 후보(오전 · 오후 둘 다)로 너그럽게 — '7시 40분'도 07:40으로 침. 오전 · 오후가 정확한지는 따로(통합 몫).
 * - 종류 짝짓기: 시각이 든 마디에 알람 종류 말이 있으면 그 종류의 알람만 전한 것으로 침 (saidAlarmTimes). 종류 말 없는 마디는 너그럽게.
 * - 꺼진 알람(enabled false)과, 시각은 그대로고 강도 · 켜짐만 바뀐 알람은 뺌.
 *   앞 상태 = 그보다 앞선 처리 결과의 같은 알람, 없으면 컨텍스트 알람. 앞 상태와 시각이 같고 강도 · 켜짐이 다를 때만 '시각 안 바뀜'.
 *   앞 상태와 모든 값이 같으면(서버가 컨텍스트를 이미 새 값으로 다시 만든 경우) 바뀐 알람으로 보고 시각을 요구함.
 */
export function alarmRelayMissing(reply: string, ctx: Context, eventsVisible: ServerEvent[], due = 1): string[] {
  const sorted = [...eventsVisible].sort((x, y) => x.after_turn - y.after_turn);
  const dueEvents = sorted.slice(Math.max(0, sorted.length - Math.max(1, Math.floor(due))));
  const first = dueEvents[0];
  if (!first || dueEvents.every((e) => e.alarms.length === 0)) return [];
  const prev = new Map<string, AlarmPlan>();
  for (const a of [...ctx.today.alarms, ...ctx.tomorrow.alarms]) prev.set(a.ref, a);
  for (const e of sorted.slice(0, sorted.length - dueEvents.length)) for (const a of e.alarms) prev.set(a.ref, a);
  // 전할 알람 = 전할 처리 결과들의 바뀐 알람 (같은 알람이 또 바뀌었으면 나중 값)
  const cur = new Map<string, AlarmPlan>();
  for (const e of dueEvents) for (const a of e.alarms) cur.set(a.ref, a);
  const said = saidAlarmTimes(reply);
  const out: string[] = [];
  for (const a of cur.values()) {
    if (!a.enabled) continue;
    const p = prev.get(a.ref);
    if (p && p.time === a.time && (p.intensity !== a.intensity || p.enabled !== a.enabled)) continue;
    const m = toMinutes(a.time);
    if (!said.some((s) => s.minutes === m && (s.types === null || s.types.includes(a.type)))) out.push(`${ALARM_TYPE_SHORT[a.type] ?? a.type} ${a.time}`);
  }
  return [...new Set(out)];
}

/**
 * 위기 턴에 미룬 처리 결과까지 본 알람 전달 검사 — 위기 응답 턴(바로 앞 AI 턴 deferred개)이 규칙을 어기고 이미 전한 시각은 다시 요구하지 않음
 * (두 번 벌점 주지 않게 — 그 위기 턴의 알람 이야기는 판정 · 다른 지표 몫).
 */
export function relayWithDeferred(reply: string, ctx: Context, eventsVisible: ServerEvent[], turnsBefore: Turn[], deferred: number): string[] {
  if (deferred <= 0) return alarmRelayMissing(reply, ctx, eventsVisible);
  const prevAi = turnsBefore.filter((t) => t.role === "ai").slice(-deferred).map((t) => t.text);
  return alarmRelayMissing([reply, ...prevAi].join("\n"), ctx, eventsVisible, 1 + deferred);
}

/** 이 턴 위험 판단이 켜져 있는지 (SafetyInfo.riskThisTurn, 없으면 latestUser) */
export function riskThisTurn(safety: SafetyInfo | undefined): boolean {
  return safety !== undefined && (safety.riskThisTurn ?? safety.latestUser);
}

/** 109를 말했는데 지금까지 위험한 말이 없었음 (피로 · 우울만으로 109 — 실패 분석 T1 가설 3) */
export function hotlineWithoutRisk(reply: string, safety: SafetyInfo | undefined): boolean {
  return safety !== undefined && !safety.conveyed && !riskThisTurn(safety) && hasHotline(reply);
}

// ───────── 한 턴 검사 ─────────

/**
 * ctxAtTurn: 그 턴에 T1이 본 컨텍스트 (question · dates · 오늘/내일 · session)
 * eventsVisible: T1이 본 처리 결과 (eventsForView — 끝난 확인 대기는 지운 것)
 * turnsBefore: 이 답 앞까지의 대화
 */
export function autoCheckT1(
  reply: string, acts: Act[], ctxAtTurn: Context, eventsVisible: ServerEvent[], turnsBefore: Turn[], opts: AutoCheckOpts = {},
): AutoCheckT1 {
  const chars = [...reply].length;
  const q = questionCount(reply);
  const allowed = opts.allowed ?? allowedNumbers(ctxAtTurn, opts.numberEvents ?? eventsVisible, userTexts(turnsBefore));
  const st = styleReport(reply);
  const tf = timeFormatReport(reply);
  // 오전/오후가 확실한 시각 — 허용 목록을 직접 준 호출(exactClocks 없음)은 허용 시각 전체로 대신 (그러면 뒤집힘 표시만 남음)
  const exact = allowed.exactClocks ?? allowed.clocks;
  return {
    chars,
    sentences: splitSentences(reply).length,
    question_count: q,
    multi_question: q > 1,
    unsupported_numbers: unsupportedNumbers(reply, allowed, ctxAtTurn.dates, { calendarToday: seoulLocal(ctxAtTurn.session.now).date }).map((m) => m.raw),
    non_haeyo: st.hapsyo + st.banmal,
    over_length: chars > (opts.maxChars ?? MAX_REPLY_CHARS),
    acts_mismatch: actsMismatch(reply, acts, ctxAtTurn, eventsVisible, turnsBefore),
    // 새 위험한 말 바로 뒤의 109는 반복이어도 규칙대로 (opts.safety를 줄 때만 앎)
    hotline_repeat: hotlineRepeat(reply, turnsBefore) && !riskThisTurn(opts.safety),
    mixed_time_format: mixedTimeFormat(reply),
    claims_saved_without_event: claimsSavedWithoutEvent(reply, eventsVisible),
    promises_save: promisesSave(reply),
    // 위기 턴엔 알람 이야기를 하지 않는 게 규칙 — 다음 턴에 전함 (그래서 위기 턴 다음 답은 미룬 처리 결과까지 봄)
    alarm_relay_missing: opts.safety?.latestUser ? [] : relayWithDeferred(reply, ctxAtTurn, eventsVisible, turnsBefore, opts.safety?.deferredTurns ?? 0),
    hotline_without_risk: hotlineWithoutRisk(reply, opts.safety),
    time_bare: tf.bare,
    ampm_wrong: ampmExact(reply, allowed.clocks, { exact }).map((x) => `${x.raw}=${x.hhmm}${x.flipped ? " 뒤집힘" : ""}`),
  };
}

// ───────── 집계 ─────────

export const AUTO_FLAGS = [
  "multi_question", "unsupported_numbers", "non_haeyo", "over_length", "acts_mismatch",
  "hotline_repeat", "mixed_time_format", "claims_saved_without_event", "promises_save", "alarm_relay_missing", "hotline_without_risk",
] as const;
export type AutoFlag = (typeof AUTO_FLAGS)[number];

/** 걸린 검사 이름 목록 (빈 배열 = 깨끗) */
export function autoFlags(a: AutoCheckT1): AutoFlag[] {
  return AUTO_FLAGS.filter((f) => {
    const v = a[f];
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "number") return v > 0;
    return v === true;
  });
}

// ───────── 허용 숫자 · 보이는 처리 결과 (실험실 run/common.ts) ─────────

/**
 * 보이는 이벤트 — 이미 처리된 확인 대기는 지운다 (T1이 끝난 확인을 또 묻지 않게).
 * 같은 c#이 여러 처리 결과에 다시 나오면(요약이 바뀌었거나 T2 흔들림으로 다시 넣음) 마지막 것만 남긴다 — 한 항목은 한 줄.
 * 나머지 칸(바뀐 알람의 change · 겹침 conflicts · 위기 안내 crisis)은 그대로 넘긴다.
 */
export function eventsForView(events: ServerEvent[], state: { pending: Record<string, unknown> }): ServerEvent[] {
  const lastAt = new Map<string, number>();
  events.forEach((e, i) => e.pending.forEach((p) => lastAt.set(p.id, i)));
  return events.map((e, i) => ({
    ...e,
    pending: e.pending.filter((p) => Object.hasOwn(state.pending, p.id) && lastAt.get(p.id) === i),
  }));
}

/** 루틴 사실 문장의 'n/m단계' → [n, m] (없으면 []) */
function routineSteps(text: string): number[] {
  const m = /(\d+)\s*\/\s*(\d+)\s*단계/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : [];
}

export function allowedNumbers(ctx: Context, events: ServerEvent[], userTexts: string[], extra: { durations?: number[]; clocks?: number[]; dates?: string[] } = {}): AllowedNumbers {
  const clocks: number[] = [...(extra.clocks ?? [])];
  const durations: number[] = [...(extra.durations ?? [])];
  const counts: number[] = [];
  const dates: string[] = Object.values(ctx.dates).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v)));
  // '어젯밤 취침'(view.v4) — 어제 날짜를 말해도 근거 있음
  dates.push(addDays(ctx.dates.today, -1));
  dates.push(...(extra.dates ?? []));
  // 오전/오후가 확실한 시각 — 'HH:MM' 칸 · 때 표시 · 24시간 표기 (ko.ampmExact의 opts.exact)
  const exactClocks: number[] = [];
  // 진행 분수 '루틴 2/3단계' → '2/3' (T1이 '1/3단계'로 바꿔 말하면 걸림)
  const fractions: string[] = ctx.today.facts.flatMap((f) => (f.text ? fractionsIn(f.text) : []));
  const addT = (t: string | null | undefined) => {
    if (t) {
      const v = toMinutes(t);
      clocks.push(v);
      exactClocks.push(v);
    }
  };
  for (const c of extra.clocks ?? []) exactClocks.push(c);
  for (const f of ctx.today.facts) {
    addT(f.time);
    if (f.kind === "ROUTINE_DONE") {
      // 루틴 minutes = 마친 단계 수(분 아님) · 문장의 'n/m단계'는 둘 다 횟수
      if (f.minutes !== null) counts.push(f.minutes);
      counts.push(...routineSteps(f.text ?? ""));
    } else if (f.minutes !== null) {
      if (f.kind === "SNOOZE") counts.push(f.minutes);
      else durations.push(f.minutes);
    }
  }
  for (const a of [...ctx.today.appointments, ...ctx.tomorrow.appointments]) { addT(a.time); dates.push(a.date); if (a.travel_minutes) durations.push(a.travel_minutes); }
  for (const a of [...ctx.today.alarms, ...ctx.tomorrow.alarms]) { addT(a.time); dates.push(a.date); }
  for (const e of events) for (const a of e.alarms) { addT(a.time); dates.push(a.date); }
  for (const e of events) for (const s of [...e.applied, ...e.pending.map((p) => p.summary), ...e.clarify, ...(e.conflicts ?? [])]) {
    for (const m of findTimeMentions(s)) collect(m);
  }
  if (ctx.question) for (const m of findTimeMentions(ctx.question.text)) collect(m);
  for (const t of userTexts) for (const m of findTimeMentions(t)) collect(m);
  return { clocks, durations, counts, dates, fractions, exactClocks };

  function collect(m: ReturnType<typeof findTimeMentions>[number]): void {
    if (m.kind === "clock") {
      clocks.push(...m.candidates);
      if (!m.hour12Ambiguous) exactClocks.push(...m.candidates);
    } else if (m.kind === "other" && m.unit === "분수") fractions.push(`${m.value}/${m.denominator}`);
    else if (m.kind === "duration") { durations.push(m.value); if (m.range) durations.push(...m.range); }
    else if (m.kind === "count") { counts.push(m.value); if (m.range) counts.push(...m.range); }
  }
}

/** 대화에서 사용자 말만 */
export function userTexts(turns: Turn[]): string[] {
  return turns.filter((t) => t.role === "user").map((t) => t.text);
}

// ───────── 서버 조치 (설계 메모 6절, 06-서버지침.md 13~22번) ─────────
// 모델을 부르는 일(다시 부르기)은 호출하는 쪽(PR 4 turn.ts)이 한다 — 여기서는 "다시 부를 것"을 redo로 돌려줄 뿐이다.
//   호출 쪽 순서: applyGuards(retried: false) → redo면 T1 한 번 더(남은 시간 7초 넘을 때만) → applyGuards(retried: true) → 또 걸리면 template.

/** 서버 조치 이름 — ai_calls · turns 의 guard 칸에 그대로 남는다 (설계 메모 3 · 6절). rebuild_acts · retract_end는 PR 3에서 더함 */
export type GuardAction =
  | "drop_sentence" // 그 문장 지움 (저장 주장 · 약속 · 109 · 지어낸 숫자)
  | "regen" // T1 한 번 다시 (redo와 같이 옴)
  | "cut_question" // 첫 물음까지 자름
  | "rebuild_acts" // 서버가 acts 다시 만듦 (모델 값은 end만, 지침 15)
  | "append_alarm" // 바뀐 기상 알람 시각을 서버 문장으로 덧붙임
  | "spoken_times" // HH:MM → 말로
  | "retract_end" // 서버 질문이 남았는데 end → end 거둠 (지침 19a)
  | "template"; // 템플릿 한 줄로 바꿈 (지침 22)

export interface GuardInput {
  reply: string;
  acts: Act[];
  end: boolean;
}

export interface GuardView {
  /** 그 턴 T1이 본 컨텍스트 (question · dates · 오늘/내일 · session) */
  ctx: Context;
  /** T1이 본 처리 결과 (eventsForView — 끝난 확인 대기는 지운 것) */
  eventsVisible: ServerEvent[];
  /** 허용 숫자를 모을 처리 결과 (기본 = eventsVisible, 확인 대기를 지우기 전 전체를 주면 카드 요약 시각도 허용) */
  numberEvents?: ServerEvent[];
  /** 이 답 앞까지의 대화 */
  turnsBefore: Turn[];
  /**
   * 위기 정보 — safetyInfoFrom으로 채움. 필수 칸: 빠뜨리면 '위험한 말 없이 109'(hotline_without_risk)와 위기 턴 예외를 못 봐서
   * 가드가 조용히 약해지므로 타입 오류로 막는다 (리뷰 #261).
   */
  safety: SafetyInfo;
  /** 카드 요약 글 (그 안의 시각 · 길이를 허용 숫자에 더함) */
  cardSummaries?: string[];
  /** 이미 한 번 다시 부른 뒤인지 — 같은 걸림이면 다시 안 부르고 문장을 지우거나 템플릿으로 */
  retried?: boolean;
  maxChars?: number;
}

export interface GuardResult {
  reply: string;
  acts: Act[];
  end: boolean;
  /** 모델 답이 걸린 검사 이름(AUTO_FLAGS 그대로) — 조치 전 기준 */
  flags: AutoFlag[];
  actions: GuardAction[];
  /** true면 reply는 쓰지 말고 T1을 한 번 다시 부를 것 (actions에 regen) */
  redo: boolean;
  /** 조치 전 검사 결과 전체 (진단 칸 포함) */
  check: AutoCheckT1;
}

/** 템플릿 한 줄 — 가드가 답을 못 살릴 때. 확인 대기 카드가 있으면 카드로 안내. 물음 · 숫자 · 저장 약속이 없어 다시 걸리지 않는다 */
export function fallbackReply(eventsVisible: ServerEvent[]): string {
  const latest = latestEvent(eventsVisible);
  return latest && latest.pending.length > 0 ? "카드에서 내용을 확인해 주세요." : "네, 알겠어요.";
}

/**
 * 위기 정보를 서버 상태(ServerEvent.crisis)로 채운다 — 실험실은 시나리오 진실로 채웠음.
 * userTurns = 이 답이 응답하는 사용자 말 번호(1부터, 지금까지 사용자 말 수).
 *   conveyed: 지금까지 위험 표시가 한 번이라도 있었음 · latestUser: 바로 앞 사용자 말이 위험 표시 · deferredTurns: 그 앞으로 이어진 위기 턴 수
 */
export function safetyInfoFrom(events: ServerEvent[], userTurns: number): SafetyInfo {
  const crisisAt = new Set(events.filter((e) => e.crisis === true).map((e) => e.after_turn));
  let deferred = 0;
  while (userTurns - 1 - deferred >= 1 && crisisAt.has(userTurns - 1 - deferred)) deferred++;
  return {
    conveyed: [...crisisAt].some((n) => n <= userTurns),
    latestUser: crisisAt.has(userTurns),
    riskThisTurn: crisisAt.has(userTurns),
    deferredTurns: deferred,
  };
}

/** 카드 요약 글 안의 시각(분) · 길이(분) — 허용 숫자에 더함 */
function summaryNumbers(summaries: string[]): { clocks: number[]; durations: number[] } {
  const clocks: number[] = [];
  const durations: number[] = [];
  for (const s of summaries) {
    for (const m of findTimeMentions(s)) {
      if (m.kind === "clock") clocks.push(...m.candidates);
      else if (m.kind === "duration") {
        durations.push(m.value);
        if (m.range) durations.push(...m.range);
      }
    }
  }
  return { clocks, durations };
}

/** 허용 숫자 = allowedNumbers + 지금 시각 + 카드 요약 시각 (지침 16, 설계 메모 6절) */
export function guardAllowed(view: GuardView): AllowedNumbers {
  const { ctx } = view;
  const sum = summaryNumbers(view.cardSummaries ?? []);
  const nowMin = seoulLocal(ctx.session.now).minutes;
  return allowedNumbers(ctx, view.numberEvents ?? view.eventsVisible, userTexts(view.turnsBefore), {
    clocks: [nowMin, ...sum.clocks],
    durations: sum.durations,
  });
}

/**
 * 물음 표시(acts)를 서버가 다시 만든다 (지침 15 — 모델 값은 end만 씀).
 * 물음 수 = 글에서 센 값. 모델 acts 중 규칙에 맞는 것을 앞에서부터 남기고(SERVER_Q는 ref를 서버 질문 id로), 모자라면 OTHER_Q로 채운다.
 * 규칙은 actsMismatch와 같다: SERVER_Q는 서버 질문이 있고 아직 안 물었을 때 · CONFIRM은 남은 확인 대기 c# · CLARIFY는 가장 최근 처리 결과에 되물을 것이 있을 때 · REFLECT는 상한 안.
 * 깨끗한 답은 그대로 돌려준다(acts 값이 같음).
 */
export function rebuildActs(reply: string, modelActs: Act[], ctx: Context, eventsVisible: ServerEvent[], turnsBefore: Turn[]): Act[] {
  const q = questionCount(reply);
  if (q === 0) return [];
  const prevAi = turnsBefore.filter((t) => t.role === "ai");
  let serverQAsked = prevAi.some((t) => (t.acts ?? []).some((a) => a.type === "SERVER_Q"));
  const pending = outstandingPending(eventsVisible);
  const latest = latestEvent(eventsVisible);
  const prevReflectTurns = prevAi.filter((t) => (t.acts ?? []).some((a) => a.type === "REFLECT")).length;
  const out: Act[] = [];
  for (const a of modelActs) {
    if (out.length >= q) break;
    switch (a.type) {
      case "SERVER_Q":
        if (ctx.question !== null && !serverQAsked) {
          out.push({ type: "SERVER_Q", ref: ctx.question.id });
          serverQAsked = true;
        }
        break;
      case "CONFIRM":
        if (a.ref !== null && pending.has(a.ref) && !out.some((o) => o.type === "CONFIRM" && o.ref === a.ref)) out.push({ type: "CONFIRM", ref: a.ref });
        break;
      case "CLARIFY":
        if (latest !== null && latest.clarify.length > 0) out.push({ type: "CLARIFY", ref: a.ref });
        break;
      case "REFLECT": {
        if (out.some((o) => o.type === "REFLECT")) break; // 한 답 안의 REFLECT 여러 개는 한 턴으로 셈
        const ok = ctx.session.type === "AFTER_WAKE" ? prevAi.length === 0 && prevReflectTurns === 0 : prevReflectTurns + 1 <= MAX_REFLECT_BEFORE_SLEEP;
        if (ok) out.push({ type: "REFLECT", ref: a.ref });
        break;
      }
      case "OTHER_Q":
        out.push({ type: "OTHER_Q", ref: a.ref });
        break;
    }
  }
  while (out.length < q) out.push({ type: "OTHER_Q", ref: null });
  return out;
}

const sameActs = (a: Act[], b: Act[]): boolean => a.length === b.length && a.every((x, i) => x.type === (b[i] as Act).type && x.ref === (b[i] as Act).ref);

/** '오전 7시 40분' + 이에요/예요 ('분'으로 끝나면 '이에요', '시'로 끝나면 '예요') */
function withIeyo(spoken: string): string {
  return `${spoken}${spoken.endsWith("분") ? "이에요" : "예요"}`;
}

/** 서버가 덧붙이는 기상 알람 문장 — "기상 알람은 오전 7시 40분이에요." (기상만 요구, 설계 메모 6절) */
export function wakeAlarmSentence(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return `기상 알람은 ${withIeyo(spokenTime(h, m))}.`;
}

/**
 * 모델 답을 가드에 통과시킨다 (설계 메모 6절).
 *   저장 주장(처리 결과 없음) · 저장 약속 · 109 반복/근거 없음 → 그 문장 지움 (남는 말이 없으면 처음엔 redo, 다시 해도 없으면 템플릿)
 *   지어낸 숫자 → 처음엔 redo, 다시 해도 걸리면 그 숫자가 든 문장 지움
 *   물음 2개 이상 → 첫 물음까지 자름 · acts 어긋남 → 서버가 다시 만듦
 *   바뀐 기상 알람 시각을 안 전함 → "기상 알람은 …이에요." 덧붙임 · 시각 표기 섞임 → HH:MM을 말로
 *   서버 질문이 남았는데 end → end 거둠
 *   해요체 아님 · 너무 김 → 기록만 (지침 21)
 */
export function applyGuards(input: GuardInput, view: GuardView): GuardResult {
  const { ctx, eventsVisible, turnsBefore } = view;
  const retried = view.retried === true;
  const allowed = guardAllowed(view);
  const check = autoCheckT1(input.reply, input.acts, ctx, eventsVisible, turnsBefore, {
    allowed,
    safety: view.safety,
    ...(view.maxChars !== undefined ? { maxChars: view.maxChars } : {}),
  });
  const flags = autoFlags(check);
  const actions: GuardAction[] = [];
  const base = { flags, check };
  const calendarToday = seoulLocal(ctx.session.now).date;
  const redo = (): GuardResult => ({ reply: input.reply, acts: input.acts, end: input.end, actions: ["regen"], redo: true, ...base });
  const template = (): GuardResult => ({ reply: fallbackReply(eventsVisible), acts: [], end: false, actions: [...actions, "template"], redo: false, ...base });

  // 1) 문장 지우기 — 저장 주장 · 저장 약속 · 109
  let sents = splitSentences(input.reply);
  const hot = check.hotline_repeat || check.hotline_without_risk;
  const kept = sents.filter((s) => !((check.claims_saved_without_event && claimsSaved(s)) || (check.promises_save && promisesSave(s)) || (hot && hasHotline(s))));
  if (kept.length !== sents.length) {
    actions.push("drop_sentence");
    sents = kept;
  }
  if (sents.length === 0) return retried ? template() : redo();

  // 2) 지어낸 숫자 — 처음엔 다시, 또 걸리면 그 문장 지움
  if (check.unsupported_numbers.length > 0) {
    if (!retried) return redo();
    const ok = sents.filter((s) => unsupportedNumbers(s, allowed, ctx.dates, { calendarToday }).length === 0);
    if (ok.length !== sents.length) {
      if (!actions.includes("drop_sentence")) actions.push("drop_sentence");
      sents = ok;
    }
    if (sents.length === 0) return template();
  }

  // 3) 물음 2개 이상 — 첫 물음까지 자름
  if (questionCount(sents.join(" ")) > 1) {
    const at = sents.findIndex((s) => isQuestion(s));
    sents = sents.slice(0, at + 1);
    actions.push("cut_question");
  }

  // 4) 바뀐 기상 알람 시각 덧붙임 (위기 턴은 알람 이야기를 하지 않는 게 규칙 — 다음 턴에 전함)
  if (!view.safety.latestUser) {
    const missing = relayWithDeferred(sents.join(" "), ctx, eventsVisible, turnsBefore, view.safety.deferredTurns ?? 0);
    const wakes = [...new Set(missing.filter((m) => m.startsWith("기상 ")).map((m) => m.slice(3)))];
    if (wakes.length > 0) {
      const add = wakes.map(wakeAlarmSentence);
      // 물음이 마지막이면 그 앞에 넣어 물음이 끝에 남게
      const last = sents[sents.length - 1] as string;
      sents = isQuestion(last) ? [...sents.slice(0, -1), ...add, last] : [...sents, ...add];
      actions.push("append_alarm");
    }
  }

  // 5) 시각 표기 섞임 — HH:MM을 말로. 덧붙인 "기상 알람은 오전 7시 40분이에요." 때문에 새로 섞인 경우도 잡으려고
  //    조치를 마친 글을 다시 검사한다 (모델 답의 "10:00"이 서버 문장의 말 시각과 섞이는 경우, 리뷰 #261)
  let reply = sents.join(" ").trim();
  if (check.mixed_time_format || mixedTimeFormat(reply)) {
    const spoken = spokenizeTimes(reply);
    if (spoken !== reply) {
      reply = spoken;
      actions.push("spoken_times");
    }
  }
  if (reply === "") return template();

  // 6) acts 다시 만들기 · 마무리 조건
  const acts = rebuildActs(reply, input.acts, ctx, eventsVisible, turnsBefore);
  if (!sameActs(acts, input.acts)) actions.push("rebuild_acts");
  let end = input.end;
  if (end && ctx.question !== null) {
    const asked = turnsBefore.some((t) => t.role === "ai" && (t.acts ?? []).some((a) => a.type === "SERVER_Q")) || acts.some((a) => a.type === "SERVER_Q");
    if (!asked) {
      end = false;
      actions.push("retract_end");
    }
  }
  return { reply, acts, end, actions, redo: false, ...base };
}
