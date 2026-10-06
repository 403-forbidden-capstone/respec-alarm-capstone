-- =====================================================================
-- Re:Spec Alarm 기본 스키마 (상세설계서 4장 v2 기준)
--   ENUM 19개 · 테이블 15개 · 제약조건 · 인덱스 · 예상 준비시간 뷰
--   updated_at 자동 갱신 트리거(4.7) · 가입하면 profiles 행을 만드는 트리거 · 시간대 값 검사(4장 외)
-- 4장에 없는 목업 보완 5개는 20261007000100_mockup_extras.sql에 둠
-- RLS · 실행 권한은 20261007000200_rls.sql에서 켬
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. ENUM (4.5)
-- ---------------------------------------------------------------------

create type public.transport_type          as enum ('WALK', 'TRANSIT', 'BUS', 'SUBWAY', 'CAR');
create type public.friend_status           as enum ('PENDING', 'ACCEPTED', 'BLOCKED');
create type public.invite_status           as enum ('INVITED', 'JOINED', 'LEFT');
create type public.permission_source       as enum ('FRIEND', 'GROUP');
create type public.importance_level        as enum ('LOW', 'NORMAL', 'HIGH');
create type public.travel_source           as enum ('API', 'CACHED', 'MANUAL');
create type public.alarm_type              as enum ('WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE', 'ROUTINE');
create type public.alarm_intensity         as enum ('SOFT', 'NORMAL', 'STRONG');
create type public.voice_tone              as enum ('CALM', 'NEUTRAL', 'DIRECT');
create type public.alarm_event_type        as enum ('TRIGGERED', 'SNOOZED', 'DISMISSED', 'WAKE_CONFIRMED',
                                                    'ARRIVAL_CONFIRMED', 'MISSED', 'FEEDBACK');
create type public.alarm_feedback_type     as enum ('GOOD', 'TOO_LOUD', 'TOO_QUIET', 'VOICE_DISLIKE', 'SOUND_DISLIKE');
create type public.alarm_suggestion_type   as enum ('VOICE_TONE', 'SOUND', 'INTENSITY');
create type public.alarm_suggestion_status as enum ('PENDING', 'APPLIED', 'EDITED', 'IGNORED');
create type public.routine_origin          as enum ('USER', 'AI_SUGGESTED');
create type public.session_type            as enum ('BEFORE_SLEEP', 'AFTER_WAKE', 'ANYTIME');
create type public.input_mode              as enum ('VOICE', 'TEXT');
create type public.apply_status            as enum ('PENDING', 'APPLIED', 'REJECTED');
create type public.todo_type               as enum ('TASK', 'ITEM');
create type public.record_source           as enum ('MANUAL', 'ALARM', 'AI');


-- ---------------------------------------------------------------------
-- 2. 사용자
-- ---------------------------------------------------------------------

create table public.profiles (
  user_id                 uuid primary key references auth.users (id) on delete cascade,
  nickname                varchar(30) not null,
  profile_image_url       text,                                        -- Storage 경로
  default_prepare_minutes integer not null default 60,
  default_buffer_minutes  integer not null default 10,                 -- 알람 역산 때 더함
  home_name               varchar(200),
  home_lat                numeric(9, 6),
  home_lng                numeric(9, 6),
  default_transport       public.transport_type not null default 'TRANSIT',
  timezone                varchar(40) not null default 'Asia/Seoul',   -- 알람 시각 계산 기준
  preferred_voice_tone    public.voice_tone,                           -- 비면 시스템 기본값 (FR-1-9)
  preferred_sound_key     varchar(40),                                 -- 비면 기본 테마 (FR-1-9)
  intensity_offset        smallint not null default 0,                 -- 제안 적용 결과 반영 (FR-1-10)
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint profiles_default_prepare_minutes_range check (default_prepare_minutes between 0 and 600),
  constraint profiles_intensity_offset_range check (intensity_offset between -1 and 1)
);


-- ---------------------------------------------------------------------
-- 3. 소셜 · 권한
-- ---------------------------------------------------------------------

create table public.friends (
  friend_id    uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (user_id) on delete cascade,
  addressee_id uuid not null references public.profiles (user_id) on delete cascade,
  status       public.friend_status not null default 'PENDING',
  requested_at timestamptz not null default now(),
  accepted_at  timestamptz,
  constraint friends_requester_addressee_key unique (requester_id, addressee_id),
  constraint friends_no_self check (requester_id <> addressee_id)
);

-- (4장 외 추가) 4.5 목적 "같은 두 사용자 사이 중복 금지"를 방향과 상관없이 지키도록 함 (A→B가 있으면 B→A 금지)
create unique index friends_pair_key
  on public.friends (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

-- (4장 외 추가) 받은 요청 조회 · RLS 판정용
create index idx_friends_addressee on public.friends (addressee_id);

create table public.groups (
  group_id    uuid primary key default gen_random_uuid(),
  group_name  varchar(50) not null,
  description varchar(200),
  owner_id    uuid not null references public.profiles (user_id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- (4장 외 추가) 만든 그룹 조회 · 탈퇴 시 CASCADE용
create index idx_groups_owner on public.groups (owner_id);

create table public.group_members (
  group_member_id   uuid primary key default gen_random_uuid(),
  group_id          uuid not null references public.groups (group_id) on delete cascade,
  user_id           uuid not null references public.profiles (user_id) on delete cascade,
  invite_status     public.invite_status not null default 'INVITED',
  wake_share_opt_in boolean not null default false,                    -- 이 그룹에 기상 상태 공유 동의
  joined_at         timestamptz,
  constraint group_members_group_user_key unique (group_id, user_id)
);

create index idx_group_members_user on public.group_members (user_id, invite_status);

create table public.sharing_permissions (
  permission_id  uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.profiles (user_id) on delete cascade,   -- 정보 주인 (권한을 준 사람)
  grantee_id     uuid not null references public.profiles (user_id) on delete cascade,   -- 권한을 받은 사람
  source_type    public.permission_source not null,
  source_id      uuid not null,                       -- friend_id 또는 group_id (논리 참조라 FK 없음, 4.4)
  can_view_alarm boolean not null default false,
  can_edit_alarm boolean not null default false,
  can_view_wake  boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint sharing_permissions_source_key unique (owner_id, grantee_id, source_type, source_id),
  constraint sharing_permissions_no_self check (owner_id <> grantee_id)
);

create index idx_sharing_grantee on public.sharing_permissions (grantee_id, owner_id);


-- ---------------------------------------------------------------------
-- 4. 일정 · 알람
-- ---------------------------------------------------------------------

create table public.appointments (
  appointment_id  uuid primary key default gen_random_uuid(),
  creator_id      uuid not null references public.profiles (user_id) on delete cascade,
  group_id        uuid references public.groups (group_id) on delete cascade,  -- NULL이면 개인 일정
  title           varchar(100) not null,
  appointment_at  timestamptz not null,                                        -- 알람 역산 기준
  dest_name       varchar(200) not null,
  dest_lat        numeric(9, 6),
  dest_lng        numeric(9, 6),
  importance      public.importance_level not null default 'NORMAL',          -- 알람 강도 산정 기준 (FR-1-7)
  recurrence_rule varchar(100),                                                -- RFC 5545 RRULE
  memo            varchar(500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_appointments_creator_time on public.appointments (creator_id, appointment_at);
create index idx_appointments_group_time   on public.appointments (group_id, appointment_at) where group_id is not null;

create table public.appointment_participants (
  participant_id        uuid primary key default gen_random_uuid(),
  appointment_id        uuid not null references public.appointments (appointment_id) on delete cascade,
  user_id               uuid not null references public.profiles (user_id) on delete cascade,
  origin_name           varchar(200),                                -- 비면 기본 출발지
  origin_lat            numeric(9, 6),
  origin_lng            numeric(9, 6),
  transport_type        public.transport_type not null default 'TRANSIT',
  est_travel_minutes    integer,                                     -- 경로 API 조회 결과 (실패 대비 NULL 허용)
  actual_travel_minutes integer,                                     -- 개인화 학습용 (FR-1-6)
  travel_source         public.travel_source not null default 'API',
  prepare_minutes       integer not null default 60,                 -- 약속 시점 값을 그대로 보관 (4.4)
  buffer_minutes        integer not null default 10,
  departed_at           timestamptz,
  arrived_at            timestamptz,                                 -- 도착 확인 시각 (FR-1-8)
  is_late               boolean,                                     -- 도착 확인이 없으면 NULL (4.7)
  late_minutes          integer,
  updated_at            timestamptz not null default now(),
  constraint appointment_participants_appointment_user_key unique (appointment_id, user_id)
);

create index idx_participants_user on public.appointment_participants (user_id, appointment_id);
create index idx_participants_late on public.appointment_participants (user_id, arrived_at desc) where is_late;


-- ---------------------------------------------------------------------
-- 5. AI 대화 · 기록 · 루틴 (alarms가 routines를 참조하므로 먼저 만듦)
-- ---------------------------------------------------------------------

create table public.conversation_sessions (
  session_id     uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (user_id) on delete cascade,
  session_type   public.session_type not null,
  input_mode     public.input_mode not null default 'VOICE',          -- FR-3-5
  started_at     timestamptz not null default now(),
  ended_at       timestamptz,
  transcript     text,                                                -- STT 변환 텍스트만 (음성 원본은 저장 안 함)
  extracted_data jsonb,                                               -- 일정 · 할 일 · 준비물 추출 결과
  apply_status   public.apply_status not null default 'PENDING',
  created_at     timestamptz not null default now()
);

create index idx_sessions_user_time on public.conversation_sessions (user_id, started_at desc);

create table public.daily_journals (
  journal_id         uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (user_id) on delete cascade,
  record_date        date not null,
  source_session_id  uuid references public.conversation_sessions (session_id) on delete set null,
  ai_summary         text,                                            -- AI 원본 보존
  edited_summary     text,                                            -- 고쳤을 때만 저장
  is_edited          boolean not null default false,
  coaching_insight   text,                                            -- FR-6-1
  encouragement      text,
  routine_suggestion text,
  suggestion_status  public.apply_status not null default 'PENDING', -- 수락 때만 routines 생성
  sentiment          smallint,
  generated_at       timestamptz,
  updated_at         timestamptz not null default now(),
  constraint daily_journals_user_date_key unique (user_id, record_date),
  constraint daily_journals_sentiment_range check (sentiment between 1 and 5)
);

create index idx_journals_user_date on public.daily_journals (user_id, record_date desc);
create index idx_journals_pending   on public.daily_journals (user_id) where suggestion_status = 'PENDING';

create table public.routines (
  routine_id        uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (user_id) on delete cascade,
  source_journal_id uuid references public.daily_journals (journal_id) on delete set null,
  title             varchar(60) not null,
  goal              varchar(200),
  repeat_days       varchar(20) not null default 'MON~FRI',            -- 요일 코드 집합
  steps             jsonb not null default '[]'::jsonb,                -- [{order, title, offset, type, is_alarm}]
  origin            public.routine_origin not null default 'AI_SUGGESTED',
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint routines_steps_is_array check (jsonb_typeof(steps) = 'array')
);

create index idx_routines_user_active on public.routines (user_id, is_active);

create table public.todos (
  todo_id           uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (user_id) on delete cascade,
  appointment_id    uuid references public.appointments (appointment_id) on delete set null,
  source_session_id uuid references public.conversation_sessions (session_id) on delete set null,
  title             varchar(100) not null,
  todo_type         public.todo_type not null default 'TASK',
  due_date          date,
  is_done           boolean not null default false,
  done_at           timestamptz,
  created_at        timestamptz not null default now()
);

create index idx_todos_open on public.todos (user_id, due_date) where is_done = false;
-- (4장 외 추가) 완료한 항목까지 포함한 본인 목록 · RLS 판정용 (위 인덱스는 미완료만 담음)
create index idx_todos_user on public.todos (user_id);

create table public.daily_records (
  record_id              uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles (user_id) on delete cascade,
  record_date            date not null,
  sleep_at               timestamptz,
  wake_reported_at       timestamptz,                                 -- 알람 해제 시각
  wake_confirmed_at      timestamptz,                                 -- '일어났어요' 기상 확인 시각
  actual_prepare_minutes integer,
  routine_done_rate      smallint,                                    -- FR-6-4
  sleep_satisfaction     smallint,
  condition_note         varchar(200),
  data_source            public.record_source not null default 'MANUAL',
  updated_at             timestamptz not null default now(),
  constraint daily_records_user_date_key unique (user_id, record_date),
  constraint daily_records_sleep_satisfaction_range check (sleep_satisfaction between 1 and 5),
  constraint daily_records_routine_done_rate_range check (routine_done_rate between 0 and 100)
);


-- ---------------------------------------------------------------------
-- 6. 알람 · 반응 이력 · 수정 제안
-- ---------------------------------------------------------------------

create table public.alarms (
  alarm_id           uuid primary key default gen_random_uuid(),
  participant_id     uuid references public.appointment_participants (participant_id) on delete cascade,  -- 약속 기반
  routine_id         uuid references public.routines (routine_id) on delete cascade,                      -- 루틴 기반
  step_order         integer,                                         -- routines.steps의 order 값
  user_id            uuid not null references public.profiles (user_id) on delete cascade,  -- RLS · 조회용 (4.4)
  alarm_type         public.alarm_type not null,
  scheduled_at       timestamptz not null,                            -- 역산 결과
  intensity          public.alarm_intensity not null default 'NORMAL',
  voice_tone         public.voice_tone not null default 'NEUTRAL',
  sound_key          varchar(40),                                     -- 테마별 배경음 식별자
  is_enabled         boolean not null default true,
  snooze_limit       integer not null default 3,
  last_calculated_at timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint alarms_one_source check ((participant_id is null) <> (routine_id is null)),
  constraint alarms_routine_step_required check (routine_id is null or step_order is not null)
);

create unique index alarms_participant_type_key on public.alarms (participant_id, alarm_type) where participant_id is not null;
create unique index alarms_routine_step_key     on public.alarms (routine_id, step_order)      where routine_id is not null;
create index idx_alarms_due       on public.alarms (scheduled_at) where is_enabled = true;
create index idx_alarms_user_time on public.alarms (user_id, scheduled_at);

create table public.alarm_events (
  event_id       bigserial primary key,
  alarm_id       uuid not null references public.alarms (alarm_id) on delete cascade,
  user_id        uuid not null references public.profiles (user_id) on delete cascade,
  event_type     public.alarm_event_type not null,
  event_at       timestamptz not null default now(),
  snooze_minutes integer,                                             -- SNOOZED에만 씀
  feedback_type  public.alarm_feedback_type,                          -- FEEDBACK에만 씀 (FR-1-9)
  sequence_no    integer not null default 1,                          -- 울림 회차
  created_at     timestamptz not null default now(),
  constraint feedback_type_only_on_feedback check ((event_type = 'FEEDBACK') = (feedback_type is not null))
);

-- 한 알람의 평가는 한 건만 두고 재평가 때 갱신함
create unique index idx_alarm_events_one_feedback on public.alarm_events (alarm_id) where event_type = 'FEEDBACK';
create index idx_alarm_events_alarm    on public.alarm_events (alarm_id, event_at desc);
create index idx_alarm_events_user     on public.alarm_events (user_id, event_at desc);
create index idx_alarm_events_feedback on public.alarm_events (user_id, event_at desc) where event_type = 'FEEDBACK';

create table public.alarm_suggestions (
  suggestion_id   uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (user_id) on delete cascade,
  target_alarm_id uuid references public.alarms (alarm_id) on delete set null,       -- 알람이 지워져도 제안 이력은 남김
  source_event_id bigint references public.alarm_events (event_id) on delete set null,
  suggestion_type public.alarm_suggestion_type not null,
  current_value   varchar(40),
  suggested_value varchar(40) not null,
  result_value    varchar(40),                                        -- 직접 고친 값 포함
  status          public.alarm_suggestion_status not null default 'PENDING',
  suppress_until  timestamptz,                                        -- 이 시각 전까지 같은 종류 제안 금지
  responded_at    timestamptz,
  created_at      timestamptz not null default now(),
  constraint suggestion_result_required check ((status in ('APPLIED', 'EDITED')) = (result_value is not null)),
  constraint suggestion_responded_required check (status = 'PENDING' or responded_at is not null)
);

create index idx_suggestions_user_pending on public.alarm_suggestions (user_id, created_at desc) where status = 'PENDING';
create index idx_suggestions_user_type    on public.alarm_suggestions (user_id, suggestion_type, created_at desc);


-- ---------------------------------------------------------------------
-- 7. 예상 준비시간 뷰 (FR-1-3) — 저장하지 않고 계산함
-- ---------------------------------------------------------------------

-- security_invoker: 부른 사람의 RLS를 따르므로 본인 통계만 보임
create view public.v_prepare_time_stats
with (security_invoker = true)
as
select user_id,
       count(*)                                                           as sample_count,
       percentile_cont(0.8) within group (order by actual_prepare_minutes) as p80_minutes
from public.daily_records
where actual_prepare_minutes is not null
group by user_id;


-- ---------------------------------------------------------------------
-- 8. 테이블 설명 (Studio에 보임)
-- ---------------------------------------------------------------------

comment on table public.profiles                 is '사용자 프로필 — auth.users와 1:1';
comment on table public.friends                  is '친구 관계';
comment on table public.groups                   is '그룹';
comment on table public.group_members            is '그룹 구성원 — 초대 상태 · 기상 공유 동의';
comment on table public.sharing_permissions      is '공유 권한 — 친구 · 그룹 출처별 한 행';
comment on table public.appointments             is '약속 — group_id가 NULL이면 개인 일정';
comment on table public.appointment_participants is '약속 참여 조건 — 참여자별 출발지 · 이동 · 준비 · 도착 결과';
comment on table public.alarms                   is '알람 — 약속 또는 루틴에서 생성';
comment on table public.alarm_events             is '알람 반응 · 평가 이력';
comment on table public.alarm_suggestions        is '알람 수정 제안 이력';
comment on table public.routines                 is '알람 루틴 — 단계는 steps(JSONB)';
comment on table public.conversation_sessions    is 'AI 대화 세션 — 음성 원본은 저장 안 함';
comment on table public.todos                    is '할 일 · 준비물';
comment on table public.daily_records            is '생활 기록 — 관측값';
comment on table public.daily_journals           is '하루 요약 — AI 일기와 코칭 결과';


-- ---------------------------------------------------------------------
-- 9. updated_at 자동 갱신 (4.7 "갱신 시각 관리")
-- ---------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.groups
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.sharing_permissions
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.appointments
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.appointment_participants
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.alarms
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.routines
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.daily_records
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.daily_journals
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 10. 가입하면 profiles 행을 만듦 (카카오 · 구글 OAuth 메타데이터에서 이름 · 사진을 가져옴)
-- ---------------------------------------------------------------------

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_nickname text;
begin
  -- 닉네임은 필수라 메타데이터에 없으면 이메일 앞부분, 그것도 없으면 '사용자'로 채움
  v_nickname := coalesce(
    nullif(btrim(v_meta ->> 'nickname'), ''),
    nullif(btrim(v_meta ->> 'name'), ''),
    nullif(btrim(v_meta ->> 'full_name'), ''),
    nullif(btrim(v_meta ->> 'user_name'), ''),
    nullif(btrim(v_meta ->> 'preferred_username'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    '사용자'
  );

  insert into public.profiles (user_id, nickname, profile_image_url)
  values (
    new.id,
    left(v_nickname, 30),
    coalesce(nullif(v_meta ->> 'avatar_url', ''), nullif(v_meta ->> 'picture', ''))
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------
-- 11. (4장 외 추가) 시간대 값 검사
-- ---------------------------------------------------------------------
-- profiles.timezone은 PostgreSQL이 아는 이름(pg_timezone_names)만 받음
--   모르는 값이 들어가면 시각 계산(get_group_wake_status 등)이 오류로 멈추므로 저장할 때 막음
--   CHECK 제약은 다른 테이블 · 뷰를 못 읽어서 트리거로 함

create function public.check_profile_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_timezone_names t
    where t.name = new.timezone
  ) then
    raise exception '알 수 없는 시간대: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger check_timezone before insert or update of timezone on public.profiles
  for each row execute function public.check_profile_timezone();
