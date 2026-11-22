-- #577/#585 pilot: only demo-me routes alarm operations to the Edge implementation.
-- The main server_routes switch remains unchanged for all other users.
-- This migration records the matching live RPC hotfix and is safe to replay:
-- CREATE OR REPLACE FUNCTION preserves its existing EXECUTE grants.
-- Rollback: restore get_server_routes() from 20261114100000_server_switch.sql.
CREATE OR REPLACE FUNCTION public.get_server_routes()
RETURNS TABLE(name text, mode text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
  SELECT r.name,
    CASE
      WHEN (SELECT auth.uid()) = 'f60d371e-63a5-4fb9-9d92-0743392325ec'::uuid
        AND r.name IN ('alarm-suggest', 'alarm-commit', 'appointment-edit', 'alarm-roll')
        THEN 'edge'
      WHEN r.mode = 'server' THEN 'server'
      WHEN r.mode = 'canary' AND EXISTS (
        SELECT 1 FROM public.server_route_users u
        WHERE u.kind = r.kind AND u.name = r.name
          AND u.user_id = (SELECT auth.uid())
      ) THEN 'server'
      ELSE 'edge'
    END
  FROM public.server_routes r
  WHERE r.kind = 'function'
  ORDER BY r.name;
$fn$;
