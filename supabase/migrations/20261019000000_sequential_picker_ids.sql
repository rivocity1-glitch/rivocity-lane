-- Generate sequential PC-1000, PC-1001, ... IDs for new Picker registrations.
-- Existing picker_login_id values are deliberately preserved.
BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.picker_login_id_seq START WITH 1000;

CREATE UNIQUE INDEX IF NOT EXISTS picker_profiles_picker_login_id_uidx
  ON public.picker_profiles (picker_login_id)
  WHERE picker_login_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.assign_picker_login_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_picker_id text;
  v_sequence_value bigint;
BEGIN
  v_role := NEW.raw_user_meta_data ->> 'picker_role';

  IF v_role IS DISTINCT FROM 'picker' THEN
    RETURN NEW;
  END IF;

  LOOP
    v_sequence_value := nextval('public.picker_login_id_seq');

    IF v_sequence_value > 9999 THEN
      RAISE EXCEPTION 'Picker ID sequence exhausted the four-digit range';
    END IF;

    v_picker_id := 'PC-' || lpad(v_sequence_value::text, 4, '0');

    EXIT WHEN NOT EXISTS (
      SELECT 1
      FROM public.picker_profiles
      WHERE picker_login_id = v_picker_id
    );
  END LOOP;

  NEW.raw_user_meta_data :=
    coalesce(NEW.raw_user_meta_data, '{}'::jsonb)
    || jsonb_build_object('picker_login_id', v_picker_id);

  RETURN NEW;
END;
$$;

COMMIT;
