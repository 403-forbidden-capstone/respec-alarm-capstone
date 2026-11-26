-- R02 주간 AI 요약 (weekly-summary) — 그 주 하루 일기 글로 만든 요약의 캐시 + 호출 지점 + 동시 요청 잠금
-- ① ai_calls.point에 'WS'(주간 요약 Gemini 텍스트) 추가 — 기존 목록(20261113120000_wake_scripts.sql)은 그대로
alter table public.ai_calls drop constraint if exists ai_calls_point_check;
alter table public.ai_calls
  add constraint ai_calls_point_check check (point in ('T1', 'T2F', 'T2', 'T3', 'T4', 'T5', 'E4', 'TT', 'LV', 'AV', 'AW', 'WS'));
comment on column public.ai_calls.point is '호출 지점: T1 대화 답 · T2F 빠른 추출 · T2 끝 추출 · T3 이유 태그 · T4 일기(대화 없는 날) · T5 일기 · 코칭 · 응원 · E4 추천 비서 · TT 시간표 사진 읽기 · LV 실시간 음성(Gemini Live) 토큰 발급 · AV 알람 긴급 음성(Gemini TTS) · AW 알람 기상 대본(Gemini 텍스트) · WS 주간 AI 요약(Gemini 텍스트)';

-- ② 사람 · 주(월요일)마다 한 줄 — 입력 지문(input_hash = 그 주 일기 날짜 · 글 · 프롬프트 판)이 같으면 Gemini를 다시 부르지 않음
--    day_dates = 요약에 반영된 날짜(개수 = 기록 일수). 그 주 일기가 모두 지워지면 서버가 줄을 지움. 지난 주 줄은 남아 다시 조회됨
--    claimed_until = 지금 이 주 요약을 만드는 요청이 있음(잠금, 30초). 처음 만드는 중이면 요약 칸은 비어 있음
--    서버(service_role)만 읽고 씀 — 앱은 weekly-summary 함수로만 받음
create table public.weekly_summaries (
  user_id       uuid not null references public.profiles (user_id) on delete cascade,
  week_start    date not null,
  input_hash    text,
  summary       text,
  day_dates     date[],
  model         text,
  generated_at  timestamptz,
  claimed_until timestamptz,
  primary key (user_id, week_start),
  constraint weekly_summaries_monday check (extract(isodow from week_start) = 1),
  -- 요약이 있으면 지문 · 날짜(1~7일)도 함께, 없으면(처음 만드는 중) 모두 비어 있음
  constraint weekly_summaries_filled check (
    (summary is null and input_hash is null and day_dates is null)
    or (summary is not null and input_hash is not null and day_dates is not null and cardinality(day_dates) between 1 and 7)
  )
);

comment on table public.weekly_summaries is 'R02 주간 AI 요약 캐시 (그 주 하루 일기 글 → Gemini). weekly-summary만 읽고 씀';

alter table public.weekly_summaries enable row level security;
revoke all on public.weekly_summaries from anon, authenticated;
grant select, insert, update, delete on public.weekly_summaries to service_role;

-- ③ 동시 요청 잠금 — 같은 사람 · 같은 주를 동시에 여러 번 요청해도 Gemini는 한 번만 (잡으면 true)
--    한 문장(insert … on conflict do update … where)이라 행 잠금으로 둘 중 하나만 잡음. 잡은 요청이 죽어도 p_seconds 뒤 풀림
create function public.claim_weekly_summary(p_user_id uuid, p_week_start date, p_seconds integer default 30)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  insert into public.weekly_summaries as w (user_id, week_start, claimed_until)
  values (p_user_id, p_week_start, now() + make_interval(secs => p_seconds))
  on conflict (user_id, week_start) do update
    set claimed_until = excluded.claimed_until
    where w.claimed_until is null or w.claimed_until < now()
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

revoke all on function public.claim_weekly_summary(uuid, date, integer) from public, anon, authenticated;
grant execute on function public.claim_weekly_summary(uuid, date, integer) to service_role;

-- ai_calls 'WS' 사용자별 하루 셈용
create index if not exists idx_ai_calls_ws_user_time on public.ai_calls (user_id, created_at) where point = 'WS';
