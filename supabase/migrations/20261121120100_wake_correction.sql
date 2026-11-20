-- 기상 정정 (11/20 지형님, D61 '판정마다 1탭 정정') — 앱 [아니에요]가 남기는 WAKE_CORRECTED를 DB가 이렇게 받음
--   앱은 alarm_events에 WAKE_CORRECTED(event_at = 정정한 시각, 기상 알람 id)를 씀. 본인 알람에만 쓰는 기존 RLS(alarm_events_insert_own)가 그대로 적용됨 — 정책 변경 없음
--   ① 확정 지우기     정정이 들어오면 같은 알람의 그 시각까지의 WAKE_CONFIRMED를 지움 → 그룹 조회 · 깨우기 · 미확인 배치 · 루틴 제안이 모두 한꺼번에 '확정 없음'으로 봄
--                     (조회 함수마다 정정을 따로 읽게 고치지 않음 — 놓치는 곳이 생기지 않게 한 곳에서). 정정 기록 자체는 남음(그 뒤의 자동 판정 재시도를 막는 근거)
--   ② 하루 기록 비우기 그 확정이 적힌 하루 기록(daily_records, 기상한 날)의 기상 확인 시각(wake_confirmed_at)을 비움. 알람 해제 시각(wake_reported_at)은 사실이라 둠
--   ③ 자동 판정 재시도 막기 같은 해제에서 나온 자동 판정(USAGE)이 폰 네이티브 재시도 · 앱 재업로드로 다시 들어와 정정을 되돌리지 않게, 정정 시각 이전 시각의 USAGE 확정은 받지 않음
--                     (알람 행은 다음 회차에 재사용되므로 정정 시각 뒤 1일 안의 확정만 막음 — 다음 날 새 판정은 통과, 정정 뒤 다시 해제해서 나온 새 판정도 통과)
--   ④ 새로 고침 신호  친구 화면이 '기상 완료'에서 되돌아가도록 그 그룹에 신호 (기상 공유를 켠 그룹, 약속 있는 날만 — send_wake_signal과 같은 조건)

-- ---------------------------------------------------------------------
-- ① · ② 확정 지우기 + 하루 기록 비우기 + ④ 신호
-- ---------------------------------------------------------------------

create function private.apply_wake_correction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz    text;
  v_conf  record;
  v_dates date[] := '{}';
  v_date  date;
  v_group uuid;
begin
  select p.timezone into v_tz from public.profiles p where p.user_id = new.user_id;
  v_tz := coalesce(v_tz, 'Asia/Seoul');

  for v_conf in
    delete from public.alarm_events e
    where e.user_id = new.user_id
      and e.alarm_id = new.alarm_id
      and e.event_type = 'WAKE_CONFIRMED'
      and e.event_at <= new.event_at
    returning e.event_at, e.alarm_id
  loop
    v_date := private.wake_day(v_conf.alarm_id, v_conf.event_at, v_tz);
    update public.daily_records d
       set wake_confirmed_at = null, updated_at = now()
     where d.user_id = new.user_id and d.record_date = v_date and d.wake_confirmed_at = v_conf.event_at;
    if not v_date = any (v_dates) then
      v_dates := v_dates || v_date;
    end if;
  end loop;

  -- 지울 확정이 없었어도(이미 앱이 지움) 정정한 날의 친구 화면은 다시 읽게 함
  if cardinality(v_dates) = 0 then
    v_dates := array[private.wake_day(new.alarm_id, new.event_at, v_tz)];
  end if;

  foreach v_date in array v_dates loop
    for v_group in
      select gm.group_id
      from public.group_members gm
      where gm.user_id = new.user_id
        and gm.invite_status = 'JOINED'
        and gm.wake_share_opt_in
        and private.group_wake_has_meeting(gm.group_id, v_date, v_tz)
    loop
      perform private.send_group_refresh(v_group, v_date);
    end loop;
  end loop;

  return null;
end;
$$;

revoke execute on function private.apply_wake_correction() from public, anon, authenticated;

create trigger apply_wake_correction
  after insert on public.alarm_events
  for each row when (new.event_type = 'WAKE_CORRECTED')
  execute function private.apply_wake_correction();

-- ---------------------------------------------------------------------
-- ③ 정정된 해제의 자동 판정(USAGE) 확정은 받지 않음
-- ---------------------------------------------------------------------

create function private.block_confirm_after_correction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.alarm_events c
    where c.user_id = new.user_id
      and c.alarm_id = new.alarm_id
      and c.event_type = 'WAKE_CORRECTED'
      and c.event_at >= new.event_at
      and c.event_at <  new.event_at + interval '1 day'
  ) then
    return null; -- 조용히 버림 (같은 번호를 다시 보내도 같은 결과 — 폰 재시도가 오류로 막히지 않게)
  end if;
  return new;
end;
$$;

revoke execute on function private.block_confirm_after_correction() from public, anon, authenticated;

create trigger block_confirm_after_correction
  before insert on public.alarm_events
  for each row when (new.event_type = 'WAKE_CONFIRMED' and new.input_source = 'USAGE')
  execute function private.block_confirm_after_correction();
