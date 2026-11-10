-- 기상 알람 AI 음성 브리핑의 사용자 수동 설정 (feat/AI-alarm-voice-briefing)
--   한 칸(jsonb)에 사용자가 직접 고른 값만 담음 — 칸이 없으면 자동(중요도별 개발팀 기본값, _shared/briefing.ts IMPORTANCE_VOICE)
--   그래서 "직접 고른 값"과 "자동 추천값"이 저장 단계에서 구분되고, 키를 지우면 기본값으로 돌아감
--   모양: { enabled?, voice?, tone?, coachMax?, escalate?, personal? } — 서버가 cleanPrefs로 모르는 칸 · 값은 버림
--   알람 볼륨 · 배경음 · 진동은 이 칸이 아니라 기존 알람 축(alarms.sound_key · vibration · voice_tone, H03)이 그대로 맡음
--   본인 행만 고치는 기존 profiles RLS를 그대로 씀 (새 정책 없음)
alter table public.profiles add column alarm_voice_prefs jsonb not null default '{}'::jsonb;
alter table public.profiles add constraint profiles_alarm_voice_prefs_object check (jsonb_typeof(alarm_voice_prefs) = 'object');
comment on column public.profiles.alarm_voice_prefs is '기상 AI 음성 브리핑 수동 설정 (직접 고른 칸만, 없으면 자동)';
