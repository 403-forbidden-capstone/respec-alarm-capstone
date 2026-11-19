-- 루틴 제안 (안건 D114 · D30 B) 1단계 — 저장 자리. 만드는 쪽(18:00 배치)과 화면(일기 화면 · 저녁 대화 카드)은 다음 PR
--   규칙은 supabase/functions/_shared/calc/routine.ts (#557): 기록이 있는 최근 아침 7번 중 같은 원인 4번 이상 → 원인별 2단계 루틴 초안
--   D30 B: 일기 줄의 routine_suggestion 글 칸 대신 표를 따로 — 수연님 일기 만들기와 루틴 제안이 서로 기다리지 않게
--
-- 1. 원인 · 상태 종류
-- 2. routine_suggestions 표 — 한 사람당 기다리는 제안은 하나, 답하면(받아들임 · 넘김) 답한 시각이 같이, 만든 루틴은 받아들였을 때만
-- 3. 권한 — 본인만 읽고 답함(상태 · 답한 시각 · 만든 루틴 칸만), 만드는 건 서버만(insert 정책 없음). anon은 아무 권한 없음
-- 4. 내 시험 데이터 지우기(dev_reset_my_data)가 루틴 제안도 지움 — 20261111160000 정의에 한 줄 더함

-- ---------------------------------------------------------------------
-- 1. 원인 · 상태
-- ---------------------------------------------------------------------
create type public.routine_suggestion_cause as enum ('OVERSLEEP', 'LATE_START', 'NIGHT_PREP'); -- 늦잠 · 다시 잠듦 / 준비를 늦게 시작 / 전날 준비 부족
create type public.routine_suggestion_status as enum ('PENDING', 'ACCEPTED', 'IGNORED'); -- 기다림 / 받아들임 / 넘김

-- ---------------------------------------------------------------------
-- 2. 표
-- ---------------------------------------------------------------------
create table public.routine_suggestions (
  suggestion_id uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (user_id) on delete cascade,
  cause         public.routine_suggestion_cause not null,
  title         varchar(60) not null,             -- 루틴 이름 초안 ("일어나자마자 2단계")
  reason        varchar(200) not null,            -- 화면 근거 한 줄 ("최근 아침 7번 중 4번, 기상 알람 뒤 평균 18분 만에 일어났어요")
  evidence      jsonb not null default '{}'::jsonb, -- { dates, average, missed } — calc/routine.ts RoutineDraft.evidence
  draft         jsonb not null,                   -- { goal, days, steps } — 받아들이면 루틴 편집(A04)에 채워 엶
  status        public.routine_suggestion_status not null default 'PENDING',
  routine_id    uuid references public.routines (routine_id) on delete set null, -- 받아들여 만든 루틴
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  constraint routine_suggestions_evidence_object check (jsonb_typeof(evidence) = 'object'),
  constraint routine_suggestions_draft_object check (jsonb_typeof(draft) = 'object'),
  constraint routine_suggestions_responded check ((status = 'PENDING') = (responded_at is null)),
  constraint routine_suggestions_routine_when_accepted check (routine_id is null or status = 'ACCEPTED')
);

create unique index routine_suggestions_one_pending on public.routine_suggestions (user_id) where status = 'PENDING';
create index routine_suggestions_user_created on public.routine_suggestions (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- 3. 권한
-- ---------------------------------------------------------------------
alter table public.routine_suggestions enable row level security;

create policy routine_suggestions_select_own on public.routine_suggestions
  for select to authenticated using (user_id = (select auth.uid()));

-- 답하기: 본인 제안만, 만든 루틴을 적으면 본인 루틴이어야 함
create policy routine_suggestions_update_own on public.routine_suggestions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (routine_id is null or exists (select 1 from public.routines r where r.routine_id = routine_suggestions.routine_id and r.user_id = (select auth.uid())))
  );

revoke all on public.routine_suggestions from anon, authenticated;
grant select on public.routine_suggestions to authenticated;
grant update (status, responded_at, routine_id) on public.routine_suggestions to authenticated;
grant select, insert, update, delete on public.routine_suggestions to service_role;

-- ---------------------------------------------------------------------
-- 4. 내 시험 데이터 지우기 — 루틴 제안도 (나머지는 20261111160000과 같음)
-- ---------------------------------------------------------------------
create or replace function public.dev_reset_my_data()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text;
  v_friend  jsonb;
  v_result  jsonb;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_email is null or v_email not like '%@example.com' then
    raise exception '시험 계정만 쓸 수 있음' using errcode = '42501';
  end if;

  -- Keep the existing relationship/alarm/profile reset order and JSON shape.
  v_friend := private.dev_reset_friend_data(v_uid);
  v_result := private.dev_reset_my_data_core();

  -- Drop the trusted server-side mapping regardless of whether the client
  -- survey was ever filled in; do not modify any other user's mapping.
  delete from public.prepare_ml_verified_profiles where user_id = v_uid;

  -- 루틴 제안(20261120090000)도 시험 데이터로 지움 — 알람 조정 제안과 같음. 받아들여 만든 루틴은 그대로(루틴은 남기는 표)
  delete from public.routine_suggestions where user_id = v_uid;

  -- Reset voluntary consented answers and the obsolete client-writable
  -- experimental codes. Updating the survey columns also triggers
  -- invalidate_prepare_ml_verification_on_survey_change.
  update public.profiles p
     set ml_age_years = null,
         ml_school_status = null,
         ml_work_status = null,
         ml_holiday_code = null,
         ml_profile_consented_at = null,
         ml_age_code = null,
         ml_education_code = null,
         ml_economic_code = null,
         ml_codes_verified = false
   where p.user_id = v_uid;

  return v_result || jsonb_build_object('friend_data', v_friend);
end;
$$;

revoke all on function public.dev_reset_my_data() from public, anon;
grant execute on function public.dev_reset_my_data() to authenticated;
