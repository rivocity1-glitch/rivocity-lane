-- RivoCity Picker registration, secure Picker-ID sign-in and profile protections.
-- Apply after 20261019000000_sequential_picker_ids.sql.

BEGIN;

ALTER TABLE public.picker_profiles
  ADD COLUMN IF NOT EXISTS picker_login_id text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS registration_source text NOT NULL DEFAULT 'pwa',
  ADD COLUMN IF NOT EXISTS created_by_vendor_id uuid REFERENCES public.vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS documents_submitted jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS picker_profiles_picker_login_id_uidx
  ON public.picker_profiles (picker_login_id)
  WHERE picker_login_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS picker_profiles_email_idx
  ON public.picker_profiles (lower(email))
  WHERE email IS NOT NULL;

-- Start after the largest existing PC-#### ID, preserving all existing IDs.
DO $$
DECLARE
  v_max_id bigint;
BEGIN
  SELECT max(substring(picker_login_id FROM '^PC-([0-9]{4})$')::bigint)
    INTO v_max_id
  FROM public.picker_profiles
  WHERE picker_login_id ~ '^PC-[0-9]{4}$';

  IF v_max_id IS NULL THEN
    PERFORM setval('public.picker_login_id_seq', 999, false);
  ELSE
    IF v_max_id >= 9999 THEN
      RAISE EXCEPTION 'Picker ID range is exhausted (PC-9999 already exists)';
    END IF;
    PERFORM setval('public.picker_login_id_seq', greatest(v_max_id, 999), true);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_picker_login_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_picker_id text;
  v_sequence_value bigint;
BEGIN
  IF NEW.raw_user_meta_data ->> 'picker_role' IS DISTINCT FROM 'picker' THEN
    RETURN NEW;
  END IF;

  LOOP
    v_sequence_value := nextval('public.picker_login_id_seq');
    IF v_sequence_value > 9999 THEN
      RAISE EXCEPTION 'Picker ID sequence exhausted the four-digit range';
    END IF;

    v_picker_id := 'PC-' || lpad(v_sequence_value::text, 4, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.picker_profiles p
      WHERE p.picker_login_id = v_picker_id
    );
  END LOOP;

  NEW.raw_user_meta_data :=
    coalesce(NEW.raw_user_meta_data, '{}'::jsonb)
    || jsonb_build_object('picker_login_id', v_picker_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_picker_auth_user_created ON auth.users;
CREATE TRIGGER before_picker_auth_user_created
  BEFORE INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_picker_login_id();

CREATE OR REPLACE FUNCTION public.create_picker_profile_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_source text;
  v_vendor_id uuid;
BEGIN
  v_role := NEW.raw_user_meta_data ->> 'picker_role';
  IF v_role IS DISTINCT FROM 'picker' THEN
    RETURN NEW;
  END IF;

  v_source := coalesce(NEW.raw_user_meta_data ->> 'registration_source', 'pwa');
  IF v_source = 'vendor' THEN
    v_vendor_id := nullif(NEW.raw_user_meta_data ->> 'created_by_vendor_id', '')::uuid;
  END IF;

  INSERT INTO public.picker_profiles (
    auth_user_id, picker_login_id, email, full_name, phone, city, locality,
    pincode, address, latitude, longitude, availability_status,
    application_status, registration_source, created_by_vendor_id
  )
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data ->> 'picker_login_id',
    NEW.email,
    coalesce(NEW.raw_user_meta_data ->> 'full_name', 'Picker'),
    coalesce(NEW.raw_user_meta_data ->> 'phone', ''),
    coalesce(NEW.raw_user_meta_data ->> 'city', ''),
    nullif(NEW.raw_user_meta_data ->> 'locality', ''),
    nullif(NEW.raw_user_meta_data ->> 'pincode', ''),
    nullif(NEW.raw_user_meta_data ->> 'address', ''),
    nullif(NEW.raw_user_meta_data ->> 'latitude', '')::double precision,
    nullif(NEW.raw_user_meta_data ->> 'longitude', '')::double precision,
    'offline',
    'pending',
    v_source,
    v_vendor_id
  )
  ON CONFLICT (auth_user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_picker_auth_user_created ON auth.users;
CREATE TRIGGER on_picker_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.create_picker_profile_from_auth();

-- Retire the old unauthenticated email-lookup RPC if one was created manually.
DROP FUNCTION IF EXISTS public.get_picker_login_email(text);

-- Auth-triggered profile creation is the only allowed Picker profile insert path.
-- The old self-insert policy let clients forge approval/vendor/Picker-ID fields.
DROP POLICY IF EXISTS "Picker can create own profile" ON public.picker_profiles;

-- Vendor-created Picker visibility, approval and worker-link policies.
DROP POLICY IF EXISTS "Vendors can view their created pickers" ON public.picker_profiles;
CREATE POLICY "Vendors can view their created pickers"
ON public.picker_profiles
FOR SELECT TO authenticated
USING (
  created_by_vendor_id = (
    SELECT v.id FROM public.vendors v
    WHERE v.auth_user_id = (SELECT auth.uid())
    LIMIT 1
  )
);

DROP POLICY IF EXISTS "Vendors can approve their created pickers" ON public.picker_profiles;
CREATE POLICY "Vendors can approve their created pickers"
ON public.picker_profiles
FOR UPDATE TO authenticated
USING (
  created_by_vendor_id = (
    SELECT v.id FROM public.vendors v
    WHERE v.auth_user_id = (SELECT auth.uid())
    LIMIT 1
  )
)
WITH CHECK (
  created_by_vendor_id = (
    SELECT v.id FROM public.vendors v
    WHERE v.auth_user_id = (SELECT auth.uid())
    LIMIT 1
  )
);

DROP POLICY IF EXISTS "Vendors can create their picker workers" ON public.vendor_workers;
CREATE POLICY "Vendors can create their picker workers"
ON public.vendor_workers
FOR INSERT TO authenticated
WITH CHECK (
  vendor_id = (
    SELECT v.id FROM public.vendors v
    WHERE v.auth_user_id = (SELECT auth.uid())
    LIMIT 1
  )
  AND EXISTS (
    SELECT 1
    FROM public.picker_profiles p
    WHERE p.auth_user_id = vendor_workers.auth_user_id
      AND p.application_status = 'approved'
      AND (
        p.created_by_vendor_id IS NULL
        OR p.created_by_vendor_id = vendor_workers.vendor_id
      )
  )
);

-- Rate-limit failed Picker-ID sign-in attempts using a hash of IP + Picker ID.
CREATE TABLE IF NOT EXISTS public.picker_login_rate_limits (
  key_hash text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0,
  blocked_until timestamptz
);

ALTER TABLE public.picker_login_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.picker_login_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.picker_login_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.consume_picker_login_attempt(
  p_key_hash text,
  p_failed boolean DEFAULT false,
  p_success boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_blocked_until timestamptz;
  v_attempts integer;
BEGIN
  IF (SELECT auth.role()) <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF p_key_hash IS NULL OR p_key_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid rate-limit key';
  END IF;

  IF p_success THEN
    DELETE FROM public.picker_login_rate_limits WHERE key_hash = p_key_hash;
    RETURN true;
  END IF;

  IF NOT p_failed THEN
    SELECT r.blocked_until INTO v_blocked_until
    FROM public.picker_login_rate_limits r
    WHERE r.key_hash = p_key_hash;
    RETURN v_blocked_until IS NULL OR v_blocked_until <= now();
  END IF;

  INSERT INTO public.picker_login_rate_limits(key_hash, window_started_at, failed_attempts, blocked_until)
  VALUES (p_key_hash, now(), 1, NULL)
  ON CONFLICT (key_hash) DO UPDATE
  SET
    failed_attempts = CASE
      WHEN public.picker_login_rate_limits.window_started_at < now() - interval '15 minutes' THEN 1
      ELSE public.picker_login_rate_limits.failed_attempts + 1
    END,
    window_started_at = CASE
      WHEN public.picker_login_rate_limits.window_started_at < now() - interval '15 minutes' THEN now()
      ELSE public.picker_login_rate_limits.window_started_at
    END,
    blocked_until = CASE
      WHEN public.picker_login_rate_limits.window_started_at < now() - interval '15 minutes' THEN NULL
      WHEN public.picker_login_rate_limits.blocked_until > now() THEN public.picker_login_rate_limits.blocked_until
      WHEN public.picker_login_rate_limits.failed_attempts + 1 >= 5 THEN now() + interval '15 minutes'
      ELSE NULL
    END
  RETURNING failed_attempts, blocked_until INTO v_attempts, v_blocked_until;

  RETURN v_blocked_until IS NULL OR v_blocked_until <= now();
END;
$$;

REVOKE ALL ON FUNCTION public.consume_picker_login_attempt(text, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_picker_login_attempt(text, boolean, boolean) TO service_role;

-- Prevent a Picker from self-approving or changing the Auth/vendor identity.
CREATE OR REPLACE FUNCTION public.guard_picker_profile_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_vendor_id uuid;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.admin_users a
    WHERE a.auth_user_id = (SELECT auth.uid())
  ) THEN
    RETURN NEW;
  END IF;

  IF (SELECT auth.uid()) = OLD.auth_user_id THEN
    IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
       OR NEW.picker_login_id IS DISTINCT FROM OLD.picker_login_id
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.application_status IS DISTINCT FROM OLD.application_status
       OR NEW.registration_source IS DISTINCT FROM OLD.registration_source
       OR NEW.created_by_vendor_id IS DISTINCT FROM OLD.created_by_vendor_id
       OR NEW.id IS DISTINCT FROM OLD.id
    THEN
      RAISE EXCEPTION 'Picker identity and approval fields cannot be changed by the Picker';
    END IF;
    RETURN NEW;
  END IF;

  SELECT v.id INTO v_user_vendor_id
  FROM public.vendors v
  WHERE v.auth_user_id = (SELECT auth.uid())
  LIMIT 1;

  IF v_user_vendor_id IS NOT NULL
     AND OLD.created_by_vendor_id = v_user_vendor_id
  THEN
    IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
       OR NEW.picker_login_id IS DISTINCT FROM OLD.picker_login_id
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.registration_source IS DISTINCT FROM OLD.registration_source
       OR NEW.created_by_vendor_id IS DISTINCT FROM OLD.created_by_vendor_id
       OR NEW.id IS DISTINCT FROM OLD.id
    THEN
      RAISE EXCEPTION 'Vendor cannot change a Picker identity or vendor ownership';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_picker_profile_updates ON public.picker_profiles;
CREATE TRIGGER trg_guard_picker_profile_updates
  BEFORE UPDATE ON public.picker_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_picker_profile_updates();

COMMIT;
