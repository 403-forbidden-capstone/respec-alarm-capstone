-- Preference edit epoch for pure outing preparation. Backfill is intentionally NULL.
alter table public.profiles add column if not exists default_outing_prep_updated_at timestamptz;
comment on column public.profiles.default_outing_prep_updated_at is
  'Server-owned timestamp of latest change to default_outing_prep_minutes.';

create or replace function private.track_outing_prep_preference_epoch()
returns trigger language plpgsql security invoker set search_path to ''
as $$
begin
  if tg_op = 'INSERT' then
    new.default_outing_prep_updated_at :=
      case when new.default_outing_prep_minutes is not null then clock_timestamp() else null end;
    return new;
  end if;
  if new.default_outing_prep_minutes is distinct from old.default_outing_prep_minutes then
    new.default_outing_prep_updated_at := clock_timestamp();
  else
    new.default_outing_prep_updated_at := old.default_outing_prep_updated_at;
  end if;
  return new;
end;
$$;
revoke all on function private.track_outing_prep_preference_epoch() from public, anon, authenticated;
drop trigger if exists track_outing_prep_preference_epoch on public.profiles;
create trigger track_outing_prep_preference_epoch before insert or update
on public.profiles for each row execute function private.track_outing_prep_preference_epoch();
