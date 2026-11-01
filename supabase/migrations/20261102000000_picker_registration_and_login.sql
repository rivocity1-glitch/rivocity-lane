-- RivoCity Picker registration and secure Picker-ID sign-in
-- Apply after 20261019000000_sequential_picker_ids.sql.
-- This migration makes the auth/profile trigger setup reproducible from migrations.

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
    PERFORM setval('public.picker_login_id_seq', v_max_id, true);
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
    auth_user_id,
    picker_login_id,
    email,
    full_name,
    phone,
    city,
    locality,
    pincode,
    address,
    latitude,
    longitude,
    availability_status,
    application_status,
    registration_source,
    created_by_vendor_id
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

-- Retire the old unauthenticated email-lookup RPC if it was created manually.
-- Picker ID sign-in now resolves credentials inside the Edge Function.
DROP FUNCTION IF EXISTS public.get_picker_login_email(text);

COMMIT;
