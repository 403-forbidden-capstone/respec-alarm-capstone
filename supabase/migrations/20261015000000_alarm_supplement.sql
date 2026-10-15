-- =====================================================================
-- DB 보완 ① 알람 · 기록 칸 (10/15 작업 계획 P3 — 전체작업계획_v1.md 8절)
--   ① 일정 없는 알람 (D46)   alarms_one_source 완화 · alarms.recurrence_rule · time_source · intensity_source
--   ② 울림 기록 보완          alarm_events.client_event_id (중복 방지, Q11 A) · input_source (5장 R-16 · 7장 R-17)
--   ③ 고친 값 기록 표         user_edit_logs (F5 · F9 — 자동값 → 고친 값, 개인화 입력)
-- 그룹 기상 상태 · 신호 · 배치는 20261015000100 · 20261015000200 파일에 둠
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. ENUM 2개
-- ---------------------------------------------------------------------

-- 값이 자동 계산인지 사용자가 직접 정했는지 (R-5 intensity_source, 같은 모양으로 time_source)
create type public.alarm_value_source as enum ('AUTO', 'MANUAL');

-- 기록이 어떤 입력에서 왔는지 (R-16 BUTTON · LOCATION · VOICE · MANUAL + R-17 USAGE = 폰 사용 자동 기상 확정)
create type public.event_input_source as enum ('BUTTON', 'LOCATION', 'VOICE', 'MANUAL', 'USAGE');


-- ---------------------------------------------------------------------
-- 1. 일정 없는 알람 (D46 B) — 알람 목록 "+"에서 시각 · 반복만으로 만드는 알람
-- ---------------------------------------------------------------------
-- 약속(participant_id)도 루틴(routine_id)도 없는 알람을 허용함. 둘 다 있는 알람은 계속 막음
-- 만드는 곳은 alarm-commit(서버 함수, service_role). 클라이언트 INSERT 정책(alarms_insert_own)은 그대로라
-- 앱이 일정 없는 알람을 직접 넣으면 RLS가 거절함 (Q10: 약속 알람과 같은 길 · 서버 검증)

alter table public.alarms drop constraint alarms_one_source;
alter table public.alarms add constraint alarms_one_source check (participant_id is null or routine_id is null);

alter table public.alarms
  add column recurrence_rule  varchar(100),
  add column time_source      public.alarm_value_source not null default 'AUTO',
  add column intensity_source public.alarm_value_source not null default 'AUTO';

comment on column public.alarms.recurrence_rule  is '반복 규칙 (RFC 5545 RRULE, appointments.recurrence_rule과 같은 형식) — 일정 없는 알람용. 다음 회차 만들기는 D4 뒤';
comment on column public.alarms.time_source      is 'scheduled_at을 자동 계산했는지 사용자가 직접 골랐는지 — MANUAL이면 자동 재계산이 덮지 않고, "자동으로 되돌리기"로 AUTO 복귀 (D42 C · 작성자 판단: intensity_source와 같은 방식)';
comment on column public.alarms.intensity_source is '강도(intensity · voice_tone · sound_key)를 자동 산정했는지 직접 골랐는지 — MANUAL이면 자동 재계산이 덮지 않음 (5장 R-5 · 7장 7.4.1)';


-- ---------------------------------------------------------------------
-- 2. 울림 기록 — 중복 방지 · 입력 출처
-- ---------------------------------------------------------------------
-- 폰이 앱이 만든 번호(client_event_id)를 붙여 보내고, 같은 번호면 무시함 (Q11 A: on conflict (client_event_id) do nothing)
--   NULL은 서로 다른 값으로 취급되므로 번호 없이 넣던 기록은 영향 없음
--   부분 인덱스(where not null)로 만들지 않은 이유: supabase-js upsert의 onConflict가 where 조건을 못 붙여서 부분 인덱스는 못 찾음

alter table public.alarm_events
  add column client_event_id uuid,
  add column input_source    public.event_input_source,
  add constraint alarm_events_client_event_id_key unique (client_event_id);

comment on column public.alarm_events.client_event_id is '기록을 만든 쪽(폰 · 서버 함수)이 붙인 번호 — 같은 번호는 한 번만 저장 (오프라인 큐 재전송 중복 방지)';
comment on column public.alarm_events.input_source    is '입력 출처 — 버튼 · 위치 · 음성 · 직접 · 폰 사용(USAGE). 위치와 버튼 응답을 구분해 학습 표본을 고름 (비면 구분 안 함)';


-- ---------------------------------------------------------------------
-- 3. 고친 값 기록 — 자동값 → 고친 값 (F5 · F9, D42 C · D43)
-- ---------------------------------------------------------------------
-- 사용자가 H03 · H05 확인 시트 · S01에서 직접 바꾼 값을 남겨 다음 계산 · 제안의 개인화 입력으로 씀 (과제의 핵심)
-- 본인만 읽고 · 남기고 · 지움. 고쳐 쓰지 않는 기록이라 UPDATE 권한은 아예 없음
-- field는 앱 화면의 값 이름(buffer_minutes · prepare_minutes · travel_minutes · origin · transport · intensity ·
--   voice_tone · sound_key · alarm_enabled · scheduled_at 등)을 그대로 씀. 값 목록은 CHECK로 닫지 않음
--   (D42 · D53 범위가 아직 움직이고, 새 값이 생길 때마다 마이그레이션을 내는 것을 피함) — 이름 모양(소문자 · 숫자 · _)만 막음
-- auto_value · edited_value는 jsonb 한 칸에 값 하나(숫자 · 글자 · 시각 문자열) 또는 {...}를 넣음

create table public.user_edit_logs (
  edit_id        uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references public.profiles (user_id) on delete cascade,
  appointment_id uuid references public.appointments (appointment_id) on delete set null,   -- 일정이 지워져도 고친 기록은 남김
  alarm_id       uuid references public.alarms (alarm_id) on delete set null,
  screen         varchar(10) not null,                                -- 어느 화면에서 고쳤는지
  field          varchar(40) not null,                                -- 무엇을 고쳤는지 (앱 화면의 값 이름)
  alarm_type     public.alarm_type,                                   -- 알람 하나의 값이면 그 종류
  auto_value     jsonb,                                               -- 자동으로 계산했던 값 (없으면 NULL)
  edited_value   jsonb not null,                                      -- 사용자가 고친 값
  created_at     timestamptz not null default now(),
  constraint user_edit_logs_screen_check check (screen in ('H03', 'H05', 'S01')),
  constraint user_edit_logs_field_format check (field ~ '^[a-z][a-z0-9_]*$')
);

create index idx_user_edit_logs_user_time on public.user_edit_logs (user_id, created_at desc);
-- 일정 · 알람이 지워질 때 set null이 전체 훑기가 되지 않게
create index idx_user_edit_logs_appointment on public.user_edit_logs (appointment_id) where appointment_id is not null;
create index idx_user_edit_logs_alarm       on public.user_edit_logs (alarm_id)       where alarm_id is not null;

comment on table public.user_edit_logs is '고친 값 기록 — 자동값 → 사용자가 고친 값 (F5 · F9). 개인화 입력, 본인만';

alter table public.user_edit_logs enable row level security;

create policy user_edit_logs_select_own on public.user_edit_logs
  for select to authenticated
  using (user_id = (select auth.uid()));

-- 남기기: 본인 이름으로만, 연결한 일정 · 알람도 본인이 볼 수 있는 것이어야 함
create policy user_edit_logs_insert_own on public.user_edit_logs
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and (appointment_id is null or private.can_access_appointment(appointment_id))
              and (alarm_id is null or exists (
                     select 1 from public.alarms a
                     where a.alarm_id = user_edit_logs.alarm_id
                       and a.user_id = (select auth.uid()))));

create policy user_edit_logs_delete_own on public.user_edit_logs
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- anon은 막고, authenticated는 읽기 · 남기기 · 지우기만 (고치기 없음). 행 범위는 RLS가 정함
revoke all on public.user_edit_logs from anon, authenticated;
grant select, insert, delete on public.user_edit_logs to authenticated;
grant select, insert, update, delete on public.user_edit_logs to service_role;
