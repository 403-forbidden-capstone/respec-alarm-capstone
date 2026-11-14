// 알람 조정 제안 만들기 (ALG-07, #49 · 안건 D111) — suggestion-generate 본문
//   재료: DB 함수 prepare_suggestion_inputs(p_now) — 후보(앞으로 36시간 안의 반복 일정 준비 알람)와 근거 잔차(실제 준비 − 계획 준비). 거르기 규칙은 그 함수 주석
//   규칙: calc/suggest.ts suggestPrepareAdvance (#464 — 최근 3번 모두 넘치고 평균 5분 이상 → 5분 단위 내림, 상한 안)
//   결과: alarm_suggestions에 PREPARE_ADVANCE · PENDING (current_value = 지금 당김 분, suggested_value = 당긴 뒤 분, evidence = 근거 잔차)
//   · 당김 분 합은 120분을 넘지 않게 자름 (appointment_participants.prepare_advance_minutes 0 ~ 120, #484)
//   · 같은 준비 알람에 대기 중 제안이 이미 있으면(배치가 겹침) 그 줄만 건너뜀 — 유일 색인이 막음(23505)
//   묻기(저녁 대화 카드 · 그룹 탭 카드 · S01) · 적용(알람 계산 반영)은 다음 PR
import { suggestPrepareAdvance, SUGGEST_ROUND_TO } from './calc/suggest.ts';
import { dbFail, must } from './db.ts';
import type { Db } from './supabase.ts';

export const MAX_ADVANCE_MINUTES = 120;

export type SuggestInputRow = {
  user_id: string;
  participant_id: string;
  target_alarm_id: string;
  current_advance: number;
  before_prepare_minutes: number | null;
  cap_minutes: number;
  residuals: number[];
};

export type SuggestionInsert = {
  user_id: string;
  target_alarm_id: string;
  suggestion_type: 'PREPARE_ADVANCE';
  current_value: string;
  suggested_value: string;
  evidence: number[];
};

// 후보 → 넣을 제안 (순수). 규칙에 안 걸리거나 120분 상한에 닿아 당길 게 없으면 뺌
export function planSuggestions(rows: readonly SuggestInputRow[]): SuggestionInsert[] {
  const out: SuggestionInsert[] = [];
  for (const row of rows) {
    const current = Math.max(0, row.current_advance ?? 0);
    const room = Math.floor((MAX_ADVANCE_MINUTES - current) / SUGGEST_ROUND_TO) * SUGGEST_ROUND_TO;
    const s = suggestPrepareAdvance({
      residuals: row.residuals,
      beforePrepareMinutes: row.before_prepare_minutes ?? Infinity,
      capMinutes: Math.min(row.cap_minutes, room),
    });
    if (!s) continue;
    out.push({
      user_id: row.user_id,
      target_alarm_id: row.target_alarm_id,
      suggestion_type: 'PREPARE_ADVANCE',
      current_value: String(current),
      suggested_value: String(current + s.minutes),
      evidence: s.evidence,
    });
  }
  return out;
}

export type SuggestResult = { candidates: number; created: number; skipped: number };

export async function runSuggest(db: Db, now: Date): Promise<SuggestResult> {
  const rows = must('prepare_suggestion_inputs', await db.rpc('prepare_suggestion_inputs', { p_now: now.toISOString() })) as SuggestInputRow[] | null;
  const plans = planSuggestions(rows ?? []);
  let created = 0;
  let skipped = 0;
  // 한 줄씩 — 대기 중 제안이 이미 있는 줄(23505)만 건너뛰고 나머지는 넣음
  for (const plan of plans) {
    const { error } = await db.from('alarm_suggestions').insert(plan);
    if (!error) created += 1;
    else if (error.code === '23505') skipped += 1;
    else dbFail('alarm_suggestions insert', error);
  }
  return { candidates: rows?.length ?? 0, created, skipped };
}
