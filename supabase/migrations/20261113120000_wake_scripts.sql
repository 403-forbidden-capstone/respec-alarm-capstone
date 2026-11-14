-- 개인화 기상 대본 (feat/ai-wake-script) — alarm-briefing이 Gemini 텍스트 한 번으로 만든 1~4단계 대본의 캐시 + 호출 지점
-- ① ai_calls.point에 'AW'(알람 기상 대본 Gemini 텍스트, alarm-briefing) 추가 — 기존 목록(20261111013059_alarm_voice_policy.sql)은 그대로
alter table public.ai_calls drop constraint if exists ai_calls_point_check;
alter table public.ai_calls
  add constraint ai_calls_point_check check (point in ('T1', 'T2F', 'T2', 'T3', 'T4', 'T5', 'E4', 'TT', 'LV', 'AV', 'AW'));
comment on column public.ai_calls.point is '호출 지점: T1 대화 답 · T2F 빠른 추출 · T2 끝 추출 · T3 이유 태그 · T4 일기(대화 없는 날) · T5 일기 · 코칭 · 응원 · E4 추천 비서 · TT 시간표 사진 읽기 · LV 실시간 음성(Gemini Live) 토큰 발급 · AV 알람 긴급 음성(Gemini TTS) · AW 알람 기상 대본(Gemini 텍스트)';

-- ② 알람마다 대본 한 줄 — 입력 지문(input_hash = 일정 · 준비물 · 다짐 · 전날 기록 · 프롬프트 판 · 모델)이 같으면 Gemini를 다시 부르지 않음
--    알람이 지워지면 같이 지워짐. 서버(service_role)만 읽고 씀 — 앱이 직접 쓰면 임의 문장이 Gemini 음성으로 들어갈 수 있어서 앱 권한은 없음
create table public.wake_scripts (
  alarm_id   uuid primary key references public.alarms (alarm_id) on delete cascade,
  user_id    uuid not null references public.profiles (user_id) on delete cascade,
  input_hash text not null,
  model      text not null,
  scripts    jsonb not null,
  updated_at timestamptz not null default now()
);

create index idx_wake_scripts_user on public.wake_scripts (user_id);

comment on table public.wake_scripts is '알람 기상 대본 캐시 (level1~level4 원문, 모델 출력 그대로). alarm-briefing만 읽고 씀';

alter table public.wake_scripts enable row level security;
revoke all on public.wake_scripts from anon, authenticated;
grant select, insert, update, delete on public.wake_scripts to service_role;

-- ai_calls 'AW' 사용자별 하루 셈용
create index if not exists idx_ai_calls_aw_user_time on public.ai_calls (user_id, created_at) where point = 'AW';
