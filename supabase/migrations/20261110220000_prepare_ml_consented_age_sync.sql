-- Age-only C1/W4: map consented, self-reported age into a protected
-- server-owned profile. This is a *provisional* observed-decade mapping,
-- NOT a certification of the 2024 Time Use Survey's official codebook.
-- Model inference remains restricted by PREPARE_ML_ENABLED, an exact UUID
-- allowlist, and an expected codebook version.
-- Existing survey-change trigger is kept: replace its function atomically.
create or replace function public.invalidate_prepare_ml_verification_on_survey_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_age_code text;
begin
  if (old.ml_age_years, old.ml_school_status, old.ml_work_status, old.ml_profile_consented_at)
     is not distinct from
     (new.ml_age_years, new.ml_school_status, new.ml_work_status, new.ml_profile_consented_at)
  then
    return new;
  end if;

  -- Always revoke the old mapping first; this also handles consent withdrawal.
  delete from public.prepare_ml_verified_profiles where user_id = new.user_id;

  -- Do not auto-approve legacy school/work survey rows. Only the new
  -- age-only save (which clears these legacy fields) can create a code.
  if new.ml_age_years is null or new.ml_profile_consented_at is null
     or new.ml_school_status is not null or new.ml_work_status is not null
     or new.ml_profile_consented_at > now()
  then
    return new;
  end if;

  -- 10s->1, 20s->2, ... 70s->7, 80+->8; app limits ages to 14..100.
  v_age_code := least(8, new.ml_age_years::integer / 10)::text;
  insert into public.prepare_ml_verified_profiles
    (user_id, ml_age_code, codebook_version, consent_at, verified_at)
  values
    (new.user_id, v_age_code, '2024-age-decade-observed-v1',
     new.ml_profile_consented_at, now());

  return new;
end;
$$;

-- Preserve the prior revoked execute privileges, independent of function replacement.
revoke all on function public.invalidate_prepare_ml_verification_on_survey_change()
  from public, anon, authenticated;

comment on function public.invalidate_prepare_ml_verification_on_survey_change() is
  'On consented age updates: delete stale server ML code, map age into provisional age decade code. '
  'On withdrawal or deletion: delete mapping. No direct authenticated access to ML table.';

-- Existing profiles are intentionally NOT backfilled to avoid activating
-- previously collected survey responses without an explicit new save/consent.
