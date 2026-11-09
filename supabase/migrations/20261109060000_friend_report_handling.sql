-- =====================================================================
-- 친구 4장 꼬리 — 신고 처리 함수 · 팀원 표 (친구 논리설계 4장 · X-10 · 99-04). 이슈 #431
--   ① team_members: 팀원 목록 표(서버 전용). 웹 운영 화면은 이 표에 있는 로그인 계정만 열림. 팀원 추가는 헤드가 서버 키(service_role)로
--   ② list_reports · resolve_report: 운영 화면의 신고 목록 · [숨김] / [무시]. 팀원 아니면 FORBIDDEN
--   ③ 괴롭힘 신고의 근거 보관: 깨우기 · 알람 제안 기록은 7일 뒤 지워지므로(13장), 사람 대상 괴롭힘 신고가 들어온 순간 그 두 사람 사이의
--      7일 안 기록을 신고 줄(reports.evidence)에 복사. 신고가 없는 기록은 7일 뒤 그대로 지워짐
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 팀원 표
-- ---------------------------------------------------------------------

-- 앱(anon · authenticated)은 읽지도 쓰지도 못함 — RLS를 켜고 정책을 안 만듦. 서버 역할만. 탈퇴하면 같이 지워짐
create table public.team_members (
  user_id  uuid primary key references public.profiles (user_id) on delete cascade,
  added_at timestamptz not null default now()
);

comment on table public.team_members is '운영 화면(웹 신고 처리)을 열 수 있는 팀원 계정. 서버 전용 — 추가 · 삭제는 서버 키로 (친구 4장, 11/8 지형님 결정)';

alter table public.team_members enable row level security;
revoke all on public.team_members from anon, authenticated;
grant select, insert, update, delete on public.team_members to service_role;

create function private.is_team_member(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_uid is not null and exists (select 1 from public.team_members t where t.user_id = p_uid);
$$;

revoke execute on function private.is_team_member(uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. 신고 줄: 처리 결과 · 근거
-- ---------------------------------------------------------------------

alter table public.reports
  add column resolution text check (resolution is null or resolution in ('HIDDEN', 'DISMISSED')),
  add column evidence jsonb;

-- 처리 함수가 생기기 전에 서버 키로 직접 DONE으로 바꾼 줄이 있어도 아래 제약 추가가 멈추지 않게: 결과 없는 처리됨 줄은 무시(DISMISSED)로 봄
--   (그런 줄을 만드는 앱 · 서버 길은 없었음 — 실서버에는 보통 0줄)
update public.reports set resolution = 'DISMISSED' where status = 'DONE' and resolution is null;

-- 처리 중이면 결과가 없고, 처리됨이면 결과가 있음
alter table public.reports add constraint reports_resolution_shape
  check ((status = 'OPEN' and resolution is null) or (status = 'DONE' and resolution is not null));

comment on column public.reports.resolution is '처리 결과 — HIDDEN(숨김: 대상 닉네임 · 사진 · 그룹 이름 초기화) · DISMISSED(무시). status가 DONE일 때만';
comment on column public.reports.evidence is '괴롭힘 신고 근거 — 신고하는 순간 두 사람 사이의 7일 안 깨우기 · 알람 제안 기록 복사(원본은 7일 뒤 지워짐). 서버 전용';


-- ---------------------------------------------------------------------
-- 3. 신고 넣기: 괴롭힘이면 근거 복사 (앱 호출 모양은 그대로)
-- ---------------------------------------------------------------------

create or replace function public.submit_report(p_target_type text, p_target_id uuid, p_reason text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_note     text;
  v_tz       text;
  v_day0     timestamptz;
  v_evidence jsonb;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  if p_target_type is null or p_reason is null
     or p_target_type not in ('USER', 'GROUP')
     or (p_target_type = 'USER'  and p_reason not in ('HARASSMENT', 'NICKNAME', 'PHOTO', 'OTHER'))
     or (p_target_type = 'GROUP' and p_reason not in ('GROUP_NAME', 'HARASSMENT', 'OTHER'))
     or (p_note is not null and length(p_note) > 1000) then
    return jsonb_build_object('status', 'INVALID');
  end if;
  v_note := nullif(private.trim_spaces(p_note), '');
  if v_note is not null and char_length(v_note) > 200 then
    return jsonb_build_object('status', 'INVALID');
  end if;

  if p_target_id is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if p_target_type = 'USER' then
    if p_target_id = v_uid then
      return jsonb_build_object('status', 'SELF');
    end if;
    if not exists (select 1 from public.profiles p where p.user_id = p_target_id) then
      return jsonb_build_object('status', 'NOT_FOUND');
    end if;
  elsif not private.is_group_invited_or_member(p_target_id) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  -- 같은 사람이 같은 대상을 동시에 두 번 눌러도 한 번만
  perform pg_advisory_xact_lock(hashtextextended('report:' || v_uid::text || ':' || p_target_id::text, 0));

  select coalesce(p.timezone, 'Asia/Seoul') into v_tz from public.profiles p where p.user_id = v_uid;
  v_tz := coalesce(v_tz, 'Asia/Seoul');
  v_day0 := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;

  if exists (
    select 1 from public.reports r
    where r.reporter_id = v_uid
      and r.target_type = p_target_type
      and coalesce(r.target_user_id, r.target_group_id) = p_target_id
      and r.created_at >= v_day0
  ) then
    return jsonb_build_object('status', 'ALREADY_REPORTED');
  end if;

  -- 사람 대상 괴롭힘 신고: 두 사람 사이(어느 쪽이 보냈든)의 7일 안 깨우기 · 알람 제안 기록을 복사. 각 50건까지, 최신 순
  if p_target_type = 'USER' and p_reason = 'HARASSMENT' then
    v_evidence := jsonb_build_object(
      'captured_at', now(),
      'wake_pings', coalesce((
        select jsonb_agg(jsonb_build_object('sender_id', x.sender_id, 'target_id', x.target_id, 'sent_at', x.sent_at) order by x.sent_at desc)
        from (select ps.sender_id, ps.target_id, ps.sent_at
              from public.push_sends ps
              where ps.kind = 'WAKE_PING'
                and ps.sent_at >= now() - interval '7 days'
                and ((ps.sender_id = v_uid and ps.target_id = p_target_id) or (ps.sender_id = p_target_id and ps.target_id = v_uid))
              order by ps.sent_at desc
              limit 50) x), '[]'::jsonb),
      'alarm_proposals', coalesce((
        select jsonb_agg(jsonb_build_object('proposer_id', y.proposer_id, 'owner_id', y.owner_id, 'status', y.status,
                                            'from_at', y.from_at, 'to_at', y.to_at, 'created_at', y.created_at) order by y.created_at desc)
        from (select ap.proposer_id, ap.owner_id, ap.status, ap.from_at, ap.to_at, ap.created_at
              from public.alarm_proposals ap
              where ap.created_at >= now() - interval '7 days'
                and ((ap.proposer_id = v_uid and ap.owner_id = p_target_id) or (ap.proposer_id = p_target_id and ap.owner_id = v_uid))
              order by ap.created_at desc
              limit 50) y), '[]'::jsonb));
  end if;

  insert into public.reports (reporter_id, target_type, target_user_id, target_group_id, reason, note, evidence)
  values (v_uid, p_target_type,
          case when p_target_type = 'USER' then p_target_id end,
          case when p_target_type = 'GROUP' then p_target_id end,
          p_reason, v_note, v_evidence);
  return jsonb_build_object('status', 'REPORTED');
end;
$$;


-- ---------------------------------------------------------------------
-- 4. 운영 화면 함수 (팀원 계정만)
-- ---------------------------------------------------------------------

-- 신고 목록. p_status: OPEN(처리 전, 기본) · DONE(처리됨) · ALL. 최신 순, p_limit 1~100(기본 50)
--   상태: OK{total, reports} · FORBIDDEN(팀원 아님) · INVALID. 로그인 안 했으면 42501 (익명은 실행 권한도 없음)
--   대상 닉네임 · 사진 · 그룹 이름은 지금 값(숨김 뒤엔 초기화된 값)
create function public.list_reports(p_status text default 'OPEN', p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_total integer;
  v_rows  jsonb;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if not private.is_team_member(v_uid) then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;
  if p_status is null or p_status not in ('OPEN', 'DONE', 'ALL') or p_limit is null or p_limit < 1 or p_limit > 100 then
    return jsonb_build_object('status', 'INVALID');
  end if;

  select count(*)::integer into v_total
  from public.reports r
  where p_status = 'ALL' or r.status = p_status;

  select coalesce(jsonb_agg(jsonb_build_object(
           'report_id', x.report_id,
           'status', x.status,
           'resolution', x.resolution,
           'target_type', x.target_type,
           'target_user_id', x.target_user_id,
           'target_nickname', x.target_nickname,
           'target_profile_image_url', x.target_profile_image_url,
           'target_group_id', x.target_group_id,
           'target_group_name', x.target_group_name,
           'reason', x.reason,
           'note', x.note,
           'reporter_id', x.reporter_id,
           'reporter_nickname', x.reporter_nickname,
           'created_at', x.created_at,
           'handled_by', x.handled_by,
           'handled_by_nickname', x.handled_by_nickname,
           'handled_at', x.handled_at,
           'evidence', x.evidence) order by x.created_at desc, x.report_id), '[]'::jsonb)
    into v_rows
  from (
    select r.report_id, r.status, r.resolution, r.target_type, r.target_user_id, tp.nickname as target_nickname,
           tp.profile_image_url as target_profile_image_url, r.target_group_id, tg.group_name as target_group_name,
           r.reason, r.note, r.reporter_id, rp.nickname as reporter_nickname, r.created_at, r.handled_by,
           hp.nickname as handled_by_nickname, r.handled_at, r.evidence
    from public.reports r
    left join public.profiles tp on tp.user_id = r.target_user_id
    left join public.groups tg on tg.group_id = r.target_group_id
    left join public.profiles rp on rp.user_id = r.reporter_id
    left join public.profiles hp on hp.user_id = r.handled_by
    where p_status = 'ALL' or r.status = p_status
    order by r.created_at desc, r.report_id
    limit p_limit
  ) x;

  return jsonb_build_object('status', 'OK', 'total', v_total, 'reports', v_rows);
end;
$$;

-- 신고 처리. p_action: HIDE(숨김 — 사람 대상은 닉네임 '사용자' · 사진 비움, 그룹 대상은 그룹 이름 '이름 없는 그룹') · DISMISS(무시 — 대상 그대로)
--   둘 다 신고를 처리됨(DONE)으로 하고 처리한 사람 · 시각을 남김. 신고한 사람에게 알림 없음
--   상태: HIDDEN · DISMISSED · ALREADY_DONE(이미 처리됨 — 다시 안 바꿈) · NOT_FOUND · INVALID · FORBIDDEN(팀원 아님). 팀원 확인이 먼저라 팀원 아니면 신고가 있는지도 모름
create function public.resolve_report(p_report_id uuid, p_action text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_r          record;
  v_resolution text;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if not private.is_team_member(v_uid) then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;
  if p_report_id is null or p_action is null or p_action not in ('HIDE', 'DISMISS') then
    return jsonb_build_object('status', 'INVALID');
  end if;

  -- 두 팀원이 같은 신고를 동시에 처리해도 한 번만
  select r.report_id, r.status, r.target_type, r.target_user_id, r.target_group_id into v_r
  from public.reports r
  where r.report_id = p_report_id
  for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if v_r.status = 'DONE' then
    return jsonb_build_object('status', 'ALREADY_DONE');
  end if;

  if p_action = 'HIDE' then
    if v_r.target_type = 'USER' then
      update public.profiles set nickname = '사용자', profile_image_url = null where user_id = v_r.target_user_id;
    else
      update public.groups set group_name = '이름 없는 그룹' where group_id = v_r.target_group_id;
    end if;
    v_resolution := 'HIDDEN';
  else
    v_resolution := 'DISMISSED';
  end if;

  update public.reports
  set status = 'DONE', resolution = v_resolution, handled_by = v_uid, handled_at = now()
  where report_id = p_report_id;

  return jsonb_build_object('status', v_resolution, 'report_id', p_report_id);
end;
$$;

revoke execute on function public.list_reports(text, integer), public.resolve_report(uuid, text) from public, anon;
grant execute on function public.list_reports(text, integer), public.resolve_report(uuid, text) to authenticated;
