-- Isolated PostgreSQL fixture for actual migration and role/trigger tests.
create role authenticated;
create role anon;
create schema auth;
create schema private;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
create table public.appointments (
  appointment_id uuid primary key,
  appointment_at timestamptz not null,
  group_id uuid
);
create table public.appointment_participants (
  participant_id uuid primary key,
  appointment_id uuid not null references public.appointments,
  user_id uuid not null,
  prepare_started_at timestamptz,
  departed_at timestamptz
);
create table public.alarms (
  alarm_id uuid primary key,
  participant_id uuid not null references public.appointment_participants,
  user_id uuid not null,
  alarm_type text not null,
  is_enabled boolean not null
);
grant select on public.appointments,public.alarms to authenticated;
grant select, update, insert on public.appointment_participants to authenticated;
alter table public.appointment_participants enable row level security;
create policy own_select on public.appointment_participants for select to authenticated
 using (user_id=(select auth.uid()));
create policy own_update on public.appointment_participants for update to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));

insert into public.appointments values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',now()+interval '1 hour',null),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',now()+interval '1 hour',null),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',now()+interval '8 hours',null);
insert into public.appointment_participants(participant_id,appointment_id,user_id,prepare_started_at)
values
 ('10000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','f60d371e-63a5-4fb9-9d92-0743392325ec',now()-interval '5 minutes'),
 ('10000000-0000-4000-8000-000000000002','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','00000000-0000-4000-8000-000000000002',null),
 ('10000000-0000-4000-8000-000000000003','cccccccc-cccc-4ccc-8ccc-cccccccccccc','f60d371e-63a5-4fb9-9d92-0743392325ec',null);
insert into public.alarms values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','f60d371e-63a5-4fb9-9d92-0743392325ec','PREPARE',true),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','PREPARE',true),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','f60d371e-63a5-4fb9-9d92-0743392325ec','PREPARE',true);
