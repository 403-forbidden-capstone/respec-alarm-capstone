-- Security, idempotency, RLS and clock tests against the actual migration.
set role authenticated;
select set_config('request.jwt.claim.sub','f60d371e-63a5-4fb9-9d92-0743392325ec',false);
do $$
declare
  first_time timestamptz;
  retry_time timestamptz;
  legacy_time timestamptz;
begin
  -- Direct PostgREST-style UPDATE must NEVER honor a forged timestamp.
  update public.appointment_participants
    set self_reported_prep_started_at='2020-01-01T00:00:00Z'
  where participant_id='10000000-0000-4000-8000-000000000001'
  returning self_reported_prep_started_at into first_time;
  if first_time is null or abs(extract(epoch from (now()-first_time)))>5 then
    raise exception 'client timestamp forging was accepted';
  end if;
  select public.confirm_prep_start_self_report('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') into retry_time;
  if retry_time <> first_time then raise exception 'RPC idempotency failed'; end if;
  select prepare_started_at into legacy_time
    from public.appointment_participants where participant_id='10000000-0000-4000-8000-000000000001';
  if legacy_time is null or legacy_time >= first_time then raise exception 'legacy dismissal overwritten'; end if;

  begin
    update public.appointment_participants
    set self_reported_prep_started_at=now()+interval '100 years'
    where participant_id='10000000-0000-4000-8000-000000000001';
    raise exception 'mutable first report timestamp';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform public.confirm_prep_start_self_report('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    raise exception 'out of time-window report accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    update public.appointment_participants
    set self_reported_prep_started_at=now()
    where participant_id='10000000-0000-4000-8000-000000000003';
    raise exception 'out of window direct write accepted';
  exception when sqlstate '42501' then null;
  end;
  if exists(select 1 from public.appointment_participants where user_id='00000000-0000-4000-8000-000000000002')
  then raise exception 'RLS leaked another user'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
do $$
begin
  begin
    perform public.confirm_prep_start_self_report('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    raise exception 'nonpilot account accepted';
  exception when sqlstate '42501' then null;
  end;
  begin
    update public.appointment_participants
    set self_reported_prep_started_at='2020-01-01T00:00:00Z'
    where participant_id='10000000-0000-4000-8000-000000000002';
    raise exception 'nonpilot direct update accepted';
  exception when sqlstate '42501' then null;
  end;
end $$;
reset role;
-- Public/anon do not get execute privilege on RPC.
do $$ begin
 if has_function_privilege('anon','public.confirm_prep_start_self_report(uuid)','EXECUTE') then
   raise exception 'anon RPC execute privilege leaked';
 end if;
end $$;
select 'self-report contract PASS' as result;
