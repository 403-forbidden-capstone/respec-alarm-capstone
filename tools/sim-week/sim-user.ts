// 가상 사용자 (글 없이 결정) — 인물 카드 값과 씨앗으로 "그날 밤 무엇을 하는지"를 정함. 모델 호출 없음.
//   · 카드 수락: cooperation HIGH 90% · MID 70% · LOW 40% (헤드 10/30 기준 4)
//   · 기록 정정: correction_tendency — ACCEPT 그냥 둠 · CORRECT 진짜 시각으로 고침 · DENY "그런 일 없다" · ADD_INFO "쯤" 하고 어림값으로 고침
//   · 서버 질문(PREP_CHECK) 답: 내일 첫 일정 날에 요일 사유(recurring_reasons)가 있으면 "더 걸려요 + 그 분", 없으면 "아니요"
//   · 내일 일정 말하기: 진짜 일정에서 T2F가 뽑을 모양(XAppt)으로. 중요도는 본인이 정해 둔 것만 말함
// 난수는 사람 · 날짜 · 용도마다 rngFor 로 고정 (같은 씨앗 = 같은 행동)
import { rngFor } from './rng.ts';
import { extraPrep } from './persona.ts';
import { hm } from './time.ts';
import type { Persona, WorldAppt, WorldDay } from './types.ts';

export const ACCEPT_PROB: Record<Persona['cooperation'], number> = { HIGH: 0.9, MID: 0.7, LOW: 0.4 };

export function acceptsCard(p: Persona, seed: string, morningDate: string, cardNo: number, round = 0): boolean {
  return rngFor(seed, p.id, morningDate, 'card', cardNo, round).chance(ACCEPT_PROB[p.cooperation]);
}

// ---- 기록 확인 ----

export interface FactToCheck {
  factId: string;
  kind: 'DEPART' | 'ARRIVE';
  source: 'AUTO' | 'ONE_TAP' | 'MANUAL'; // 자동으로 잡힌 것만 보고 판단함 (원탭 · 직접 값은 본인이 준 것)
  recordedMs: number;
  trueMs: number;
  earlier: boolean; // "잠깐 나갔다 들어옴" 줄 (앞 출발)
}

export interface FactFeedbackOut {
  fact_id: string;
  status: 'CONFIRMED' | 'CORRECTED' | 'DENIED' | 'UNCLEAR';
  value_time: string | null;
  approx: boolean;
}

export const WRONG_BY_MINUTES = 5; // 기록이 진짜와 이만큼(분) 이상 다르면 "틀렸다"고 느낌 — DECISIONS 22

const round5 = (ms: number): number => Math.round(ms / (5 * 60_000)) * 5 * 60_000;

export function reviewFacts(p: Persona, facts: readonly FactToCheck[]): FactFeedbackOut[] {
  const out: FactFeedbackOut[] = [];
  for (const f of facts) {
    if (f.earlier || f.source !== 'AUTO') continue;
    const wrong = Math.abs(f.recordedMs - f.trueMs) >= WRONG_BY_MINUTES * 60_000;
    if (!wrong) continue;
    switch (p.correction_tendency) {
      case 'ACCEPT':
        break; // 틀려도 그냥 둠
      case 'CORRECT':
        out.push({ fact_id: f.factId, status: 'CORRECTED', value_time: hm(new Date(f.trueMs)), approx: false });
        break;
      case 'DENY':
        out.push({ fact_id: f.factId, status: 'DENIED', value_time: null, approx: false });
        break;
      case 'ADD_INFO':
        out.push({ fact_id: f.factId, status: 'CORRECTED', value_time: hm(new Date(round5(f.trueMs))), approx: true });
        break;
    }
  }
  return out;
}

// ---- 내일 일정 말하기 (T2F가 뽑을 모양) ----

export interface StatedAppt {
  ref: null;
  title: string;
  date: string;
  time: string;
  place: string | null;
  importance: 'LOW' | 'NORMAL' | 'HIGH' | null;
  transport: Persona['transport'] | null;
  repeat: 'NONE' | 'WEEKLY' | null;
  save: 'UNCONFIRMED';
  unclear: null;
}

export function statedAppt(p: Persona, a: WorldAppt): StatedAppt {
  return {
    ref: null,
    title: a.title,
    date: a.date,
    time: a.time,
    place: a.place.shortName ?? a.place.name,
    importance: a.importance, // 본인이 정해 둔 것만 말함 (null = 말 안 함 → 서버 키워드 사전이 채움)
    transport: a.transport !== p.transport ? a.transport : null, // 평소 수단과 다를 때만 말함
    repeat: a.repeat,
    save: 'UNCONFIRMED',
    unclear: null,
  };
}

export const statedAppts = (p: Persona, world: WorldDay): StatedAppt[] => world.appts.map((a) => statedAppt(p, a));

// ---- 서버 질문 답 ----

export function answerPrepCheck(p: Persona, tomorrow: WorldDay): { direction: 'MORE' | 'OK'; minutes: number | null; why: string } {
  const extra = extraPrep(p, tomorrow.weekday);
  if (extra.minutes >= 5) return { direction: 'MORE', minutes: Math.round(extra.minutes / 5) * 5, why: `내일(${tomorrow.weekday}) ${extra.tags.join(' · ')} +${extra.minutes}분` };
  return { direction: 'OK', minutes: null, why: '내일은 평소와 같음' };
}
