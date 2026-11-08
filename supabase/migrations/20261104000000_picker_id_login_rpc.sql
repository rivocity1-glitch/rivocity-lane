-- Direct Picker ID login compatibility without an Edge Function.
-- This RPC resolves a Picker ID to the Auth email; the browser then uses
-- Supabase Auth signInWithPassword. This exposes the email for a valid Picker ID.
-- Restrict/replace this RPC with a secure server-side flow before broad public rollout.

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
  LEFT JOIN auth.users AS u ON u.id = p.auth_user_id
  WHERE p.picker_login_id = upper(btrim(p_picker_login_id))
    AND p.picker_login_id ~ '^PC-[0-9]{4}$'
    AND p.application_status = 'approved'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_picker_login_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_picker_login_email(text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_picker_login_email(text) IS
  'Picker ID login compatibility. Returns the Auth email for an approved Picker ID so the client can use Supabase Auth password sign-in.';

COMMIT;
