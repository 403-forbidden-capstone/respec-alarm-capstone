-- =====================================================================
-- AI 대화 서버 상태 · 호출 기록 (L4 PR 2, Refs #42)
--   ① conversation_sessions.turns · server_state — 서버 함수는 매번 새로 떠서, 턴마다 이전 대화 · 서버 상태를 DB에서 읽어야 함
--   ② ai_calls — AI 호출마다 한 줄 (프롬프트 판 · 지연 · 토큰 · 규칙 걸림). 주 1회 프롬프트 고치기 루프 + 대화당 비용 재기의 입력
--   ③ user_edit_logs.screen에 A02 (AI 대화에서 고친 값) — 5절
--   ④ user_questions — 질문 예산(하루 1 · 주 3 · 같은 질문 24시간 반복 금지)을 채널 합쳐서 셈하는 공용 자리 — 6절
-- 칸 이름은 공급자 중립 (지금은 Claude Haiku 5.5, 나중에 Gemini도 올 수 있음) — 토큰 종류가 없는 쪽은 NULL로 둠
-- 쓰는 곳은 서버 함수(voice-session · voice-turn · voice-commit · journal-coach, service_role)뿐. 앱은 읽기만
--   (conversation_sessions의 두 칸은 이 파일 4절의 트리거가, ai_calls는 권한이 막음)
-- 파일 이름의 시각은 머지 직전에 npx supabase migration new로 다시 받음 (마이그레이션 머지 큐)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. conversation_sessions — 대화 턴 · 서버 상태
-- ---------------------------------------------------------------------
-- 이미 profiles 삭제 때 CASCADE인 표(init_schema)에 칸만 더함 → 탈퇴(Q7)하면 대화 턴도 같이 지워짐
-- 모양은 서버 함수 코드가 정함. DB는 jsonb 종류(배열 · 객체)만 확인하고 안쪽은 검사하지 않음
--   (프롬프트 판이 바뀔 때마다 마이그레이션을 내지 않으려고. routines.steps와 같은 방식)
-- 이 표에는 본인 insert · update 정책이 있어서(rls) 로그인 사용자가 자기 줄의 두 칸을 직접 고칠 수 있음
--   (예: 말 수를 0으로 되돌림) → 4절 트리거로 서버 키(service_role)만 두 칸을 쓰게 막음
--   막는 것은 줄에 쓰는 두 칸까지임. 본인 insert · delete 정책으로 새 대화 줄을 만들어 처음부터 다시 시작하는 것은 못 막으므로
--   하루 대화 수 · 사용자별 상한은 서버만 쓰는 기록(ai_calls 등)으로 세야 함 (서버 함수 PR 몫)

alter table public.conversation_sessions
  add column turns        jsonb not null default '[]'::jsonb,
  add column server_state jsonb not null default '{}'::jsonb,
  add constraint conversation_sessions_turns_is_array check (jsonb_typeof(turns) = 'array'),
  add constraint conversation_sessions_server_state_is_object check (jsonb_typeof(server_state) = 'object');

comment on column public.conversation_sessions.turns is
  '대화 말 목록, 오래된 것부터 — [{ role: user | ai | system, text, at(시각), 처리 결과 줄, 찾은 일정 카드 참조 등 }]. 서버 함수가 턴마다 읽고 덧붙임. transcript(글 전체)와 달리 말 단위 (음성 원본은 저장 안 함)';
comment on column public.conversation_sessions.server_state is
  '서버가 턴 사이에 넘기는 상태 — { 확인 대기 중인 c번호, 무음 수, 위기 안내 여부, 서버 질문 물음 여부, 말 수 }. AI가 아니라 서버가 쥐는 값 (서버 지침 5 · 12)';


-- ---------------------------------------------------------------------
-- 2. ai_calls — AI 호출 기록
-- ---------------------------------------------------------------------
-- 호출 하나 = 한 줄. 성공 · 실패 모두 남김 (실패율 · 재시도도 고치기 루프의 입력)
-- user_id: profiles 삭제 때 CASCADE — 계정을 지우면(Q7) 내 AI 호출 기록도 같이 지움
-- session_id: 대화를 지워도 호출 기록(지연 · 토큰 · 비용)은 남김 = SET NULL.
--   고친 값 기록(user_edit_logs) · 일기 · 할 일이 원본 대화 연결을 SET NULL로 두는 것과 같고,
--   "대화당 비용"(E2 안건)과 주간 집계가 대화를 지운다고 줄어들지 않게 하려는 것
--   (대화 글이 든 io까지 남는 점은 io 주석 참고. 계정 삭제는 user_id CASCADE가 모두 지움)
-- 쓰기는 service_role뿐: 앱 역할(authenticated)에는 INSERT · UPDATE · DELETE 권한도 정책도 없음
--   → 앱이 호출 기록을 지어내거나 지울 수 없음. 본인 것은 읽을 수 있음
-- PK 이름은 다른 앱 표(session_id · edit_id · event_id)처럼 <명사>_id

create table public.ai_calls (
  call_id            uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (user_id) on delete cascade,
  session_id         uuid references public.conversation_sessions (session_id) on delete set null,
  point              text not null,                                   -- 어느 지점의 호출인지
  prompt_id          text not null,                                   -- 프롬프트 이름 (T1 · T2F · T2 · T3 · T4 · T5 · ASSIST_E4 등)
  prompt_version     text not null,                                   -- 프롬프트 판 (v1.3 · v2-a 등) — 판마다 규칙 걸림 · 지연을 비교
  model              text not null,                                   -- 부른 모델 이름 (공급자 중립 문자열)
  ok                 boolean not null,
  error_code         text,                                            -- 실패 때 세분 코드 (아래 comment 참고), 성공이면 NULL
  latency_ms         integer not null,                                -- 호출 시작부터 끝까지 걸린 시간 (재시도가 있었으면 attempts와 같이 봄)
  attempts           smallint not null default 1,                     -- 재시도 포함 시도 횟수. 0 = 요청을 보내기 전에 실패(키 없음 · 설정 오류 등)
  input_tokens       integer,                                         -- 아래 토큰 칸은 실패하거나 그 공급자에 없는 값이면 NULL
  output_tokens      integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  thinking_tokens    integer,
  cost_usd           numeric(10, 6),                                  -- 서버가 토큰 × 단가로 계산한 값 (모르면 NULL)
  stop_reason        text,                                            -- 공급자가 준 끝난 까닭 (end_turn · max_tokens 등)
  request_id         text,                                            -- 공급자 요청 번호 (문의 · 추적용)
  flags              text[] not null default '{}',                    -- 규칙 걸림 코드 (실험실 AUTO_FLAGS 이름 그대로)
  io                 jsonb,                                           -- 호출 입력 · 출력 글 (L6 안건후보: 대화 기록 보관 기본안 — 아래 comment 참고)
  created_at         timestamptz not null default now(),
  constraint ai_calls_point_check check (point in ('T1', 'T2F', 'T2', 'T3', 'T4', 'T5', 'E4')),
  constraint ai_calls_latency_ms_check check (latency_ms >= 0),
  constraint ai_calls_attempts_check check (attempts >= 0),
  constraint ai_calls_tokens_check check (
    coalesce(input_tokens, 0) >= 0 and coalesce(output_tokens, 0) >= 0
    and coalesce(cache_read_tokens, 0) >= 0 and coalesce(cache_write_tokens, 0) >= 0
    and coalesce(thinking_tokens, 0) >= 0
  ),
  constraint ai_calls_cost_usd_check check (cost_usd >= 0)
);

-- 본인 기록 최근순 / 주 1회 집계(기간 안 전체) / 대화 하나의 호출 모아 보기 · 대화 삭제 때 SET NULL이 전체 훑기가 되지 않게
--   지점별 집계(point, created_at)는 따로 만들지 않음 — 한 주치 호출이 많지 않아 기간 범위로 훑어도 충분
create index idx_ai_calls_user_time on public.ai_calls (user_id, created_at desc);
create index idx_ai_calls_time      on public.ai_calls (created_at);
create index idx_ai_calls_session   on public.ai_calls (session_id) where session_id is not null;

comment on table public.ai_calls is 'AI 호출 기록 — 호출마다 한 줄 (프롬프트 판 · 지연 · 토큰 · 규칙 걸림). 서버 함수(service_role)만 쓰고 본인은 읽기만';
comment on column public.ai_calls.session_id is
  '이 호출이 속한 대화. 대화를 지워도 호출 기록은 남음(io 포함) — 이때 NULL이 됨. 계정 삭제(Q7)는 user_id cascade로 모두 지움';
comment on column public.ai_calls.point is '호출 지점: T1 대화 답 · T2F 빠른 추출 · T2 끝 추출 · T3 이유 태그 · T4 일기(대화 없는 날) · T5 일기 · 코칭 · 응원 · E4 추천 비서';
comment on column public.ai_calls.error_code is
  '실패 때 세분 코드 — NOT_CONFIGURED · TIMEOUT · RATE_LIMITED · UPSTREAM · AUTH · BAD_REQUEST · REFUSED · TRUNCATED · BAD_OUTPUT (서버 AI 호출 기반, PR #248). 성공이면 NULL. 사용자에게 돌려주는 LLM_UNAVAILABLE이 아니라 집계용 (값 목록은 CHECK로 닫지 않음)';
comment on column public.ai_calls.flags is '이 호출의 결과에 걸린 규칙 코드 (실험실 checks.ts AUTO_FLAGS 이름 그대로, 소문자 예: promises_save). 코드별 집계가 주 1회 고칠 것 고르기의 입력';
comment on column public.ai_calls.io is
  '호출 입력 · 출력 글 (모양은 서버 함수가 정함, 예: { input, output }). L6 안건후보 "대화 기록 보관" 기본안 B: 시드 · 팀 계정 호출만 채우고 일반 사용자는 NULL — 어느 계정이 채울지는 서버 함수가 정함 (DB는 안 가림). 개인 정보라 채웠다면 대화 글과 같은 취급';


-- ---------------------------------------------------------------------
-- 3. RLS · 권한 — 본인 읽기만, 쓰기는 서버 키만
-- ---------------------------------------------------------------------

alter table public.ai_calls enable row level security;

-- 정책은 읽기 하나뿐. INSERT · UPDATE · DELETE 정책이 없으면 authenticated는 RLS에서도 거절됨 (service_role은 RLS를 건너뜀)
create policy ai_calls_select_own on public.ai_calls
  for select to authenticated
  using (user_id = (select auth.uid()));

-- 새 표는 기본으로 API 역할에 열려 있을 수 있어서 직접 정함: anon은 막고, authenticated는 읽기만
revoke all on public.ai_calls from anon, authenticated;
grant select on public.ai_calls to authenticated;
grant select, insert, update, delete on public.ai_calls to service_role;


-- ---------------------------------------------------------------------
-- 4. conversation_sessions 두 칸(turns · server_state)은 서버 키만 씀
-- ---------------------------------------------------------------------
-- 두 칸은 AI가 아니라 서버가 쥐는 값(말 수 · 확인 대기 · 위기 안내 여부)이라, 앱이 직접 쓰면 안 됨
-- 다른 칸(transcript · extracted_data · apply_status 등 기존 앱이 쓰는 칸)은 지금처럼 본인이 고칠 수 있음
-- 역할은 current_user로 가림: PostgREST가 요청마다 SET ROLE로 anon · authenticated · service_role을 정하므로 JWT 값보다 속이기 어려움
--   앱 역할(anon · authenticated)만 막고, 서버 함수(service_role) · 마이그레이션 · 대시보드(postgres)는 통과
--   일부러 SECURITY INVOKER (prevent_key_change와 같음) — DEFINER면 current_user가 함수 주인으로 바뀌어 가려내지 못함
-- 만들 때(insert)도 기본값([] · {}) 아닌 값은 거절함 (넣은 뒤 고치기와 같은 구멍을 막으려고. 기본값으로 덮지 않고 오류로 알림)

create function private.server_only_session_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.turns is distinct from '[]'::jsonb or new.server_state is distinct from '{}'::jsonb then
      raise exception '%.turns · server_state 칼럼은 서버 함수만 쓸 수 있음 (만들 때는 기본값만)', tg_table_name using errcode = '42501';
    end if;
  elsif new.turns is distinct from old.turns or new.server_state is distinct from old.server_state then
    raise exception '%.turns · server_state 칼럼은 서버 함수만 바꿀 수 있음', tg_table_name using errcode = '42501';
  end if;

  return new;
end;
$$;

-- 트리거 함수는 실행 권한이 없어도 트리거로는 돌아감
revoke execute on function private.server_only_session_columns() from public, anon, authenticated;

create trigger server_only_columns before insert or update of turns, server_state on public.conversation_sessions
  for each row execute function private.server_only_session_columns();


-- ---------------------------------------------------------------------
-- 5. 고친 값 기록 — 화면 값 A02 추가
-- ---------------------------------------------------------------------
-- A02 = AI 대화에서 고친 값 (사용자가 대화 중 자동 기록 · 찾은 일정 값을 말로 고친 것)
-- 제약은 location_detect(20261029060000)가 마지막으로 정의한 목록(H01 · H03 · H05 · H08 · NTF · S01)에 A02만 더해 같은 이름으로 다시 만듦
--   이 제약을 또 다시 정의하는 마이그레이션은 이 목록(A02 포함)에서 시작해야 함
-- 필드 이름 규칙(user_edit_logs_field_format)과 RLS는 그대로

alter table public.user_edit_logs drop constraint user_edit_logs_screen_check;
alter table public.user_edit_logs
  add constraint user_edit_logs_screen_check check (screen in ('A02', 'H01', 'H03', 'H05', 'H08', 'NTF', 'S01'));

comment on column public.user_edit_logs.screen is '어느 화면에서 고쳤는지 — A02 AI 대화에서 고친 값 · H01 홈 감지 정정 줄(D61) · H03 알람 설정 · H05 새 일정 확인 시트 · H08 기상 정정(D61) · NTF 감지 안내 알림에서 정정(D61) · S01 알람 조정 제안 직접 수정';


-- ---------------------------------------------------------------------
-- 6. user_questions — 질문 예산 공용 셈 자리
-- ---------------------------------------------------------------------
-- 헤드 10/29 H2 = A (7장 v4 7.15.1): 질문 예산(하루 1개 · 주 3개)과 "같은 질문 24시간 안 반복 금지"는
--   채널(원탭 칩 · 카드 · 대화)을 가리지 않고 합쳐서 셈. 어떤 질문을 할지 고르는 일은 서버가 함
-- 지금은 L4 대화(voice-session)만 씀. L1 원탭 칩 · 카드는 나중에 같은 자리에 적음
-- 질문 하나 = 한 줄. 물은 때(asked_at)와 답한 때(answered_at) · 답(answer)을 남김
--   예산 셈: user_id + asked_at 범위 / 같은 질문 판단: user_id + subject_key + asked_at 범위
-- 쓰기는 서버 키(service_role)만. ai_calls와 같은 방식: 본인 읽기 정책 하나, INSERT · UPDATE · DELETE는 정책도 권한도 없음
--   (앱이 지어내거나 지우면 예산 셈이 깨지므로)
-- user_id: profiles 삭제 때 CASCADE (Q7 계정 삭제)
-- session_id: 대화를 지워도 질문 기록은 남겨 예산 셈이 줄어들지 않게 = SET NULL (ai_calls와 같은 이유)

create table public.user_questions (
  question_id uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (user_id) on delete cascade,
  channel     text not null,                                          -- 어디서 물었는지: CHIP 원탭 칩 · CARD 카드 · CHAT 대화
  kind        text not null,                                          -- 질문 종류 (예 PREP_CHECK 준비물 확인). 값 목록은 CHECK로 닫지 않음
  subject_key text not null,                                          -- 같은 질문인지 판단하는 키 (예 'PREP_CHECK:<appointment_id>')
  session_id  uuid references public.conversation_sessions (session_id) on delete set null,   -- 대화(CHAT)에서 물었으면 그 대화
  asked_at    timestamptz not null default now(),
  answered_at timestamptz,                                            -- 답하지 않았으면 NULL
  answer      text,                                                   -- 사용자의 답 (모양은 질문 종류가 정함)
  constraint user_questions_channel_check check (channel in ('CHIP', 'CARD', 'CHAT'))
);

create index idx_user_questions_user_time    on public.user_questions (user_id, asked_at desc);
create index idx_user_questions_user_subject on public.user_questions (user_id, subject_key, asked_at desc);
-- 대화가 지워질 때 SET NULL이 전체 훑기가 되지 않게
create index idx_user_questions_session      on public.user_questions (session_id) where session_id is not null;

comment on table public.user_questions is '질문 예산 공용 자리 — 지금은 L4 대화(voice-session)만 씀, L1 원탭 칩 · 카드는 나중에 같은 자리 (헤드 10/29 H2, 7장 v4 7.15.1). 하루 1 · 주 3 · 같은 질문 24시간 반복 금지를 채널 합쳐서 셈. 서버 함수(service_role)만 쓰고 본인은 읽기만';
comment on column public.user_questions.channel     is '물은 채널: CHIP 원탭 칩 · CARD 카드 · CHAT 대화';
comment on column public.user_questions.kind        is '질문 종류 (예 PREP_CHECK 준비물 확인). 서버가 정하고 DB는 값을 가리지 않음';
comment on column public.user_questions.subject_key is '같은 질문인지 판단하는 키 — 종류와 대상을 합쳐 씀 (예 PREP_CHECK:<appointment_id>). 24시간 안 같은 키는 다시 묻지 않음';

alter table public.user_questions enable row level security;

create policy user_questions_select_own on public.user_questions
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.user_questions from anon, authenticated;
grant select on public.user_questions to authenticated;
grant select, insert, update, delete on public.user_questions to service_role;
