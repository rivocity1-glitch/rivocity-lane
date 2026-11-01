-- Restore the legacy Picker ID -> Auth email lookup used by the original
-- PC-#### + four-digit PIN login screen.
--
-- SECURITY NOTE: This intentionally exposes the email associated with a valid
-- Picker ID to unauthenticated callers so the legacy client-side login can work.
-- The project owner explicitly accepted this trade-off. Revisit with a backend
-- authentication flow before public launch.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_picker_login_email(p_picker_login_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(p.email, u.email)
  FROM public.picker_profiles AS p
  LEFT JOIN auth.users AS u
    ON u.id = p.auth_user_id
  WHERE p.picker_login_id = upper(btrim(p_picker_login_id))
    AND p.picker_login_id ~ '^PC-[0-9]{4}$'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_picker_login_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_picker_login_email(text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_picker_login_email(text) IS
  'Legacy Picker ID login compatibility. Returns the Auth email for a valid Picker ID; publicly executable by design and exposes that email.';

COMMIT;
