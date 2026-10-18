-- Picker claim reconciliation, secure task completion and vendor-owned Picker locking.
-- Apply once in the shared Supabase SQL Editor, or deploy through Supabase migrations.

BEGIN;

-- These columns are read/written by both the Picker PWA and Vendor Portal.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS picker_worker_id uuid
    REFERENCES public.vendor_workers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS picker_claimed_at timestamptz;

ALTER TABLE public.order_item_picking_tasks
  ALTER COLUMN worker_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS order_item_picking_tasks_order_item_idx
  ON public.order_item_picking_tasks(order_item_id);

CREATE INDEX IF NOT EXISTS order_item_picking_tasks_vendor_status_idx
  ON public.order_item_picking_tasks(vendor_id, status, assigned_at);

-- Shared pool: one task per order item, not pre-assigned to the first active
-- vendor_workers row (which can be the store owner rather than the Picker).
CREATE OR REPLACE FUNCTION public.auto_assign_picker_tasks_for_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order record;
  v_item record;
BEGIN
  SELECT o.id, o.vendor_id, o.order_status
    INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF v_order.id IS NULL OR v_order.order_status NOT IN ('accepted', 'preparing') THEN
    RETURN;
  END IF;

  FOR v_item IN
    SELECT oi.id, oi.quantity
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
  LOOP
    INSERT INTO public.order_item_picking_tasks (
      order_item_id, vendor_id, worker_id, quantity, status, assigned_at, updated_at
    )
    VALUES (
      v_item.id, v_order.vendor_id, NULL, v_item.quantity, 'assigned', now(), now()
    )
    ON CONFLICT (order_item_id)
    DO UPDATE SET
      quantity = EXCLUDED.quantity,
      updated_at = now()
    WHERE public.order_item_picking_tasks.status <> 'picked';
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_auto_assign_picker_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.order_status IN ('accepted', 'preparing')
     AND (TG_OP = 'INSERT' OR NEW.order_status IS DISTINCT FROM OLD.order_status)
  THEN
    PERFORM public.auto_assign_picker_tasks_for_order(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_assign_picker_order ON public.orders;
CREATE TRIGGER trg_auto_assign_picker_order
AFTER INSERT OR UPDATE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.trigger_auto_assign_picker_order();

CREATE OR REPLACE FUNCTION public.trigger_auto_assign_picker_order_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT o.order_status INTO v_status
  FROM public.orders o
  WHERE o.id = NEW.order_id;

  IF v_status IN ('accepted', 'preparing') THEN
    PERFORM public.auto_assign_picker_tasks_for_order(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_assign_picker_order_item ON public.order_items;
CREATE TRIGGER trg_auto_assign_picker_order_item
AFTER INSERT OR UPDATE OF product_id, quantity ON public.order_items
FOR EACH ROW
EXECUTE FUNCTION public.trigger_auto_assign_picker_order_item();

-- Keep vendor-created Pickers tied permanently to the vendor that created them.
CREATE OR REPLACE FUNCTION public.guard_vendor_created_picker_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_registration_source text;
  v_created_by_vendor_id uuid;
BEGIN
  SELECT p.registration_source, p.created_by_vendor_id
    INTO v_registration_source, v_created_by_vendor_id
  FROM public.picker_profiles p
  WHERE p.auth_user_id = NEW.auth_user_id;

  IF FOUND
     AND v_registration_source = 'vendor'
     AND v_created_by_vendor_id IS NOT NULL
     AND NEW.vendor_id IS DISTINCT FROM v_created_by_vendor_id
  THEN
    RAISE EXCEPTION 'This Picker was created by another vendor and cannot be reassigned';
  END IF;

  IF NEW.status = 'active' AND EXISTS (
    SELECT 1
    FROM public.vendor_workers w
    WHERE w.auth_user_id = NEW.auth_user_id
      AND w.vendor_id <> NEW.vendor_id
      AND w.status = 'active'
      AND w.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'Picker is already assigned to another vendor';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_vendor_created_picker_link ON public.vendor_workers;
CREATE TRIGGER trg_guard_vendor_created_picker_link
BEFORE INSERT OR UPDATE OF vendor_id, auth_user_id, status
ON public.vendor_workers
FOR EACH ROW
EXECUTE FUNCTION public.guard_vendor_created_picker_link();

-- Vendor-side Picker creation calls this after the Auth trigger creates and
-- approves picker_profiles. It only links a Picker created by this vendor.
CREATE OR REPLACE FUNCTION public.vendor_link_created_picker(p_picker_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_vendor_id uuid;
  v_picker record;
  v_worker_id uuid;
  v_existing_vendor_id uuid;
BEGIN
  SELECT v.id INTO v_vendor_id
  FROM public.vendors v
  WHERE v.auth_user_id = (SELECT auth.uid())
  LIMIT 1;

  IF v_vendor_id IS NULL THEN
    RAISE EXCEPTION 'Vendor session not found';
  END IF;

  SELECT p.id, p.auth_user_id, p.full_name, p.application_status,
         p.registration_source, p.created_by_vendor_id
    INTO v_picker
  FROM public.picker_profiles p
  WHERE p.id = p_picker_id
  FOR UPDATE;

  IF v_picker.id IS NULL THEN
    RAISE EXCEPTION 'Picker profile not found';
  END IF;
  IF v_picker.registration_source <> 'vendor'
     OR v_picker.created_by_vendor_id IS DISTINCT FROM v_vendor_id
  THEN
    RAISE EXCEPTION 'This Picker was not created by your vendor account';
  END IF;
  IF v_picker.application_status <> 'approved' THEN
    RAISE EXCEPTION 'Picker must be approved before being linked';
  END IF;

  SELECT w.id, w.vendor_id INTO v_worker_id, v_existing_vendor_id
  FROM public.vendor_workers w
  WHERE w.auth_user_id = v_picker.auth_user_id
  FOR UPDATE;

  IF v_worker_id IS NOT NULL THEN
    IF v_existing_vendor_id IS DISTINCT FROM v_vendor_id THEN
      RAISE EXCEPTION 'Picker is already linked to a different vendor';
    END IF;
    UPDATE public.vendor_workers
    SET vendor_id = v_vendor_id, worker_name = v_picker.full_name,
        status = 'active', updated_at = now()
    WHERE id = v_worker_id;
  ELSE
    INSERT INTO public.vendor_workers(vendor_id, auth_user_id, worker_name, status)
    VALUES (v_vendor_id, v_picker.auth_user_id, v_picker.full_name, 'active')
    RETURNING id INTO v_worker_id;
  END IF;

  RETURN v_worker_id;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_link_created_picker(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_link_created_picker(uuid) TO authenticated;

-- Self-heal the vendor-created link at Picker sign-in, but never move it.
CREATE OR REPLACE FUNCTION public.ensure_picker_vendor_link()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_picker record;
  v_worker record;
BEGIN
  SELECT p.id, p.auth_user_id, p.full_name, p.application_status,
         p.registration_source, p.created_by_vendor_id
    INTO v_picker
  FROM public.picker_profiles p
  WHERE p.auth_user_id = (SELECT auth.uid())
  FOR UPDATE;

  IF v_picker.id IS NULL THEN
    RAISE EXCEPTION 'Picker profile not found';
  END IF;
  IF v_picker.registration_source <> 'vendor'
     OR v_picker.created_by_vendor_id IS NULL
  THEN
    RAISE EXCEPTION 'This Picker uses the independent registration flow';
  END IF;
  IF v_picker.application_status <> 'approved' THEN
    RAISE EXCEPTION 'Picker application is not approved';
  END IF;

  SELECT w.id, w.vendor_id, w.status
    INTO v_worker
  FROM public.vendor_workers w
  WHERE w.auth_user_id = v_picker.auth_user_id
  FOR UPDATE;

  IF v_worker.id IS NOT NULL THEN
    IF v_worker.vendor_id IS DISTINCT FROM v_picker.created_by_vendor_id THEN
      RAISE EXCEPTION 'Vendor-created Picker link does not match its original vendor';
    END IF;
    UPDATE public.vendor_workers
    SET worker_name = v_picker.full_name, status = 'active', updated_at = now()
    WHERE id = v_worker.id;
  ELSE
    INSERT INTO public.vendor_workers(vendor_id, auth_user_id, worker_name, status)
    VALUES (v_picker.created_by_vendor_id, v_picker.auth_user_id, v_picker.full_name, 'active')
    RETURNING id, vendor_id, status INTO v_worker;
  END IF;

  RETURN jsonb_build_object('worker_id', v_worker.id, 'vendor_id', v_worker.vendor_id);
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_picker_vendor_link() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_picker_vendor_link() TO authenticated;

-- One atomic claim path shared by the Picker PWA and Vendor Portal self-pick.
-- A different active Picker keeps the order once any item has been picked.
-- The owner can explicitly self-pick an untouched order; a stale owner claim
-- may be transferred back into the Picker pool.
CREATE OR REPLACE FUNCTION public.claim_picker_order(p_order_id uuid, p_worker_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_worker record;
  v_order record;
  v_current_worker record;
  v_vendor_owner_auth_id uuid;
  v_has_picked boolean := false;
  v_is_vendor_owner boolean := false;
BEGIN
  SELECT w.id, w.vendor_id, w.auth_user_id, w.status
    INTO v_worker
  FROM public.vendor_workers w
  WHERE w.id = p_worker_id
    AND w.auth_user_id = (SELECT auth.uid())
    AND w.status = 'active'
  FOR UPDATE;

  IF v_worker.id IS NULL THEN
    RAISE EXCEPTION 'Active Picker worker record not found for this session';
  END IF;

  SELECT o.id, o.vendor_id, o.order_status, o.picker_worker_id, o.picker_claimed_at
    INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.vendor_id <> v_worker.vendor_id THEN
    RAISE EXCEPTION 'This order belongs to another vendor';
  END IF;
  IF v_order.order_status NOT IN ('accepted', 'preparing') THEN
    RETURN false;
  END IF;

  SELECT v.auth_user_id INTO v_vendor_owner_auth_id
  FROM public.vendors v
  WHERE v.id = v_order.vendor_id;

  v_is_vendor_owner := v_worker.auth_user_id = v_vendor_owner_auth_id;

  -- Ensure legacy accepted/preparing orders have one task per line item.
  PERFORM public.auto_assign_picker_tasks_for_order(p_order_id);

  IF EXISTS (
    SELECT 1
    FROM public.picker_profiles p
    WHERE p.auth_user_id = v_worker.auth_user_id
      AND p.registration_source = 'vendor'
      AND p.created_by_vendor_id IS DISTINCT FROM v_order.vendor_id
  ) THEN
    RAISE EXCEPTION 'Vendor-created Picker cannot claim another vendor''s order';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.order_item_picking_tasks t
    JOIN public.order_items oi ON oi.id = t.order_item_id
    WHERE oi.order_id = p_order_id
      AND t.vendor_id = v_order.vendor_id
      AND t.status = 'picked'
  ) INTO v_has_picked;

  IF v_order.picker_worker_id IS NOT NULL
     AND v_order.picker_worker_id <> v_worker.id
  THEN
    SELECT w.id, w.auth_user_id, w.status
      INTO v_current_worker
    FROM public.vendor_workers w
    WHERE w.id = v_order.picker_worker_id;

    IF v_has_picked THEN
      RETURN false;
    END IF;

    -- Do not steal an untouched order from another active Picker unless the
    -- vendor owner intentionally chose Self-pick.
    IF NOT v_is_vendor_owner
       AND v_current_worker.id IS NOT NULL
       AND v_current_worker.status = 'active'
       AND v_current_worker.auth_user_id IS DISTINCT FROM v_vendor_owner_auth_id
    THEN
      RETURN false;
    END IF;
  END IF;

  -- Reconcile task-level legacy assignment too. Another active Picker's
  -- unfinished assignment cannot be stolen by a Picker; owner self-pick can.
  IF NOT v_is_vendor_owner AND EXISTS (
    SELECT 1
    FROM public.order_item_picking_tasks t
    JOIN public.order_items oi ON oi.id = t.order_item_id
    JOIN public.vendor_workers w ON w.id = t.worker_id
    WHERE oi.order_id = p_order_id
      AND t.vendor_id = v_order.vendor_id
      AND t.status = 'assigned'
      AND t.worker_id IS NOT NULL
      AND t.worker_id <> v_worker.id
      AND w.status = 'active'
      AND w.auth_user_id IS DISTINCT FROM v_vendor_owner_auth_id
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.orders
  SET picker_worker_id = v_worker.id,
      picker_claimed_at = CASE
        WHEN picker_worker_id = v_worker.id THEN COALESCE(picker_claimed_at, now())
        ELSE now()
      END
  WHERE id = p_order_id
    AND vendor_id = v_order.vendor_id;

  UPDATE public.order_item_picking_tasks t
  SET worker_id = v_worker.id,
      assigned_at = COALESCE(t.assigned_at, now()),
      updated_at = now()
  FROM public.order_items oi
  WHERE oi.id = t.order_item_id
    AND oi.order_id = p_order_id
    AND t.vendor_id = v_order.vendor_id
    AND t.status = 'assigned';

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_picker_order(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_picker_order(uuid, uuid) TO authenticated;

-- Authenticated Picker/vendor-owner can complete tasks only in their own vendor.
CREATE OR REPLACE FUNCTION public.mark_picker_task_picked(p_task_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_worker record;
  v_task record;
  v_order record;
  v_claimed boolean;
BEGIN
  SELECT w.id, w.vendor_id, w.auth_user_id
    INTO v_worker
  FROM public.vendor_workers w
  WHERE w.auth_user_id = (SELECT auth.uid())
    AND w.status = 'active'
  LIMIT 1
  FOR UPDATE;

  IF v_worker.id IS NULL THEN
    RAISE EXCEPTION 'Active Picker worker record not found for this session';
  END IF;

  SELECT t.id, t.order_item_id, t.vendor_id, t.worker_id, t.status
    INTO v_task
  FROM public.order_item_picking_tasks t
  WHERE t.id = p_task_id
  FOR UPDATE;

  IF v_task.id IS NULL OR v_task.vendor_id <> v_worker.vendor_id THEN
    RAISE EXCEPTION 'Picking task not found for this vendor';
  END IF;
  IF v_task.status = 'picked' THEN
    RETURN true;
  END IF;
  IF v_task.status <> 'assigned' THEN
    RETURN false;
  END IF;

  SELECT o.id, o.vendor_id, o.order_status, o.picker_worker_id
    INTO v_order
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE oi.id = v_task.order_item_id
  FOR UPDATE OF o;

  IF v_order.id IS NULL
     OR v_order.order_status NOT IN ('accepted', 'preparing')
  THEN
    RETURN false;
  END IF;

  IF v_order.picker_worker_id IS DISTINCT FROM v_worker.id THEN
    v_claimed := public.claim_picker_order(v_order.id, v_worker.id);
    IF NOT v_claimed THEN
      RETURN false;
    END IF;
  END IF;

  UPDATE public.order_item_picking_tasks
  SET status = 'picked',
      worker_id = v_worker.id,
      picked_at = now(),
      updated_at = now()
  WHERE id = p_task_id
    AND vendor_id = v_worker.vendor_id
    AND status = 'assigned';

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_picker_task_picked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_picker_task_picked(uuid) TO authenticated;

-- Keep vendor-created Picker visibility private to their owning vendor, and
-- let active Pickers read only that vendor's orders/items/tasks.
DROP POLICY IF EXISTS "Picker can read vendor orders" ON public.orders;
CREATE POLICY "Picker can read vendor orders"
ON public.orders FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.vendor_workers w
    WHERE w.vendor_id = orders.vendor_id
      AND w.auth_user_id = (SELECT auth.uid())
      AND w.status = 'active'
  )
);

DROP POLICY IF EXISTS "Picker can read vendor order items" ON public.order_items;
CREATE POLICY "Picker can read vendor order items"
ON public.order_items FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.orders o
    JOIN public.vendor_workers w ON w.vendor_id = o.vendor_id
    WHERE o.id = order_items.order_id
      AND w.auth_user_id = (SELECT auth.uid())
      AND w.status = 'active'
  )
);

DROP POLICY IF EXISTS "Picker can read vendor picking tasks" ON public.order_item_picking_tasks;
CREATE POLICY "Picker can read vendor picking tasks"
ON public.order_item_picking_tasks FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.vendor_workers w
    WHERE w.vendor_id = order_item_picking_tasks.vendor_id
      AND w.auth_user_id = (SELECT auth.uid())
      AND w.status = 'active'
  )
  OR EXISTS (
    SELECT 1 FROM public.vendors v
    WHERE v.id = order_item_picking_tasks.vendor_id
      AND v.auth_user_id = (SELECT auth.uid())
  )
);

-- Repair historical self-claims: if the vendor owner was stored as Picker,
-- but no line has actually been picked, release the order and its unfinished
-- tasks back to the pool. Genuine active Picker claims are left intact.
UPDATE public.orders o
SET picker_worker_id = NULL,
    picker_claimed_at = NULL
WHERE o.picker_worker_id IS NOT NULL
  AND o.order_status IN ('accepted', 'preparing')
  AND EXISTS (
    SELECT 1 FROM public.vendor_workers owner_worker
    JOIN public.vendors v ON v.id = o.vendor_id
      AND owner_worker.auth_user_id = v.auth_user_id
    WHERE owner_worker.id = o.picker_worker_id
      AND owner_worker.vendor_id = o.vendor_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.order_item_picking_tasks t ON t.order_item_id = oi.id
    WHERE oi.order_id = o.id
      AND t.vendor_id = o.vendor_id
      AND t.status = 'picked'
  );

UPDATE public.order_item_picking_tasks t
SET worker_id = NULL,
    updated_at = now()
FROM public.order_items oi
JOIN public.orders o ON o.id = oi.order_id
JOIN public.vendor_workers owner_worker
  ON owner_worker.vendor_id = o.vendor_id
JOIN public.vendors v
  ON v.id = o.vendor_id
 AND v.auth_user_id = owner_worker.auth_user_id
WHERE oi.id = t.order_item_id
  AND t.vendor_id = o.vendor_id
  AND t.worker_id = owner_worker.id
  AND t.status = 'assigned'
  AND o.picker_worker_id IS NULL
  AND o.order_status IN ('accepted', 'preparing');

-- Backfill any accepted/preparing orders created before the trigger existed.
DO $$
DECLARE
  v_order_id uuid;
BEGIN
  FOR v_order_id IN
    SELECT o.id
    FROM public.orders o
    WHERE o.order_status IN ('accepted', 'preparing')
  LOOP
    PERFORM public.auto_assign_picker_tasks_for_order(v_order_id);
  END LOOP;
END;
$$;


-- Admin assignment uses one server-side transaction so concurrent admin/vendor
-- actions cannot silently attach one Picker to multiple stores.
CREATE OR REPLACE FUNCTION public.admin_assign_picker_helper(
  p_vendor_id uuid,
  p_picker_id uuid,
  p_ticket_id uuid DEFAULT NULL,
  p_lane_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $
DECLARE
  v_picker record;
  v_worker record;
  v_request_id uuid;
  v_owner_auth_user_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users a
    WHERE a.auth_user_id = (SELECT auth.uid())
  ) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT p.id, p.auth_user_id, p.full_name, p.application_status,
         p.registration_source, p.created_by_vendor_id
    INTO v_picker
  FROM public.picker_profiles p
  WHERE p.id = p_picker_id
  FOR UPDATE;

  IF v_picker.id IS NULL THEN
    RAISE EXCEPTION 'Picker not found';
  END IF;
  IF v_picker.application_status <> 'approved' THEN
    RAISE EXCEPTION 'Picker is not approved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vendors v WHERE v.id = p_vendor_id) THEN
    RAISE EXCEPTION 'Vendor not found';
  END IF;
  IF v_picker.registration_source = 'vendor'
     AND v_picker.created_by_vendor_id IS NOT NULL
     AND v_picker.created_by_vendor_id <> p_vendor_id
  THEN
    RAISE EXCEPTION 'Vendor-created Pickers are permanently linked to their creating vendor';
  END IF;

  IF p_lane_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.vendor_lanes l
    WHERE l.id = p_lane_id AND l.vendor_id = p_vendor_id AND l.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Lane does not belong to this vendor';
  END IF;

  SELECT v.auth_user_id INTO v_owner_auth_user_id
  FROM public.vendors v WHERE v.id = p_vendor_id;

  SELECT w.id, w.vendor_id, w.status
    INTO v_worker
  FROM public.vendor_workers w
  WHERE w.auth_user_id = v_picker.auth_user_id
  FOR UPDATE;

  IF v_worker.id IS NOT NULL THEN
    IF v_worker.vendor_id <> p_vendor_id AND v_worker.status = 'active' THEN
      RAISE EXCEPTION 'Picker is already assigned to another vendor';
    END IF;
    IF v_worker.vendor_id <> p_vendor_id
       AND v_picker.registration_source = 'vendor'
       AND v_picker.created_by_vendor_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'Vendor-created Pickers cannot be reassigned';
    END IF;
    UPDATE public.vendor_workers
    SET vendor_id = p_vendor_id, worker_name = v_picker.full_name,
        status = 'active', updated_at = now()
    WHERE id = v_worker.id;
  ELSE
    INSERT INTO public.vendor_workers(vendor_id, auth_user_id, worker_name, status)
    VALUES (p_vendor_id, v_picker.auth_user_id, v_picker.full_name, 'active')
    RETURNING id, vendor_id, status INTO v_worker;
  END IF;

  SELECT pvr.id INTO v_request_id
  FROM public.picker_vendor_requests pvr
  WHERE pvr.vendor_id = p_vendor_id
    AND pvr.picker_id = p_picker_id
    AND pvr.status IN ('pending', 'accepted')
  ORDER BY pvr.requested_at DESC
  LIMIT 1;

  IF v_request_id IS NULL THEN
    INSERT INTO public.picker_vendor_requests (
      picker_id, vendor_id, status, requested_at, responded_at, updated_at
    )
    VALUES (p_picker_id, p_vendor_id, 'accepted', now(), now(), now())
    RETURNING id INTO v_request_id;
  ELSE
    UPDATE public.picker_vendor_requests
    SET status = 'accepted', responded_at = now(), updated_at = now()
    WHERE id = v_request_id;
  END IF;

  UPDATE public.picker_profiles
  SET availability_status = 'busy', updated_at = now()
  WHERE id = p_picker_id;

  IF p_lane_id IS NOT NULL THEN
    UPDATE public.vendor_lane_picker_assignments
    SET status = 'inactive', updated_at = now()
    WHERE lane_id = p_lane_id AND status = 'active';

    INSERT INTO public.vendor_lane_picker_assignments (
      vendor_id, lane_id, worker_id, status, assigned_at
    )
    VALUES (p_vendor_id, p_lane_id, v_worker.id, 'active', now())
    ON CONFLICT (lane_id) WHERE status = 'active'
    DO UPDATE SET worker_id = EXCLUDED.worker_id,
                  assigned_at = now(),
                  updated_at = now();
  END IF;

  IF p_ticket_id IS NOT NULL THEN
    UPDATE public.vendor_support_tickets
    SET status = 'in_progress', updated_at = now()
    WHERE id = p_ticket_id AND vendor_id = p_vendor_id
      AND issue_type = 'picker_helper';
  END IF;

  RETURN jsonb_build_object(
    'vendor_id', p_vendor_id, 'picker_id', p_picker_id,
    'worker_id', v_worker.id, 'request_id', v_request_id, 'lane_id', p_lane_id
  );
END;
$;

REVOKE ALL ON FUNCTION public.admin_assign_picker_helper(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_assign_picker_helper(uuid, uuid, uuid, uuid) TO authenticated;

COMMIT;
