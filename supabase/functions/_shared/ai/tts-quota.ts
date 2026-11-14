// 알람 3 · 4단계 음성(Gemini TTS) 호출 한도 — 기존 글 대화 · Live 한도(quota.ts · opening.ts)와 따로 셈 (ai_calls.point = 'AV')
//   무료 한도(11/10 확인: RPM 3 · TPM 10K · RPD 10)보다 보수적으로: 프로젝트 전체 하루 8 · 분당 2, 사용자 하루 2. 모델과 상관없이 'AV' 전체로 셈
//   DB 함수 reserve_alarm_tts가 한도 확인 + 예약 줄 넣기를 한 트랜잭션(전역 잠금)에서 함 → 예약에 성공했을 때만 Gemini를 부름
//   예약 줄은 실패 · 429여도 남아 한도에 셈. 예약 실패 · DB 오류 · 한도 초과면 null → Gemini 없이 폰의 Android TTS
import type { Db } from '../supabase.ts';

export const TTS_POINT = 'AV';
export const TTS_LIMITS = { projectPerDay: 8, projectPerMinute: 2, userPerDay: 2 } as const;

export type TtsQuota = {
  /** 한 번 부를 자리를 잡음. 못 잡으면(한도 · DB 오류) null */
  reserve(model: string): Promise<string | null>;
  /** 예약한 줄을 결과로 고침. 실패해도 던지지 않음 (예약 줄이 남아 한도에는 그대로 셈) */
  finish(callId: string, r: { ok: boolean; errorCode: string | null; latencyMs: number }): Promise<void>;
};

// 서비스 키 클라이언트로 (사용자 RLS로는 프로젝트 전체를 못 셈). userId는 로그인 토큰에서 온 값만
export function dbTtsQuota(service: Db, userId: string): TtsQuota {
  return {
    async reserve(model) {
      const { data, error } = await service.rpc('reserve_alarm_tts', {
        p_user_id: userId,
        p_model: model,
        p_day_limit: TTS_LIMITS.projectPerDay,
        p_minute_limit: TTS_LIMITS.projectPerMinute,
        p_user_day_limit: TTS_LIMITS.userPerDay,
      });
      if (error) {
        console.error('[alarm-briefing] 호출 예약 실패 — Gemini 없이', error.message);
        return null;
      }
      return typeof data === 'string' ? data : null;
    },
    async finish(callId, r) {
      const res = await service
        .from('ai_calls')
        .update({ ok: r.ok, error_code: r.errorCode, latency_ms: Math.max(0, Math.round(r.latencyMs)), attempts: 1 })
        .eq('call_id', callId)
        .eq('point', TTS_POINT);
      if (res.error) console.error('[alarm-briefing] 호출 기록 실패', res.error.message);
    },
  };
}
