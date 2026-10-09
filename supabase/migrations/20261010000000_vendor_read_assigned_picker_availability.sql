-- Allow a vendor to read availability for Picker accounts already assigned to that vendor.
-- This makes Offline status visible while keeping other vendors' Picker details private.

DROP POLICY IF EXISTS "Vendors can view assigned Picker availability" ON public.picker_profiles;

CREATE POLICY "Vendors can view assigned Picker availability"
ON public.picker_profiles
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.vendor_workers w
    JOIN public.vendors v ON v.id = w.vendor_id
    WHERE w.auth_user_id = picker_profiles.auth_user_id
      AND w.status = 'active'
      AND v.auth_user_id = (SELECT auth.uid())
  )
);

-- Enable realtime delivery for Picker availability changes without disturbing
-- the existing order_item_picking_tasks publication configuration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1
       FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'picker_profiles'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.picker_profiles;
  END IF;
END;
$$;
