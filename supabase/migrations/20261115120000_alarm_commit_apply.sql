-- =====================================================================
-- 알람 저장을 DB 함수 하나로 (정할 일 0-10 · 11/15 지형 결정) — 한 트랜잭션 + 요청 키
--   alarm-commit 저장은 약속 → 참여 조건 → 알람(고치기 · 만들기 · 지우기) → 고친 값 기록을 PostgREST로 따로 써서,
--   중간에 실패하면 새로 만든 약속 · 참여 조건만 지워지고 고친 알람은 남았고(서버 ↔ 폰 어긋남), 응답을 잃은 뒤 다시 누르면 새 약속이 두 벌 생겼음
--   → 쓰기 전체를 이 함수 한 번으로 부름. 중간에 어디서 실패해도 전부 취소됨 (요청 키 줄 포함)
--   ① 표 private.request_keys          같은 사용자 · 같은 키 · 같은 요청이면 첫 결과를 그대로 돌려주려고 키와 결과를 보관 (7일)
--   ② 함수 public.alarm_commit_apply   service_role(서버)만 부름. 순서는 supabase/functions/_shared/commit.ts와 같음
--   ③ pg_cron request-keys-purge       매일 18:30 UTC(03:30 KST) 7일 지난 키 줄 삭제
-- 범위: 서버(FastAPI) alarm-commit의 두 길 — 약속 저장 · 일정 없는 알람. Edge(commit.ts)는 되돌리기용이라 이 함수를 안 부름
-- 권한 · 입력 검사는 서버가 먼저 하고, 함수는 받은 값을 쓰기만 함 (모든 update · delete에 user_id = p_user_id 조건은 건다)
-- id(약속 · 참여 조건 · 알람)는 서버가 미리 만들어 보냄 → 고친 값 기록의 alarm_id를 함수 부르기 전에 서버가 채울 수 있음
-- 이 마이그레이션은 추가만 함 (기존 표 · 함수는 안 고침)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. private.request_keys — 요청 키 보관
-- ---------------------------------------------------------------------
-- private 스키마라 PostgREST에 안 보임 (함수가 security definer로만 읽고 씀). 열쇠 = (사용자, 함수 이름, 키)
-- result가 비어 있는 줄은 함수 트랜잭션 안에서만 보임 (끝나면 채워지거나, 실패하면 줄째 취소) — 커밋된 줄은 항상 result가 있음

create table private.request_keys (
  user_id      uuid        not null,
  fn           text        not null,
  key          text        not null check (char_length(key) between 8 and 100),
  request_hash text        not null,
  result       jsonb,
  created_at   timestamptz not null default now(),
  primary key (user_id, fn, key)
);

comment on table private.request_keys is '요청 키(멱등) 보관 — 같은 사용자 · 같은 키 · 같은 요청이면 첫 결과를 그대로 돌려줌. 서버 함수(service_role)가 DB 함수로만 씀, 앱은 못 읽음. 7일 지난 줄은 pg_cron request-keys-purge가 지움';
comment on column private.request_keys.fn is '어느 함수의 키인지 (alarm-commit)';
comment on column private.request_keys.request_hash is '서버가 보낸 요청 본문 해시(sha256 hex) — 같은 키로 다른 내용이 오면 IDEMPOTENCY_KEY_REUSED';
comment on column private.request_keys.result is '함수가 끝날 때 채우는 결과 JSON — 같은 요청이 다시 오면 이것에 replayed: true를 붙여 돌려줌';

alter table private.request_keys enable row level security;
revoke all on private.request_keys from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------
-- 2. 내부 도우미 — jsonb 한 줄을 표에 넣기 · 고치기
-- ---------------------------------------------------------------------
-- 서버가 보낸 JSON의 키가 곧 쓸 칸. jsonb_populate_record로 형을 맞추되, 안 보낸 칸은 표 기본값이 그대로 들어가야 하므로
-- (populate는 빠진 칸을 null로 만듦) 보낸 키만 칸 목록에 넣어 동적으로 씀. 칸 이름은 %I, 값은 파라미터라 주입 위험 없음
-- 표 이름은 이 함수가 쓰는 네 개만 허용. 돌려주는 값 = returning 칸을 jsonb로 (시각은 to_jsonb 모양)

create function private.commit_insert_row(p_table text, p_row jsonb, p_returning text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cols text;
  v_out  jsonb;
begin
  if p_table not in ('appointments', 'appointment_participants', 'alarms', 'user_edit_logs') then
    raise exception 'alarm_commit_apply: 쓸 수 없는 표: %', p_table using errcode = '22023';
  end if;
  select string_agg(format('%I', k), ', ') into v_cols from jsonb_object_keys(p_row) as k;
  if p_returning is null then
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', p_table, v_cols, v_cols, p_table) using p_row;
    return null;
  end if;
  execute format(
    'with r as (insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) returning %s) select to_jsonb(r) from r',
    p_table, v_cols, v_cols, p_table, p_returning)
    into v_out using p_row;
  return v_out;
end;
$$;

-- p_patch의 칸으로 (키 칸 · user_id는 빼고) 한 줄을 고침. 키 칸 where와 user_id가 안 맞아 0행이면 null
create function private.commit_update_row(p_table text, p_key_col text, p_key uuid, p_user_id uuid, p_patch jsonb, p_returning text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_set text;
  v_out jsonb;
  v_n   integer;
begin
  if p_table not in ('appointment_participants', 'alarms') or p_key_col not in ('participant_id', 'alarm_id') then
    raise exception 'alarm_commit_apply: 고칠 수 없는 표: %', p_table using errcode = '22023';
  end if;
  -- 칸마다 populate한 한 줄에서 값을 가져옴 (from으로 붙이면 returning의 칸 이름이 겹침)
  select string_agg(format('%I = (select s.%I from jsonb_populate_record(null::public.%I, $1) s)', k, k, p_table), ', ') into v_set
  from jsonb_object_keys(p_patch) as k
  where k not in ('alarm_id', 'participant_id', 'user_id', 'appointment_id');
  if v_set is null then
    raise exception 'alarm_commit_apply: 고칠 칸이 없음' using errcode = '22023';
  end if;
  if p_returning is null then
    execute format('update public.%I t set %s where t.%I = $2 and t.user_id = $3', p_table, v_set, p_key_col)
      using p_patch, p_key, p_user_id;
    get diagnostics v_n = row_count;
    return case when v_n = 0 then null else '{}'::jsonb end;
  end if;
  execute format(
    'with r as (update public.%I t set %s where t.%I = $2 and t.user_id = $3 returning %s) select to_jsonb(r) from r',
    p_table, v_set, p_key_col, p_returning)
    into v_out using p_patch, p_key, p_user_id;
  return v_out;
end;
$$;

revoke execute on function private.commit_insert_row(text, jsonb, text) from public, anon, authenticated, service_role;
revoke execute on function private.commit_update_row(text, text, uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------
-- 3. public.alarm_commit_apply — 저장 한 번
-- ---------------------------------------------------------------------
-- 인자
--   p_user_id         저장하는 사람 (서버가 토큰에서 확인한 값)
--   p_key             요청 키. null이면 중복 방지 없이 씀
--   p_request_hash    요청 본문 해시. p_key가 있으면 필수
--   p_mode            'APPOINTMENT' | 'STANDALONE'(일정 없는 알람)
--   p_appointment     새 약속이면 appointments에 넣을 행 전체(appointment_id 포함, creator_id는 p_user_id로 덮음). 기존 약속이면 null
--   p_appointment_ref 기존 약속이면 {appointment_id, title, appointment_at}(응답용). 새 약속 · STANDALONE이면 null
--   p_participant     APPOINTMENT: {participant_id, is_new, fields:{…}} — is_new면 insert(appointment_id · user_id는 함수가 채움), 아니면 update. STANDALONE이면 null
--   p_alarm_updates   [{alarm_id, patch:{…}}] 순서대로 고침. 0행이면 P0002 (남의 알람 · 없는 알람)
--   p_alarm_inserts   [{…행, alarm_id 포함}] user_id = p_user_id, participant_id = 참여 조건(STANDALONE이면 null · routine_id도 null)
--   p_alarm_removes   지울 alarm_id (본인 것만)
--   p_edit_logs       user_edit_logs 행 배열 그대로 (user_id는 p_user_id로 덮음). 비면 안 씀
--   p_before          저장 전 알람 행 목록 — 다시 보낸 요청에 응답을 다시 만들 수 있게 결과에 같이 보관
-- 결과 jsonb
--   {replayed, appointment: {appointment_id, title, appointment_at} | null, participant_id | null, after: [알람 행…], before: p_before}
--   after = 고친 것 ‖ 만든 것(넣은 순서) ‖ p_before 중 지우지도 고치지도 않은 것(원래 순서) — commit.ts의 [...touched, ...untouched]와 같음
--   알람 행 = ALARM_COLUMNS(alarm_id · participant_id · user_id · alarm_type · scheduled_at · intensity · voice_tone · sound_key · vibration · is_enabled
--             · snooze_limit · time_source · intensity_source · recurrence_rule). 시각은 to_jsonb 모양 = PostgREST 직접 select와 같음(2026-11-15T10:00:00+00:00)
-- 오류
--   P0001 IDEMPOTENCY_KEY_REUSED  같은 키로 다른 내용을 보냄
--   P0002                        고칠 알람 · 참여 조건이 없음(또는 남의 것) → 서버가 NOT_FOUND로
--   그 밖의 DB 오류(제약 위반 등)는 그대로 올라가고 이 호출의 쓰기는 전부 취소됨

create function public.alarm_commit_apply(
  p_user_id         uuid,
  p_key             text,
  p_request_hash    text,
  p_mode            text,
  p_appointment     jsonb,
  p_appointment_ref jsonb,
  p_participant     jsonb,
  p_alarm_updates   jsonb,
  p_alarm_inserts   jsonb,
  p_alarm_removes   uuid[],
  p_edit_logs       jsonb,
  p_before          jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_cols constant text := 'alarm_id, participant_id, user_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, vibration, is_enabled, snooze_limit, time_source, intensity_source, recurrence_rule';
  v_hash        text;
  v_saved       jsonb;
  v_appointment jsonb;
  v_participant_id uuid;
  v_row         jsonb;
  v_touched     jsonb := '[]'::jsonb;
  v_untouched   jsonb;
  v_updated_ids uuid[] := '{}';
  v_item        jsonb;
  v_log         jsonb;
  v_result      jsonb;
begin
  if p_mode not in ('APPOINTMENT', 'STANDALONE') then
    raise exception 'alarm_commit_apply: mode가 아님: %', p_mode using errcode = '22023';
  end if;

  -- 1. 요청 키 — 먼저 넣어 보고, 이미 있으면 해시가 같을 때만 첫 결과를 돌려줌
  --    같은 키가 동시에 오면 두 번째 insert가 첫 트랜잭션이 끝날 때까지 기다렸다가 conflict가 되어 커밋된 결과를 읽음
  if p_key is not null then
    if p_request_hash is null then
      raise exception 'alarm_commit_apply: 요청 키에는 request_hash가 필요함' using errcode = '22023';
    end if;
    insert into private.request_keys (user_id, fn, key, request_hash)
    values (p_user_id, 'alarm-commit', p_key, p_request_hash)
    on conflict do nothing;
    if not found then
      select k.request_hash, k.result into v_hash, v_saved
      from private.request_keys k
      where k.user_id = p_user_id and k.fn = 'alarm-commit' and k.key = p_key;
      if v_hash is distinct from p_request_hash then
        raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
      end if;
      if v_saved is null then
        raise exception 'alarm_commit_apply: 요청 키 줄에 결과가 없음' using errcode = 'XX000';
      end if;
      return v_saved || '{"replayed": true}'::jsonb;
    end if;
  end if;

  -- 2. 약속 — 새 약속이면 만들고, 기존 약속이면 응답용 값만 받음
  if p_appointment is not null then
    v_appointment := private.commit_insert_row(
      'appointments', p_appointment || jsonb_build_object('creator_id', p_user_id), 'appointment_id, title, appointment_at');
  else
    v_appointment := p_appointment_ref;
  end if;

  -- 3. 참여 조건 — 새로 만들거나 고침 (STANDALONE은 없음)
  if p_mode = 'APPOINTMENT' then
    v_participant_id := (p_participant ->> 'participant_id')::uuid;
    if coalesce((p_participant ->> 'is_new')::boolean, false) then
      perform private.commit_insert_row(
        'appointment_participants',
        (p_participant -> 'fields') || jsonb_build_object(
          'participant_id', v_participant_id,
          'appointment_id', v_appointment ->> 'appointment_id',
          'user_id', p_user_id));
    elsif private.commit_update_row('appointment_participants', 'participant_id', v_participant_id, p_user_id, p_participant -> 'fields') is null then
      raise exception 'alarm_commit_apply: 참여 조건을 못 찾음' using errcode = 'P0002';
    end if;
  end if;

  -- 4. 알람 — 고치기 → 만들기 → 지우기 (중간에 실패해도 있던 알람이 먼저 사라지지 않게 commit.ts와 같은 순서)
  for v_item in select * from jsonb_array_elements(coalesce(p_alarm_updates, '[]'::jsonb)) loop
    v_row := private.commit_update_row('alarms', 'alarm_id', (v_item ->> 'alarm_id')::uuid, p_user_id, v_item -> 'patch', c_cols);
    if v_row is null then
      raise exception 'alarm_commit_apply: 알람을 못 찾음: %', v_item ->> 'alarm_id' using errcode = 'P0002';
    end if;
    v_touched := v_touched || jsonb_build_array(v_row);
    v_updated_ids := v_updated_ids || (v_item ->> 'alarm_id')::uuid;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_alarm_inserts, '[]'::jsonb)) loop
    v_row := private.commit_insert_row(
      'alarms',
      v_item || case
        when p_mode = 'APPOINTMENT' then jsonb_build_object('user_id', p_user_id, 'participant_id', v_participant_id)
        else jsonb_build_object('user_id', p_user_id, 'participant_id', null, 'routine_id', null)
      end,
      c_cols);
    v_touched := v_touched || jsonb_build_array(v_row);
  end loop;

  if coalesce(array_length(p_alarm_removes, 1), 0) > 0 then
    delete from public.alarms a where a.alarm_id = any (p_alarm_removes) and a.user_id = p_user_id;
  end if;

  -- 5. 고친 값 기록
  for v_log in select * from jsonb_array_elements(coalesce(p_edit_logs, '[]'::jsonb)) loop
    perform private.commit_insert_row('user_edit_logs', v_log || jsonb_build_object('user_id', p_user_id));
  end loop;

  -- 6. 응답용 목록 — 저장 전 목록에서 지운 것 · 고친 것을 뺀 나머지가 뒤에 붙음
  select coalesce(jsonb_agg(b.value order by b.ord), '[]'::jsonb) into v_untouched
  from jsonb_array_elements(coalesce(p_before, '[]'::jsonb)) with ordinality as b(value, ord)
  where not ((b.value ->> 'alarm_id')::uuid = any (coalesce(p_alarm_removes, '{}'::uuid[])))
    and not ((b.value ->> 'alarm_id')::uuid = any (v_updated_ids));

  v_result := jsonb_build_object(
    'replayed', false,
    'appointment', case when v_appointment is null then null else jsonb_build_object(
      'appointment_id', v_appointment -> 'appointment_id', 'title', v_appointment -> 'title', 'appointment_at', v_appointment -> 'appointment_at') end,
    'participant_id', v_participant_id,
    'after', v_touched || v_untouched,
    'before', coalesce(p_before, '[]'::jsonb));

  -- 7. 키가 있으면 결과를 남김
  if p_key is not null then
    update private.request_keys k set result = v_result
    where k.user_id = p_user_id and k.fn = 'alarm-commit' and k.key = p_key;
  end if;
  return v_result;
end;
$$;

comment on function public.alarm_commit_apply(uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid[], jsonb, jsonb) is
  '알람 저장 한 번(약속 · 참여 조건 · 알람 고치기 · 만들기 · 지우기 · 고친 값 기록)을 한 트랜잭션으로 + 요청 키(같은 키 · 같은 요청이면 첫 결과를 replayed: true로). 서버(service_role)만 부름 — 권한 · 입력 검사는 서버가 먼저';

revoke all on function public.alarm_commit_apply(uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.alarm_commit_apply(uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid[], jsonb, jsonb) to service_role;


-- ---------------------------------------------------------------------
-- 4. 7일 지난 요청 키 정리 — 매일 18:30 UTC = 한국 새벽 3시 30분
-- ---------------------------------------------------------------------
-- 지운 줄 수를 돌려줌 (시험 · 로그용). 앱 · 서버 함수는 못 부르고 DB 예약(pg_cron)만 부름

create function private.purge_request_keys()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  with d as (delete from private.request_keys where created_at < now() - interval '7 days' returning 1)
  select count(*)::integer into v_n from d;
  return v_n;
end;
$$;

revoke execute on function private.purge_request_keys() from public, anon, authenticated, service_role;

-- pg_cron이 있는 곳(실제 Supabase)에서만 예약 — 같은 이름으로 다시 예약하면 갈아끼움
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('request-keys-purge', '30 18 * * *', $cmd$select private.purge_request_keys()$cmd$);
  end if;
end;
$$;
