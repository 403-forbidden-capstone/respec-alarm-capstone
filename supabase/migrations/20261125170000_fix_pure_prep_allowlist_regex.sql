-- Follow-up correction before the new pure-prep allowlist is enabled.
-- The preceding migration used an over-escaped POSIX regular expression,
-- which would reject nonempty UUID allowlists. Preserve all seven keys.
alter table public.server_settings
  drop constraint server_settings_value_by_key;

alter table public.server_settings
  add constraint server_settings_value_by_key check (
    case key
      when 'prepare_ml_enabled' then value in ('0', '1')
      when 'prepare_ml_allowed_user_ids' then
        value = '' or value ~* '^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\s*,\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*\s*$'
      when 'prepare_ml_codebook_version' then
        value !~ '^\s|\s$' and char_length(value) <= 80
      when 'pure_prep_apply_enabled' then value in ('0', '1')
      when 'pure_prep_survey_enabled' then value in ('0', '1')
      when 'pure_prep_allowed_user_ids' then
        value = '' or value ~* '^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\s*,\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*\s*$'
      when 'pure_prep_survey_allowed_user_ids' then
        value = '' or value ~* '^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\s*,\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*\s*$'
      else false
    end
  );
