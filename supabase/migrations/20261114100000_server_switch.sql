-- =====================================================================
-- 서버 전환 스위치 DB (M1, 이슈 #475 · 서버 완결점 1-8 — capstone/docs/서버_요구사항_설계_1112.md 7 · 8절)
--   알람 계산을 Supabase Edge 함수에서 FastAPI 서버(EC2)로 옮기는 동안, 어디서 돌지를 DB 표 한 줄로 정하고 언제든 Edge로 되돌리게 함
--   ① 표 server_routes        함수 · 작업별로 누가 맡는지. 함수 = edge · canary · server / 작업 = edge · shadow · server
--   ② 표 server_route_users   canary(지정한 계정만 서버로)의 대상 계정
--   ③ 표 server_heartbeat     서버 스케줄러가 남기는 기록. alive_at = 스케줄러가 돌았음 / last_success_at = 그 작업이 서버에서 성공함
--   ④ RPC get_server_routes() 앱이 부름. 부른 사람에게 해당하는 값만 돌려줌 (canary 대상 목록은 안 보임)
--   ⑤ private.run_job(name)   pg_cron이 부름. 표가 server이고 서버가 최근 성공했으면 건너뛰고, 아니면 Edge를 부름 (서버가 멈췄을 때 Edge가 이어받는 안전망)
--   ⑥ pg_cron 명령 교체       wake-check · alarm-roll · suggestion-generate의 명령을 run_job으로 + 매일 18:15 KST 제안 안전망 추가
--      voice-auto-commit · 친구 cron(friend-requests-expire · friend-records-purge)은 그대로
-- 값은 전부 edge로 시작 → run_job은 지금과 똑같이 Edge를 부름 = 이 파일이 적용돼도 동작은 안 바뀜 (1차 동안)
-- 표 값 바꾸기(전환 · 되돌리기)는 마이그레이션이 아니라 운영 조작 — SQL은 supabase/README.md "서버 전환 스위치" 절 · supabase/ops/
-- 이 마이그레이션은 추가만 함 (기존 표 · 함수는 안 고침). 원복 = supabase/ops/server-switch-rollback.sql (cron 명령만 옛것으로)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. server_routes — 함수 · 작업별 담당
-- ---------------------------------------------------------------------
-- kind = 'function' : 앱이 부르는 Edge 함수 (이름 = Edge 함수 이름, 앱 callEdge가 표를 읽고 Edge · 서버 중 고름)
-- kind = 'job'      : pg_cron이 부르는 예약 작업 (이름 = cron 작업 이름, 서버 스케줄러와 run_job이 읽음)
-- 같은 이름이 함수 · 작업에 다 있을 수 있어서(alarm-roll) (kind, name)이 열쇠
-- mode
--   function  edge    Edge가 처리 (옛 방식 그대로)
--             canary  server_route_users에 있는 계정만 서버, 나머지는 Edge
--             server  모두 서버
--   job       edge    서버 스케줄러는 안 함, pg_cron이 Edge를 부름
--             shadow  서버가 세기만 함 (쓰기 · 푸시 없음), pg_cron이 Edge를 부름
--             server  서버가 실제로 함. pg_cron은 서버의 성공 기록이 최근에 있으면 건너뛰고 없으면 Edge를 부름

create table public.server_routes (
  kind       text not null,
  name       text not null,
  mode       text not null default 'edge',
  updated_at timestamptz not null default now(),
  primary key (kind, name),
  constraint server_routes_name_shape check (name ~ '^[a-z0-9-]+$'),
  constraint server_routes_mode_by_kind check (
    (kind = 'function' and mode in ('edge', 'canary', 'server'))
    or (kind = 'job' and mode in ('edge', 'shadow', 'server')))
);

create trigger set_updated_at before update on public.server_routes
  for each row execute function public.set_updated_at();

comment on table public.server_routes is '서버 전환 스위치 — 함수(앱이 부름) · 작업(pg_cron이 부름)별로 Edge · 서버 중 누가 맡는지. 값은 SQL 편집기에서 update로 바꿈(런북). 앱은 get_server_routes()로만 읽고 service_role만 직접 읽고 씀';
comment on column public.server_routes.kind is 'function = 앱이 부르는 Edge 함수 / job = pg_cron 예약 작업';
comment on column public.server_routes.mode is 'function: edge · canary · server / job: edge · shadow · server. 없는 줄은 edge로 봄. edge로 되돌리는 것이 언제나 안전한 쪽';

-- 앞으로 서버로 옮길 후보만 미리 넣음 (전부 edge). 나머지 Edge 함수는 줄이 없으면 edge — 옮기기로 정하면 insert
insert into public.server_routes (kind, name) values
  ('function', 'place-search'),
  ('function', 'place-reverse'),
  ('function', 'alarm-suggest'),
  ('function', 'alarm-commit'),
  ('function', 'appointment-edit'),
  ('function', 'alarm-roll'),
  ('job', 'wake-check'),
  ('job', 'alarm-roll'),
  ('job', 'suggestion-generate');

alter table public.server_routes enable row level security;

revoke all on public.server_routes from anon, authenticated;
grant select, insert, update, delete on public.server_routes to service_role;


-- ---------------------------------------------------------------------
-- 2. server_route_users — canary 대상 계정
-- ---------------------------------------------------------------------
-- 함수 줄(mode = canary)에만 걸림. 앱은 이 목록을 못 읽음 (get_server_routes가 "나에게 적용되는 값"만 돌려줌)

create table public.server_route_users (
  kind    text not null default 'function',
  name    text not null,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  primary key (name, user_id),
  constraint server_route_users_function_only check (kind = 'function'),
  constraint server_route_users_route_fkey foreign key (kind, name) references public.server_routes (kind, name) on delete cascade
);

comment on table public.server_route_users is 'canary(지정한 계정만 서버로) 대상 — server_routes 함수 줄 mode = canary일 때 이 계정만 서버로 감. service_role만 읽고 씀(앱은 못 읽음)';

alter table public.server_route_users enable row level security;

revoke all on public.server_route_users from anon, authenticated;
grant select, insert, update, delete on public.server_route_users to service_role;


-- ---------------------------------------------------------------------
-- 3. server_heartbeat — 서버 스케줄러의 기록 (작업마다 한 줄)
-- ---------------------------------------------------------------------
-- alive_at         스케줄러 루프가 돌았음 (mode와 상관없이 1분마다). /health/deep이 읽음 — 15분 넘게 멈추면 감시 메일
-- last_success_at  그 작업이 서버에서 mode = server로 성공했을 때만 갱신. pg_cron(run_job)은 이것만 봄
-- 줄은 서버가 upsert로 만들고 고침. 아래 세 줄은 콘솔에서 보이게 미리 넣어 둠 (값 없음 = 서버가 아직 안 돌았음)

create table public.server_heartbeat (
  job_name        text primary key,
  alive_at        timestamptz,
  last_success_at timestamptz,
  constraint server_heartbeat_name_shape check (job_name ~ '^[a-z0-9-]+$')
);

comment on table public.server_heartbeat is '서버 스케줄러 기록 — 작업마다 한 줄. alive_at = 스케줄러가 돌았음(감시용), last_success_at = 서버에서 성공함(run_job이 봄). 서버(service_role)가 씀';
comment on column public.server_heartbeat.alive_at is '스케줄러 루프가 마지막으로 돈 시각 (mode 무관). /health/deep이 15분 넘게 안 바뀌면 실패로 답함';
comment on column public.server_heartbeat.last_success_at is '그 작업이 서버에서 mode = server로 마지막으로 성공한 시각. shadow · 실패는 기록 안 함. run_job이 창 안에 있으면 Edge 호출을 건너뜀';

insert into public.server_heartbeat (job_name) values
  ('wake-check'),
  ('alarm-roll'),
  ('suggestion-generate');

alter table public.server_heartbeat enable row level security;

revoke all on public.server_heartbeat from anon, authenticated;
grant select, insert, update, delete on public.server_heartbeat to service_role;


-- ---------------------------------------------------------------------
-- 4. get_server_routes() — 앱이 읽는 "나에게 적용되는 값"
-- ---------------------------------------------------------------------
-- 부른 사람(auth.uid()) 기준으로 함수 줄마다 edge · server 둘 중 하나만 돌려줌
--   server → server / canary → 내가 canary 대상이면 server, 아니면 edge / edge → edge
-- 작업(job) 줄과 canary 대상 목록은 안 돌려줌. 앱은 표를 못 읽으면(오류 · 시간 초과) 전부 edge로 동작 (앱 쪽 M2)
-- 로그인이 없으면(auth.uid() 없음) canary는 edge. 앱은 로그인한 뒤에만 부름 (anon은 실행 권한 없음)

create function public.get_server_routes()
returns table (name text, mode text)
language sql
stable
security definer
set search_path = ''
as $$
  select r.name,
         case
           when r.mode = 'server' then 'server'
           when r.mode = 'canary' and exists (
                  select 1 from public.server_route_users u
                  where u.kind = r.kind and u.name = r.name and u.user_id = (select auth.uid())) then 'server'
           else 'edge'
         end
  from public.server_routes r
  where r.kind = 'function'
  order by r.name;
$$;

revoke execute on function public.get_server_routes() from public, anon;
grant execute on function public.get_server_routes() to authenticated, service_role;


-- ---------------------------------------------------------------------
-- 5. private.run_job(name, role) — pg_cron이 예약 작업을 부르는 길
-- ---------------------------------------------------------------------
-- 전: pg_cron이 private.invoke_edge_function(이름)을 바로 부름. 후: run_job이 표를 보고 Edge를 부를지 정함
-- 담당(mode)은 server_routes의 작업(job) 줄. 줄이 없거나 표를 못 읽으면 edge로 봄 (= 옛 방식, Edge를 부름)
--
-- role 별 동작 (mode가 edge · shadow면 서버는 일을 안 함)
--   poll     5분마다 도는 작업(wake-check · alarm-roll)의 정기 호출 — 기본값
--              edge · shadow → Edge를 부름
--              server        → 서버 성공 기록(last_success_at)이 12분 안에 있으면 건너뜀(서버가 하는 중), 없으면 Edge를 부름(서버가 멈췄거나 실패)
--              12분 = 5분 주기 + 서버 한 회차가 늦어도 같은 회차에 중복으로 안 부르는 여유 (서버가 멈춘 뒤 pg_cron이 이어받기까지 최악 약 17분)
--   primary  하루 한 번 작업(suggestion-generate)의 정시 호출 (18:00 KST)
--              edge · shadow → Edge를 부름 (옛 방식 그대로)
--              server        → 건너뜀 (서버가 같은 시각에 하는 중이라 아직 성공 기록이 없을 뿐. 안 되면 아래 safety가 이어받음)
--   safety   하루 한 번 작업의 안전망 (18:15 KST)
--              edge · shadow → 아무것도 안 함 (정시 호출이 이미 Edge를 불렀음 — 두 번 안 부르려고)
--              server        → 오늘(한국 날짜) 서버 성공 기록이 있으면 건너뜀, 없으면 Edge를 부름
-- Edge를 부르는 일은 invoke_edge_function이 함 (Vault 키가 없거나 호출이 실패하면 경고만 남기고 null — 지금과 같음)
-- 돌려주는 값 = 부른 요청 번호(pg_net), 건너뛰었거나 부르지 못했으면 null
-- Edge가 같은 일을 두 번 해도 안전함: 기록 · 푸시의 "한 번만"이 DB 유니크 키 · DB 함수(claim_wake_nudges · roll_insert_occurrence · 제안 유일 인덱스)에 있음

create function private.run_job(p_name text, p_role text default 'poll')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode text;
  v_last timestamptz;
begin
  if p_role not in ('poll', 'primary', 'safety') then
    raise exception 'run_job role이 아님: %', p_role;
  end if;

  -- 표를 못 읽으면 edge로 동작 (읽기 실패가 배치를 멈추지 않게)
  begin
    select r.mode into v_mode from public.server_routes r where r.kind = 'job' and r.name = p_name;
    if v_mode = 'server' then
      select h.last_success_at into v_last from public.server_heartbeat h where h.job_name = p_name;
    end if;
  exception when others then
    raise warning 'run_job %: 스위치 표를 못 읽어 edge로 동작함: %', p_name, sqlerrm;
    v_mode := 'edge';
    v_last := null;
  end;
  v_mode := coalesce(v_mode, 'edge');

  if v_mode <> 'server' then
    -- edge · shadow: 서버는 일을 안 하거나 세기만 함 → Edge가 실제로 함. 안전망은 정시 호출이 이미 불렀으므로 쉼
    if p_role = 'safety' then
      return null;
    end if;
    return private.invoke_edge_function(p_name);
  end if;

  -- server: 서버가 하는 작업
  if p_role = 'primary' then
    return null;
  elsif p_role = 'safety' then
    if v_last is not null
       and (v_last at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date then
      return null;
    end if;
  else
    if v_last is not null and v_last > now() - interval '12 minutes' then
      return null;
    end if;
  end if;

  return private.invoke_edge_function(p_name);
end;
$$;

revoke execute on function private.run_job(text, text) from public, anon, authenticated;
grant execute on function private.run_job(text, text) to service_role;


-- ---------------------------------------------------------------------
-- 6. pg_cron 명령 교체 + 제안 안전망
-- ---------------------------------------------------------------------
-- 같은 이름으로 다시 예약하면 pg_cron이 기존 작업의 명령을 갈아끼움 (작업 번호 · 주기는 그대로, 지우지 않음)
--   wake-check · alarm-roll         매 5분              → run_job(이름)           (poll)
--   suggestion-generate             매일 18:00 KST      → run_job(이름, 'primary')
--   suggestion-generate-safety      매일 18:15 KST (새) → run_job('suggestion-generate', 'safety')
--   voice-auto-commit · friend-requests-expire · friend-records-purge  그대로 (안 건드림)
-- 09:15 UTC = 18:15 KST
-- 확장이 있는 곳에서만 (PGlite 같은 검사용 DB에는 pg_cron이 없어 건너뜀 — supabase/tests가 cron 흉내로 확인)

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('wake-check', '*/5 * * * *', $cmd$select private.run_job('wake-check')$cmd$);
    perform cron.schedule('alarm-roll', '*/5 * * * *', $cmd$select private.run_job('alarm-roll')$cmd$);
    perform cron.schedule('suggestion-generate', '0 9 * * *', $cmd$select private.run_job('suggestion-generate', 'primary')$cmd$);
    perform cron.schedule('suggestion-generate-safety', '15 9 * * *', $cmd$select private.run_job('suggestion-generate', 'safety')$cmd$);
  end if;
end;
$$;
