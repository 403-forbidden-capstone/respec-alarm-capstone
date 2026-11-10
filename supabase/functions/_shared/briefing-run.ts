// alarm-briefing 함수의 판단 부분 — DB에서 읽은 값(BriefingSource)을 받아 단계별 문장을 만들고, 폰에 없는 음성만 TTS로 만듦
//   DB 읽기는 alarm-briefing/index.ts, 시험은 briefing-run.test.ts (가짜 TTS)
//   TTS가 실패해도 던지지 않음 — 실패한 단계만 failed에 담아 돌려주고, 폰은 있던 음성 또는 기본 알람음으로 울림
import { briefingClips, cleanPrefs, pickAppointments, resolveVoice, urgencyRule, wakeMemo, TTS_MODEL, type BriefAppointment, type BriefTodo, type Importance, type StructuredLike, type UrgencyLevel, type UrgencyRule } from './briefing.ts';
import type { Tts } from './ai/tts.ts';
import { localDateKey } from './tz.ts';

export type BriefingSource = {
  scheduledAtMs: number; // 기상 알람 시각
  timeZone: string;
  prefs: unknown; // profiles.alarm_voice_prefs (jsonb 그대로)
  importance: Importance; // 이 알람이 붙은 일정의 중요도. 일정 없는 알람은 NORMAL
  prepMinutes: number | null; // 참여 조건의 준비 분
  departAtMs: number | null; // 같은 약속의 켜진 출발 알람 시각
  lateCount4w: number;
  appointments: BriefAppointment[]; // 알람 날 내 일정 (취소 아님)
  todos: BriefTodo[]; // 알람 날 안 끝낸 할 일 · 준비물
  sessions: StructuredLike[]; // 기준일(알람 날 − 1) 대화들의 extracted_data
};

export type BriefingOut = {
  enabled: boolean; // 사용자가 AI 음성 브리핑을 끄면 false — 폰은 저장된 음성을 지움
  rule: UrgencyRule | null;
  clips: { level: UrgencyLevel; hash: string; text: string }[]; // 폰이 지금 가져야 할 단계 (화면 표시 · 캐시 열쇠)
  audio: { level: UrgencyLevel; hash: string; mime: string; data: string }[]; // 새로 만든 음성만
  failed: UrgencyLevel[];
};

// 알람 날짜 · 대화 기준일 — 알람이 울리는 날 아침의 전날 밤 대화는 기준일 = 알람 날 − 1 (turn-core dayOf: review = morning − 1)
export function briefingDays(scheduledAtMs: number, timeZone: string): { day: string; review: string } {
  const day = localDateKey(new Date(scheduledAtMs), timeZone);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return { day, review: d.toISOString().slice(0, 10) };
}

export async function runBriefing(src: BriefingSource, have: ReadonlySet<string>, tts: Tts | null, model = TTS_MODEL): Promise<BriefingOut> {
  const profile = resolveVoice(src.importance, cleanPrefs(src.prefs));
  if (!profile.enabled) return { enabled: false, rule: null, clips: [], audio: [], failed: [] };
  const rule = urgencyRule({ importance: src.importance, prepMinutes: src.prepMinutes, lateCount4w: src.lateCount4w, profile });
  const { review } = briefingDays(src.scheduledAtMs, src.timeZone);
  const clips = briefingClips(rule, profile, {
    memo: profile.personal ? wakeMemo(src.sessions, review) : null,
    appointments: pickAppointments(src.appointments.filter((a) => a.atMs >= src.scheduledAtMs)),
    todos: src.todos,
    departAtMs: src.departAtMs,
    timeZone: src.timeZone,
  }, model);

  const audio: BriefingOut['audio'] = [];
  const failed: UrgencyLevel[] = [];
  // 단계마다 차례로 (동시에 4개를 보내면 분당 한도에 걸리기 쉬움). 이미 폰에 있는 열쇠는 건너뜀 = 같은 내용으로 다시 안 부름
  for (const c of clips) {
    if (have.has(c.hash)) continue;
    if (!tts) {
      failed.push(c.level);
      continue;
    }
    try {
      const a = await tts({ model, text: c.text, voice: c.voice, style: c.style });
      audio.push({ level: c.level, hash: c.hash, mime: a.mime, data: a.data });
    } catch (e) {
      console.warn(`[alarm-briefing] ${c.level}단계 음성을 못 만듦: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`);
      failed.push(c.level);
    }
  }
  return { enabled: true, rule, clips: clips.map(({ level, hash, text }) => ({ level, hash, text })), audio, failed };
}
