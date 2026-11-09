-- =====================================================================
-- 친구 10장 — 친구가 내 알람 바꾸기 = 제안 (친구 논리설계 10장, 11/8 확정)
--   ① alarms.original_scheduled_at · original_time_source — 친구가 처음 바꾸기 전의 시각과 그때의 time_source (합계 ±60분의 기준 · [원래대로])
--   ② alarm_proposals(앱은 읽기만) — 친구별 제안 한 줄: 제안 때 시각 → 제안 시각, 대기 · 적용 · 무시 · 대체 · 만료
--   ③ propose_alarm_time — 제안 보내기 (설정 권한 · 앞으로 울릴 켜진 약속 알람 · 곧 울릴 알람 거절 · ±60분)
--   ④ respond_alarm_proposal — 주인이 [적용] / [무시]. 적용하면 그 카드의 아직 안 울린 알람이 같이 움직이고 MANUAL
--   ⑤ my_alarm_proposals · sent_alarm_proposals — 받은 제안 카드 · 보낸 친구의 '제안함' / '반영됨'
--   ⑥ can_send_push의 ALARM_CHANGED = 설정 권한 + 방금 보낸 대기 중 제안
-- 친구가 알람을 바로 고치는 옛 길(alarms_update_shared)은 앱(G04)이 제안으로 바뀐 뒤 따로 닫음 — 이 PR에서 닫으면 지금 G04가 깨짐
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 원래 시각 칸 + 앱이 못 쓰게 하는 가드
-- ---------------------------------------------------------------------

alter table public.alarms add column original_scheduled_at timestamptz;
comment on column public.alarms.original_scheduled_at is '친구 제안을 처음 적용하기 직전의 시각 — 합계 ±60분의 기준이고 [원래대로]가 이 시각. 비어 있으면 친구가 바꾼 적 없음. 시각이 다른 길로 바뀌면 비워짐';

alter table public.alarms add column original_time_source public.alarm_value_source;
comment on column public.alarms.original_time_source is '친구 제안을 처음 적용하기 직전의 time_source — [원래대로]로 돌아오면 이 값으로 복원(자동 계산이었으면 다시 자동, 주인이 직접 골랐으면 계속 직접). original_scheduled_at과 같이 채워지고 같이 비워짐';

-- 값을 쓰는 곳은 respond_alarm_proposal 하나(그 안에서만 app.alarm_apply를 켬). 그 밖에 시각이 바뀌면(주인이 직접 고침 · 서버가 새로 계산함) 기준이 새로 시작하므로 두 칸 모두 비움.
--   앱 역할은 이 두 칸만 따로 고치거나 새로 넣을 때 값을 줄 수 없음. 설정을 켠 채 앱 역할로 시각을 바꾸는 길은 막음(current_user 확인)
create function private.guard_alarm_original()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_app boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if v_app then
      new.original_scheduled_at := null;
      new.original_time_source := null;
    end if;
    return new;
  end if;

  if new.scheduled_at is distinct from old.scheduled_at then
    if v_app or coalesce(current_setting('app.alarm_apply', true), '') <> 'on' then
      new.original_scheduled_at := null;
      new.original_time_source := null;
    end if;
  elsif v_app and (new.original_scheduled_at is distinct from old.original_scheduled_at
                   or new.original_time_source is distinct from old.original_time_source) then
    new.original_scheduled_at := old.original_scheduled_at;
    new.original_time_source := old.original_time_source;
  end if;
  return new;
end;
$$;

create trigger guard_alarm_original
  before insert or update on public.alarms
  for each row execute function private.guard_alarm_original();


-- ---------------------------------------------------------------------
-- 2. 제안 표 — 앱은 읽기만
-- ---------------------------------------------------------------------

-- status: PENDING(대기) · APPLIED(주인이 적용) · DISMISSED(주인이 무시 — 보낸 친구에게는 안 알리고 sent_alarm_proposals가 PENDING으로 돌려줌) · REPLACED(늦게 보낸 제안으로 대체) · EXPIRED(알람 시각이 지났거나 주인이 그사이 직접 고침 · 같은 카드의 다른 제안이 적용돼 시각이 어긋남)
-- 같은 알람에 대기 중인 제안은 하나 — 두 친구가 보내면 늦게 보낸 값 (10-24)
create table public.alarm_proposals (
  proposal_id  uuid primary key default gen_random_uuid(),
  alarm_id     uuid not null references public.alarms (alarm_id) on delete cascade,
  owner_id     uuid not null references public.profiles (user_id) on delete cascade,
  proposer_id  uuid not null references public.profiles (user_id) on delete cascade,
  from_at      timestamptz not null,
  to_at        timestamptz not null,
  status       text not null default 'PENDING' check (status in ('PENDING', 'APPLIED', 'DISMISSED', 'REPLACED', 'EXPIRED')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint alarm_proposals_not_self check (owner_id <> proposer_id),
  constraint alarm_proposals_moved check (to_at <> from_at)
);

create unique index alarm_proposals_one_pending on public.alarm_proposals (alarm_id) where status = 'PENDING';
create index idx_alarm_proposals_owner    on public.alarm_proposals (owner_id, created_at desc) where status = 'PENDING';
create index idx_alarm_proposals_proposer on public.alarm_proposals (proposer_id, owner_id, created_at desc);

comment on table public.alarm_proposals is '친구가 보낸 알람 시각 제안 — 주인이 [적용]해야 바뀜. 쓰기는 propose_alarm_time · respond_alarm_proposal로만';

alter table public.alarm_proposals enable row level security;
revoke all on public.alarm_proposals from anon, authenticated;
grant select on public.alarm_proposals to authenticated;
grant select, insert, update, delete on public.alarm_proposals to service_role;

-- 주인 본인 줄만 읽힘. 보낸 친구는 표를 직접 못 읽고 sent_alarm_proposals로만 봄 — 무시 · 응답 시각 같은 주인 쪽 흔적이 새지 않고, 차단 · 권한 회수 뒤에도 안 읽힘
create policy alarm_proposals_select on public.alarm_proposals
  for select to authenticated
  using (owner_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 3. 제안 보내기
-- ---------------------------------------------------------------------

-- 상태: OK · FORBIDDEN(설정 권한 없음 · 안 보이는 알람 · 이미 울린 · 꺼 둔 · 일정에 안 붙은 · 내 알람 · 차단 · 없는 알람 — 이유 구분 없음) · SAME · TOO_SOON · LIMIT · INVALID
--   TOO_SOON: 알람이 지금 + 10분 안(곧 울림)이거나 새 시각이 지금 + 5분 이전. 10분은 문서에 없는 값(10-14는 3분 사례만)이라 작성자 판단
--   LIMIT: 원래 시각(없으면 지금 시각) 기준 ±60분 (10-13, D35)
--   TOO_SOON에는 같은 카드의 다른 알람이 이 제안을 적용하면 지금 + 5분 이전으로 가는 경우도 들어감(적용하면 이른 알람이 과거로 가므로)
-- 시각은 분 단위로 맞춤. 같은 알람의 이전 대기 제안은 대체됨(늦게 보낸 값, 10-24)
-- 같은 카드(같은 참여 조건)의 제안 · 적용은 카드 단위 잠금으로 차례로 처리 — 읽은 뒤 주인이 그사이 다른 제안을 적용해 어긋난 제안이 남지 않게, [적용] 둘이 서로 기다리는 일이 없게
create function public.propose_alarm_time(p_alarm_id uuid, p_new_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_alarm record;
  v_new   timestamptz;
  v_id    uuid;
  v_card  uuid;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_alarm_id is null or p_new_at is null then
    return jsonb_build_object('status', 'INVALID');
  end if;

  select a.participant_id into v_card from public.alarms a where a.alarm_id = p_alarm_id;
  perform pg_advisory_xact_lock(hashtextextended('alarm_card:' || coalesce(v_card::text, p_alarm_id::text), 0));

  select a.user_id, a.scheduled_at, a.original_scheduled_at, a.is_enabled, a.participant_id into v_alarm
  from public.alarms a
  where a.alarm_id = p_alarm_id;

  if not found
     or v_alarm.user_id = v_uid
     or v_alarm.participant_id is null
     or not v_alarm.is_enabled
     or v_alarm.scheduled_at <= now()
     or v_alarm.user_id not in (select private.granted_owner_ids_for(v_uid, 'EDIT_ALARM')) then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  v_new := date_trunc('minute', p_new_at);
  if v_new = date_trunc('minute', v_alarm.scheduled_at) then
    return jsonb_build_object('status', 'SAME');
  end if;
  if v_alarm.scheduled_at < now() + interval '10 minutes' or v_new < now() + interval '5 minutes' then
    return jsonb_build_object('status', 'TOO_SOON');
  end if;
  if abs(extract(epoch from (v_new - date_trunc('minute', coalesce(v_alarm.original_scheduled_at, v_alarm.scheduled_at))))) > 3600 then
    return jsonb_build_object('status', 'LIMIT');
  end if;
  -- 같은 카드의 안 울린 다른 알람이 같은 만큼 움직이면 지금 + 5분 이전이 되는가 (기상을 늦게 맞추려고 출발을 크게 당기는 경우)
  if exists (
    select 1 from public.alarms s
    where s.participant_id = v_alarm.participant_id and s.user_id = v_alarm.user_id and s.scheduled_at > now()
      and s.scheduled_at + (v_new - v_alarm.scheduled_at) < now() + interval '5 minutes') then
    return jsonb_build_object('status', 'TOO_SOON');
  end if;

  update public.alarm_proposals
  set status = 'REPLACED', responded_at = now()
  where alarm_id = p_alarm_id and status = 'PENDING';

  insert into public.alarm_proposals (alarm_id, owner_id, proposer_id, from_at, to_at)
  values (p_alarm_id, v_alarm.user_id, v_uid, v_alarm.scheduled_at, v_new)
  returning proposal_id into v_id;

  return jsonb_build_object('status', 'OK', 'proposal_id', v_id, 'from_at', v_alarm.scheduled_at, 'to_at', v_new);
end;
$$;


-- ---------------------------------------------------------------------
-- 4. 주인의 [적용] / [무시]
-- ---------------------------------------------------------------------

-- 적용하면 그 알람이 속한 카드(같은 참여 조건)의 아직 안 울린 알람이 같은 만큼 움직임(기상 · 준비 · 출발이 같이) — time_source = MANUAL,
--   원래 시각 · 그때의 time_source 기억(처음 바꿀 때만 채움, 원래 시각으로 돌아오면 time_source까지 복원하고 비움). 약속은 그대로. 같은 카드의 다른 대기 제안은 시각이 어긋나므로 만료로
--   같은 카드의 이른 알람이 이 만큼 움직이면 지금 + 5분 이전이 되는 경우는 EXPIRED(과거로 보내지 않음)
-- 상태: APPLIED(alarm_ids) · DISMISSED · EXPIRED(알람이 꺼졌거나 지났거나 주인이 그사이 직접 고침 · 보낸 친구의 설정 권한이 없어짐 · 이른 형제 알람이 과거가 됨) · LIMIT · NOT_FOUND(내 대기 제안이 아님)
create function public.respond_alarm_proposal(p_proposal_id uuid, p_apply boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_p     record;
  v_a     record;
  v_ids   uuid[];
  v_card  uuid;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_proposal_id is null or p_apply is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  -- 카드 단위 잠금을 제안 행 잠금보다 먼저 (제안 보내기와 같은 순서 — 같은 카드의 [적용] 둘이 서로 기다리지 않게)
  select a.participant_id into v_card
  from public.alarm_proposals p join public.alarms a on a.alarm_id = p.alarm_id
  where p.proposal_id = p_proposal_id and p.owner_id = v_uid;
  if found then
    perform pg_advisory_xact_lock(hashtextextended('alarm_card:' || coalesce(v_card::text, p_proposal_id::text), 0));
  end if;

  select p.proposal_id, p.alarm_id, p.proposer_id, p.from_at, p.to_at into v_p
  from public.alarm_proposals p
  where p.proposal_id = p_proposal_id and p.owner_id = v_uid and p.status = 'PENDING'
  for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  if not p_apply then
    update public.alarm_proposals set status = 'DISMISSED', responded_at = now() where proposal_id = v_p.proposal_id;
    return jsonb_build_object('status', 'DISMISSED');
  end if;

  select a.alarm_id, a.participant_id, a.scheduled_at, a.original_scheduled_at, a.is_enabled into v_a
  from public.alarms a
  where a.alarm_id = v_p.alarm_id and a.user_id = v_uid
  for update;

  if not found
     or not v_a.is_enabled
     or v_a.scheduled_at <> v_p.from_at
     or v_a.scheduled_at <= now()
     or v_p.to_at < now() + interval '5 minutes'
     or v_uid not in (select private.granted_owner_ids_for(v_p.proposer_id, 'EDIT_ALARM')) then
    update public.alarm_proposals set status = 'EXPIRED', responded_at = now() where proposal_id = v_p.proposal_id;
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  if abs(extract(epoch from (v_p.to_at - date_trunc('minute', coalesce(v_a.original_scheduled_at, v_a.scheduled_at))))) > 3600 then
    update public.alarm_proposals set status = 'EXPIRED', responded_at = now() where proposal_id = v_p.proposal_id;
    return jsonb_build_object('status', 'LIMIT');
  end if;

  -- 같은 카드의 이른 알람이 이 만큼 움직이면 지금 + 5분 이전(과거)이 되는 경우는 적용하지 않음
  if exists (
    select 1 from public.alarms s
    where s.participant_id = v_a.participant_id and s.user_id = v_uid and s.scheduled_at > now()
      and s.scheduled_at + (v_p.to_at - v_p.from_at) < now() + interval '5 minutes') then
    update public.alarm_proposals set status = 'EXPIRED', responded_at = now() where proposal_id = v_p.proposal_id;
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  perform set_config('app.alarm_apply', 'on', true);
  with moved as (
    update public.alarms a
    set scheduled_at          = a.scheduled_at + (v_p.to_at - v_p.from_at),
        -- 원래 시각으로 돌아오면 친구가 바꾸기 전 모습(시각 · time_source)으로, 아니면 친구가 정해 준 값이라 MANUAL
        time_source           = case
                                  when a.scheduled_at + (v_p.to_at - v_p.from_at) = coalesce(a.original_scheduled_at, a.scheduled_at) then coalesce(a.original_time_source, a.time_source)
                                  else 'MANUAL'
                                end,
        original_scheduled_at = case
                                  when a.scheduled_at + (v_p.to_at - v_p.from_at) = coalesce(a.original_scheduled_at, a.scheduled_at) then null
                                  else coalesce(a.original_scheduled_at, a.scheduled_at)
                                end,
        original_time_source  = case
                                  when a.scheduled_at + (v_p.to_at - v_p.from_at) = coalesce(a.original_scheduled_at, a.scheduled_at) then null
                                  else coalesce(a.original_time_source, a.time_source)
                                end
    where a.participant_id = v_a.participant_id
      and a.user_id = v_uid
      and a.scheduled_at > now()
    returning a.alarm_id
  )
  select array_agg(m.alarm_id order by m.alarm_id) into v_ids from moved m;
  perform set_config('app.alarm_apply', 'off', true);

  update public.alarm_proposals set status = 'APPLIED', responded_at = now() where proposal_id = v_p.proposal_id;
  update public.alarm_proposals ap
  set status = 'EXPIRED', responded_at = now()
  where ap.status = 'PENDING'
    and ap.alarm_id in (select a.alarm_id from public.alarms a where a.participant_id = v_a.participant_id);

  return jsonb_build_object('status', 'APPLIED', 'alarm_ids', to_jsonb(coalesce(v_ids, array[]::uuid[])));
end;
$$;


-- ---------------------------------------------------------------------
-- 5. 받은 제안 · 보낸 제안
-- ---------------------------------------------------------------------

-- 주인: 대기 중이고 알람이 켜져 있고 시각 전이며 새 시각이 지금 + 5분 이후이고 보낸 친구가 아직 설정 권한을 가진(차단 · 끊김 아닌) 제안, 늦게 보낸 순 — [적용]하면 바로 EXPIRED가 될 것은 안 보여 줌
create function public.my_alarm_proposals()
returns table (
  proposal_id       uuid,
  alarm_id          uuid,
  alarm_type        text,
  proposer_id       uuid,
  proposer_nickname varchar,
  from_at           timestamptz,
  to_at             timestamptz,
  created_at        timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.proposal_id, p.alarm_id, a.alarm_type::text, p.proposer_id, pr.nickname, p.from_at, p.to_at, p.created_at
  from public.alarm_proposals p
  join public.alarms a on a.alarm_id = p.alarm_id
  join public.profiles pr on pr.user_id = p.proposer_id
  where p.owner_id = (select auth.uid())
    and p.status = 'PENDING'
    and p.from_at > now()
    and p.to_at >= now() + interval '5 minutes'
    and a.is_enabled
    and a.scheduled_at = p.from_at
    and (select auth.uid()) in (select private.granted_owner_ids_for(p.proposer_id, 'EDIT_ALARM'))
  order by p.created_at desc, p.proposal_id;
$$;

-- 보낸 친구: 그 사람에게 보낸 제안 중 알람마다 가장 최근 것(대기 · 적용), 아직 안 울린 알람만. 무시된 제안은 status를 PENDING으로 돌려줘 '제안함' 그대로 (주인이 무시한 사실을 안 알림, 14-마)
--   '폰이 켜져 반영됨 / 아직'은 폰 동기 기록이 없어 여기서 안 정함
create function public.sent_alarm_proposals(p_owner_id uuid)
returns table (
  proposal_id uuid,
  alarm_id    uuid,
  status      text,
  from_at     timestamptz,
  to_at       timestamptz,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (p.alarm_id) p.proposal_id, p.alarm_id, case p.status when 'DISMISSED' then 'PENDING' else p.status end, p.from_at, p.to_at, p.created_at
  from public.alarm_proposals p
  join public.alarms a on a.alarm_id = p.alarm_id
  where p.proposer_id = (select auth.uid())
    and p.owner_id = p_owner_id
    and p.status in ('PENDING', 'APPLIED', 'DISMISSED')
    and a.scheduled_at > now()
    and p_owner_id in (select private.granted_owner_ids_for((select auth.uid()), 'EDIT_ALARM'))
  order by p.alarm_id, p.created_at desc, p.proposal_id;
$$;


-- ---------------------------------------------------------------------
-- 6. 보내도 되는지 — 알람 바뀜(제안) 알림
-- ---------------------------------------------------------------------

-- ALARM_CHANGED  보내는 사람이 받는 사람 알람의 설정 권한(조회도 함께)을 가졌고, 받는 사람에게 방금(1시간 안) 보낸 대기 중 제안이 있을 때 —
--                제안 없이 알림만 보내거나 지난 제안으로 다시 보내지 못하게 (10-08 · 10-25). 나머지 종류는 11장 그대로 (WAKE_PING은 늘 false — 깨우기는 8장 plan_wake_ping이 판정)
create or replace function public.can_send_push(p_sender_id uuid, p_target_id uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_sender_id is null or p_target_id is null then false
    when private.is_blocked_pair(p_sender_id, p_target_id) then false
    else case p_kind
      when 'ALARM_CHANGED' then coalesce(
        p_target_id in (select private.granted_owner_ids_for(p_sender_id, 'EDIT_ALARM'))
        and exists (
          select 1 from public.alarm_proposals ap
          where ap.proposer_id = p_sender_id and ap.owner_id = p_target_id
            and ap.status = 'PENDING' and ap.created_at >= now() - interval '1 hour'),
        false)
      when 'FRIEND_REQUEST' then exists (
        select 1 from public.friends f
        where f.status = 'PENDING' and f.requester_id = p_sender_id and f.addressee_id = p_target_id
          and f.requested_at >= now() - interval '1 hour')
      when 'FRIEND_ACCEPTED' then exists (
        select 1 from public.friends f
        where f.status = 'ACCEPTED' and f.requester_id = p_target_id and f.addressee_id = p_sender_id
          and f.accepted_at >= now() - interval '1 hour')
      else false
    end
  end;
$$;


-- ---------------------------------------------------------------------
-- 7. 실행 권한
-- ---------------------------------------------------------------------

revoke execute on function private.guard_alarm_original() from public, anon, authenticated;
revoke execute on function public.propose_alarm_time(uuid, timestamptz) from public, anon;
revoke execute on function public.respond_alarm_proposal(uuid, boolean) from public, anon;
revoke execute on function public.my_alarm_proposals() from public, anon;
revoke execute on function public.sent_alarm_proposals(uuid) from public, anon;
grant execute on function public.propose_alarm_time(uuid, timestamptz) to authenticated;
grant execute on function public.respond_alarm_proposal(uuid, boolean) to authenticated;
grant execute on function public.my_alarm_proposals() to authenticated;
grant execute on function public.sent_alarm_proposals(uuid) to authenticated;
