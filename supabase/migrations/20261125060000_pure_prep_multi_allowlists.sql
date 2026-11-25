-- Add separate, fail-closed multi-user allowlists for pure-preparation
-- scheduling and the optional survey-v2 pilot. Existing legacy C1/W4 keys
-- and values remain unchanged. No account is enabled by this migration.
alter table public.server_settings
  drop constraint server_settings_known_key;
alter table public.server_settings
  add constraint server_settings_known_key check (
    key in (
      'prepare_ml_enabled',
      'prepare_ml_allowed_user_ids',
      'prepare_ml_codebook_version',
      'pure_prep_apply_enabled',
      'pure_prep_allowed_user_ids',
      'pure_prep_survey_enabled',
      'pure_prep_survey_allowed_user_ids'
    )
  );
alter table public.server_settings
  drop constraint server_settings_value_by_key;
alter table public.server_settings
  add constraint server_settings_value_by_key check (
    case key
      when 'prepare_ml_enabled' then value in ('0','1')
      when 'prepare_ml_allowed_user_ids' then
        value = '' or value ~* '^\\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\\s*,\\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*\\s*$'
      when 'prepare_ml_codebook_version' then
        value !~ '^\\s|\\s$' and char_length(value) <= 80
      when 'pure_prep_apply_enabled' then value in ('0','1')
      when 'pure_prep_survey_enabled' then value in ('0','1')
      when 'pure_prep_allowed_user_ids' then
        value = '' or value ~* '^\\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\\s*,\\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*\\s*$'
      when 'pure_prep_survey_allowed_user_ids' then
        value = '' or value ~* '^\\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\\s*,\\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*\\s*$'
      else false
    end
  );

insert into public.server_settings(key,value) values
  ('pure_prep_apply_enabled','0'),
  ('pure_prep_allowed_user_ids',''),
  ('pure_prep_survey_enabled','0'),
  ('pure_prep_survey_allowed_user_ids','')
on conflict (key) do nothing;
