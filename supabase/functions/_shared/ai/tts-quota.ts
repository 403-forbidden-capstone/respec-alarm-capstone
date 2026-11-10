// 알람 긴급 음성(Gemini TTS) 호출 한도 — 기존 글 대화 · Live 한도(quota.ts · opening.ts)와 따로 셈 (ai_calls.point = 'AV')
//   무료 한도(11/10 확인: RPM 3 · TPM 10K · RPD 10)보다 보수적으로: 프로젝트 전체 하루 8 · 분당 2, 사용자 하루 2
//   하루 = 최근 24시간 (Google은 태평양 0시에 초기화 → 24시간 창이 더 보수적). 실패 · 429도 한 번으로 셈
//   shortcut: 세기와 기록 사이에 다른 서버 인스턴스가 동시에 통과할 수 있음 — 한도를 실제보다 2 낮게 잡아 흡수, 사용자가 늘면 DB 예약 행으로
import type { Db } from '../supabase.ts';
import { must } from '../db.ts';

export const TTS_POINT = 'AV';
export const TTS_LIMITS = { projectPerDay: 8, projectPerMinute: 2, userPerDay: 2 } as const;

export type TtsCounts = { projectDay: number; projectMinute: number; userDay: number };

/** 지금 한 번 더 불러도 되는지 */
export function ttsAllowed(c: TtsCounts, limits: typeof TTS_LIMITS = TTS_LIMITS): boolean {
  return c.projectDay < limits.projectPerDay && c.projectMinute < limits.projectPerMinute && c.userDay < limits.userPerDay;
}

export type TtsQuota = {
  allow(): Promise<boolean>;
  record(r: { ok: boolean; errorCode: string | null; latencyMs: number; model: string }): Promise<void>;
};

// 서비스 키 클라이언트로 셈 · 기록 (사용자 RLS로는 프로젝트 전체를 못 셈). 사용자가 보낸 값으로 쿼리를 만들지 않음 — userId는 로그인 토큰에서
export function dbTtsQuota(service: Db, userId: string, now: () => Date = () => new Date()): TtsQuota {
  const count = async (sinceMs: number, user?: string) => {
    let q = service.from('ai_calls').select('call_id', { count: 'exact', head: true }).eq('point', TTS_POINT).gte('created_at', new Date(sinceMs).toISOString());
    if (user) q = q.eq('user_id', user);
    const res = await q;
    must('ai_calls', { data: null, error: res.error });
    return res.count ?? 0;
  };
  return {
    async allow() {
      const t = now().getTime();
      const [projectDay, projectMinute, userDay] = await Promise.all([count(t - 86_400_000), count(t - 60_000), count(t - 86_400_000, userId)]);
      return ttsAllowed({ projectDay, projectMinute, userDay });
    },
    async record(r) {
      const res = await service.from('ai_calls').insert({
        user_id: userId,
        point: TTS_POINT,
        prompt_id: 'ALARM_TTS',
        prompt_version: 'v1',
        model: r.model,
        ok: r.ok,
        error_code: r.errorCode,
        latency_ms: Math.max(0, Math.round(r.latencyMs)),
      });
      if (res.error) console.error('[alarm-briefing] 호출 기록 실패', res.error.message);
    },
  };
}
