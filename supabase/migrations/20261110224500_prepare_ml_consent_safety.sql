-- Corrective, append-only migration for PR #478.
-- Do not automatically approve self-reported age as a verified model code
-- before the official 2024 survey codebook and data-processing consent are approved.
-- The prior migration is kept unchanged in history.

-- The mobile client can submit its own clock time. Normalize NEW consent
-- timestamps using the database clock before any AFTER UPDATE revocation runs.
create or replace function public.stamp_prepare_ml_consent_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.ml_profile_consented_at is not null
     and new.ml_profile_consented_at is distinct from old.ml_profile_consented_at
  then
    new.ml_profile_consented_at := statement_timestamp();
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_prepare_ml_consent_at()
  from public, anon, authenticated;

create trigger profiles_ml_consent_server_timestamp
  before update of ml_profile_consented_at
  on public.profiles
  for each row execute function public.stamp_prepare_ml_consent_at();

-- Restore the original invalidate-only policy. A user-controlled value
-- must never insert a row into prepare_ml_verified_profiles by itself.
create or replace function public.invalidate_prepare_ml_verification_on_survey_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (old.ml_age_years, old.ml_school_status, old.ml_work_status, old.ml_profile_consented_at)
    is distinct from
     (new.ml_age_years, new.ml_school_status, new.ml_work_status, new.ml_profile_consented_at)
  then
    delete from public.prepare_ml_verified_profiles where user_id = new.user_id;
  end if;
  return new;
end;
$$;

revoke all on function public.invalidate_prepare_ml_verification_on_survey_change()
  from public, anon, authenticated;

-- Revoke ONLY rows produced by the non-official observed-decade mapping.
-- Explicitly approved rows with other codebook versions are not touched.
delete from public.prepare_ml_verified_profiles
where codebook_version = '2024-age-decade-observed-v1';

comment on table public.prepare_ml_verified_profiles is
  'Protected, service-only model codes. Self-reported age and consent NEVER create verified codes automatically; approval requires a separate trusted codebook workflow.';
comment on column public.prepare_ml_verified_profiles.codebook_version is
  'Version of officially approved survey-to-application mapping, checked against PREPARE_ML_CODEBOOK_VERSION.';
comment on column public.profiles.ml_profile_consented_at is
  'Optional ML research-data consent timestamp. Database stamps newly submitted consent with statement_timestamp(); clearing it revokes consent.';
comment on function public.invalidate_prepare_ml_verification_on_survey_change() is
  'On any user survey change or consent revocation, delete stale service-only model verification. Does NOT auto-approve user-supplied age.';
comment on function public.stamp_prepare_ml_consent_at() is
  'Before profile consent updates, replace a newly submitted non-null client timestamp with the database server time.';
