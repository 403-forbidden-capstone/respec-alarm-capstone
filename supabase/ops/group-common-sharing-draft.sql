-- DRAFT: promote through supabase migration new and DB regression tests before deploy.
-- Group policy is a common versioned rule; only consenting members get effective permissions.
-- Existing rules start with the intersection of existing permissions, never an expansion.
create table private.group_share_rules (
  group_id uuid primary key references public.groups(group_id) on delete cascade,
  version uuid not null default gen_random_uuid(),
  view_alarm boolean not null default false,
  edit_alarm boolean not null default false,
  view_wake boolean not null default false,
  view_trip boolean not null default false,
  check (not edit_alarm or view_alarm),
  check (not view_trip or view_wake)
);
create table private.group_share_consents (
  group_id uuid not null references public.groups(group_id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  version uuid not null,
  primary key (group_id,user_id)
);
revoke all on private.group_share_rules, private.group_share_consents from public, anon, authenticated;
alter table private.group_share_rules enable row level security;
alter table private.group_share_consents enable row level security;

insert into private.group_share_rules(group_id, view_alarm, edit_alarm, view_wake, view_trip)
select g.group_id,
  exists(select 1 from public.group_members m where m.group_id=g.group_id and m.invite_status='JOINED' having count(*)>1)
  and not exists(select 1 from public.group_members a join public.group_members b on b.group_id=a.group_id and a.user_id<>b.user_id
    where a.group_id=g.group_id and a.invite_status='JOINED' and b.invite_status='JOINED'
      and not exists(select 1 from public.sharing_permissions s where s.source_type='GROUP' and s.source_id=g.group_id and s.owner_id=a.user_id and s.grantee_id=b.user_id and s.can_view_alarm)),
  exists(select 1 from public.group_members m where m.group_id=g.group_id and m.invite_status='JOINED' having count(*)>1)
  and not exists(select 1 from public.group_members a join public.group_members b on b.group_id=a.group_id and a.user_id<>b.user_id
    where a.group_id=g.group_id and a.invite_status='JOINED' and b.invite_status='JOINED'
      and not exists(select 1 from public.sharing_permissions s where s.source_type='GROUP' and s.source_id=g.group_id and s.owner_id=a.user_id and s.grantee_id=b.user_id and s.can_view_alarm and s.can_edit_alarm)),
  coalesce((select bool_and(m.wake_share_opt_in) from public.group_members m where m.group_id=g.group_id and m.invite_status='JOINED'),false),
  coalesce((select bool_and(m.wake_share_opt_in and m.trip_share_opt_in) from public.group_members m where m.group_id=g.group_id and m.invite_status='JOINED'),false)
from public.groups g;
insert into private.group_share_consents
select m.group_id,m.user_id,r.version from public.group_members m join private.group_share_rules r using(group_id) where m.invite_status='JOINED';

create function private.group_rule_on_create() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into private.group_share_rules(group_id) values(new.group_id) on conflict do nothing;
 return new;
end $$;
create trigger init_common_group_rule after insert on public.groups for each row execute function private.group_rule_on_create();

create function private.group_rule_accepted(g uuid,u uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.group_share_rules r join private.group_share_consents c on c.group_id=r.group_id and c.version=r.version
 join public.group_members m on m.group_id=c.group_id and m.user_id=c.user_id and m.invite_status='JOINED'
 where r.group_id=g and c.user_id=u)
$$;
create function private.refresh_common_group_rule(g uuid) returns void language plpgsql security definer set search_path='' as $$
declare r private.group_share_rules%rowtype;
begin
 select * into r from private.group_share_rules where group_id=g;
 if not found then return; end if;
 update public.group_members m set
  wake_share_opt_in=r.view_wake and private.group_rule_accepted(g,m.user_id),
  trip_share_opt_in=r.view_trip and private.group_rule_accepted(g,m.user_id)
 where m.group_id=g and m.invite_status='JOINED' and
 (m.wake_share_opt_in,m.trip_share_opt_in) is distinct from
 (r.view_wake and private.group_rule_accepted(g,m.user_id),r.view_trip and private.group_rule_accepted(g,m.user_id));
 delete from public.sharing_permissions s where s.source_type='GROUP' and s.source_id=g;
 insert into public.sharing_permissions(owner_id,grantee_id,source_type,source_id,can_view_alarm,can_edit_alarm,can_view_wake)
 select a.user_id,b.user_id,'GROUP',g,r.view_alarm,r.edit_alarm,false
 from public.group_members a join public.group_members b on a.group_id=b.group_id and a.user_id<>b.user_id
 where a.group_id=g and a.invite_status='JOINED' and b.invite_status='JOINED'
 and private.group_rule_accepted(g,a.user_id) and private.group_rule_accepted(g,b.user_id)
 and not private.is_blocked_pair(a.user_id,b.user_id) and r.view_alarm;
end $$;
-- Do not retain old automatic incoming-only grant behavior.
create or replace function private.grant_default_group_view() returns trigger language plpgsql security definer set search_path='' as $$
begin return null; end $$;
create function private.group_rule_member_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then
   delete from private.group_share_consents where group_id=old.group_id and user_id=old.user_id;
   return old;
 end if;
 if old.invite_status is distinct from new.invite_status then
   delete from private.group_share_consents where group_id=new.group_id and user_id=new.user_id;
 end if;
 return new;
end $$;
create trigger clear_group_rule_consent after delete or update of invite_status on public.group_members
 for each row execute function private.group_rule_member_change();
-- Old clients may still join but must not acquire sharing without accepting the version.
-- Direct writes cannot expand permissions; authenticated updates to share fields are blocked below.
create function private.guard_common_group_member_write() returns trigger language plpgsql set search_path='' as $$
begin
 if current_user in ('authenticated','anon') and tg_op='UPDATE' then
   if (new.wake_share_opt_in,new.trip_share_opt_in) is distinct from (old.wake_share_opt_in,old.trip_share_opt_in) then
     raise exception 'Use group rule consent' using errcode='42501';
   end if;
 elsif tg_op='INSERT' or (tg_op='UPDATE' and old.invite_status is distinct from new.invite_status) then
   new.wake_share_opt_in:=false; new.trip_share_opt_in:=false;
 end if;
 return new;
end $$;
create trigger aa_common_group_member_write before insert or update on public.group_members for each row execute function private.guard_common_group_member_write();
-- Existing friend grants may not grant alarm view or edit after migration.
create or replace function private.normalize_sharing_permission() returns trigger language plpgsql set search_path='' as $$
begin
 if new.source_type='FRIEND' then
   new.can_view_alarm:=false; new.can_edit_alarm:=false;
 elsif current_user in ('authenticated','anon') then
   raise exception 'Use group rule consent' using errcode='42501';
 elsif not new.can_view_alarm then new.can_edit_alarm:=false;
 end if;
 return new;
end $$;
update public.sharing_permissions set can_view_alarm=false,can_edit_alarm=false where source_type='FRIEND';
create or replace function private.granted_owner_ids_for(p_grantee_id uuid,p_kind text) returns setof uuid language sql stable security definer set search_path='' as $$
 select sp.owner_id from public.sharing_permissions sp
 where sp.grantee_id=p_grantee_id and sp.source_type='GROUP'
 and private.group_rule_accepted(sp.source_id,sp.owner_id) and private.group_rule_accepted(sp.source_id,sp.grantee_id)
 and case p_kind when 'VIEW_ALARM' then sp.can_view_alarm when 'EDIT_ALARM' then sp.can_view_alarm and sp.can_edit_alarm else false end
 and private.is_valid_permission_source(sp.owner_id,sp.grantee_id,sp.source_type,sp.source_id)
$$;
create or replace function private.can_see_wake(p_viewer uuid,p_owner uuid,p_group_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select private.group_rule_accepted(p_group_id,p_viewer) and private.group_rule_accepted(p_group_id,p_owner)
 and exists(select 1 from public.group_members m where m.group_id=p_group_id and m.user_id=p_owner and m.invite_status='JOINED' and m.wake_share_opt_in)
 and not private.is_blocked_pair(p_viewer,p_owner)
 and not exists(select 1 from public.wake_hides h where h.owner_id=p_owner and h.hidden_from_id=p_viewer)
$$;
-- Old RPC must not mutate group grants independently.
create or replace function public.save_group_permissions(p_group_id uuid,p_can_view_alarm boolean,p_can_edit_alarm boolean) returns jsonb language plpgsql security definer set search_path='' as $$
begin return jsonb_build_object('status','RULE_REQUIRED'); end $$;

create function private.group_rule_json(g uuid,u uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('status','OK','version',r.version,'viewAlarm',r.view_alarm,'editAlarm',r.edit_alarm,'viewWake',r.view_wake,'viewTrip',r.view_trip,
 'accepted',private.group_rule_accepted(g,u),
 'acceptedCount',(select count(*) from public.group_members m where m.group_id=g and m.invite_status='JOINED' and private.group_rule_accepted(g,m.user_id)),
 'memberCount',private.group_member_count(g))
 from private.group_share_rules r where r.group_id=g
$$;
create function public.get_common_group_rule(p_group_id uuid default null,p_code text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); g uuid:=p_group_id; pre jsonb;
begin
 if u is null then raise exception 'Login required' using errcode='42501'; end if;
 if p_code is not null then
   pre:=public.preview_group_by_code(p_code);
   if pre->>'status'<>'FOUND' then return pre; end if;
   select group_id into g from public.groups where invite_code=private.normalize_group_code(p_code) and invite_code_expires_at>now();
 elsif not exists(select 1 from public.group_members m where m.group_id=g and m.user_id=u and (m.invite_status='JOINED' or (m.invite_status='INVITED' and (m.invited_by is null or not private.is_blocked_pair(u,m.invited_by))))) then
   return jsonb_build_object('status','NOT_FOUND');
 end if;
 return coalesce(private.group_rule_json(g,u),jsonb_build_object('status','NOT_FOUND'));
end $$;
create function public.save_common_group_rule(p_group_id uuid,p_version uuid,p_view_alarm boolean,p_edit_alarm boolean,p_view_wake boolean,p_view_trip boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); r private.group_share_rules%rowtype;
begin
 if u is null then raise exception 'Login required' using errcode='42501'; end if;
 perform private.lock_group(p_group_id);
 if not exists(select 1 from public.group_members where group_id=p_group_id and user_id=u and invite_status='JOINED') then return jsonb_build_object('status','NOT_FOUND'); end if;
 select * into r from private.group_share_rules where group_id=p_group_id;
 if r.version is distinct from p_version then return jsonb_build_object('status','RULE_CHANGED'); end if;
 if (r.view_alarm,r.edit_alarm,r.view_wake,r.view_trip) is distinct from (coalesce(p_view_alarm,false) or coalesce(p_edit_alarm,false),coalesce(p_edit_alarm,false),coalesce(p_view_wake,false),coalesce(p_view_wake,false) and coalesce(p_view_trip,false)) then
   update private.group_share_rules set version=gen_random_uuid(),view_alarm=coalesce(p_view_alarm,false) or coalesce(p_edit_alarm,false),edit_alarm=coalesce(p_edit_alarm,false),view_wake=coalesce(p_view_wake,false),view_trip=coalesce(p_view_wake,false) and coalesce(p_view_trip,false) where group_id=p_group_id returning * into r;
 end if;
 insert into private.group_share_consents values(p_group_id,u,r.version) on conflict(group_id,user_id) do update set version=excluded.version;
 perform private.refresh_common_group_rule(p_group_id);
 return private.group_rule_json(p_group_id,u);
end $$;
create function public.withdraw_common_group_rule(p_group_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();
begin
 if u is null then raise exception 'Login required' using errcode='42501'; end if;
 perform private.lock_group(p_group_id);
 if not exists(select 1 from public.group_members where group_id=p_group_id and user_id=u and invite_status='JOINED') then return jsonb_build_object('status','NOT_FOUND'); end if;
 delete from private.group_share_consents where group_id=p_group_id and user_id=u;
 perform private.refresh_common_group_rule(p_group_id);
 return private.group_rule_json(p_group_id,u);
end $$;
-- New join is bound to the exact reviewed version. Existing join RPC handles code validity,
-- member limits and block rules. Version check after join rolls back on a concurrent change.
create function public.join_group_with_rule(p_version uuid,p_group_id uuid default null,p_code text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); result jsonb; g uuid; v uuid;
begin
 if u is null then raise exception 'Login required' using errcode='42501'; end if;
 if (p_group_id is null)=(p_code is null) then return jsonb_build_object('status','NOT_FOUND'); end if;
 if p_code is not null then result:=public.join_group(p_code,false);
 else result:=public.accept_group_invite(p_group_id,false); end if;
 if result->>'status' not in ('JOINED','ALREADY_JOINED') then return result; end if;
 g:=(result->>'group_id')::uuid;
 perform private.lock_group(g);
 select version into v from private.group_share_rules where group_id=g;
 if v is distinct from p_version then raise exception 'RULE_CHANGED' using errcode='P0001'; end if;
 insert into private.group_share_consents values(g,u,v) on conflict(group_id,user_id) do update set version=excluded.version;
 perform private.refresh_common_group_rule(g);
 return result;
end $$;
-- Friend-only wake status: no location, alarm schedule or private journal.
create function public.get_friend_wake(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u uuid:=auth.uid(); tz text; at_time timestamptz;
begin
 if u is null or u=p_user_id or private.is_blocked_pair(u,p_user_id) or not exists(
 select 1 from public.sharing_permissions s where s.owner_id=p_user_id and s.grantee_id=u and s.source_type='FRIEND' and s.can_view_wake and private.is_valid_permission_source(s.owner_id,s.grantee_id,s.source_type,s.source_id))
 or exists(select 1 from public.wake_hides h where h.owner_id=p_user_id and h.hidden_from_id=u) then return jsonb_build_object('status','NOT_SHARED'); end if;
 select coalesce(timezone,'Asia/Seoul') into tz from public.profiles where user_id=p_user_id;
 select min(e.event_at) into at_time from public.alarm_events e
 where e.user_id=p_user_id and e.event_type='WAKE_CONFIRMED'
 and private.life_day(e.event_at,tz)=private.life_day(now(),tz)
 and coalesce(e.input_source::text,'') not in ('MANUAL','VOICE')
 and (e.input_source is distinct from 'USAGE' or e.event_at<=now()-interval '20 minutes') and e.event_at<=now();
 return jsonb_build_object('status',case when at_time is null then 'UNCONFIRMED' else 'CONFIRMED' end,'confirmed_at',at_time);
end $$;
revoke all on function private.group_rule_on_create(),private.group_rule_accepted(uuid,uuid),private.refresh_common_group_rule(uuid),private.group_rule_member_change(),private.guard_common_group_member_write(),private.group_rule_json(uuid,uuid) from public,anon,authenticated;
revoke all on function public.get_common_group_rule(uuid,text),public.save_common_group_rule(uuid,uuid,boolean,boolean,boolean,boolean),public.withdraw_common_group_rule(uuid),public.join_group_with_rule(uuid,uuid,text),public.get_friend_wake(uuid) from public,anon;
grant execute on function public.get_common_group_rule(uuid,text),public.save_common_group_rule(uuid,uuid,boolean,boolean,boolean,boolean),public.withdraw_common_group_rule(uuid),public.join_group_with_rule(uuid,uuid,text),public.get_friend_wake(uuid) to authenticated;
-- Reconcile existing permissions only after guards and rules are installed.
select private.refresh_common_group_rule(group_id) from private.group_share_rules;
