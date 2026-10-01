-- ============================================================
-- RivoCity Picker Operations
-- Lane-based automatic picking + automatic order baskets +
-- Admin helper assignment
-- Run ONCE in the shared Supabase SQL Editor.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Automatic basket for every picking order
-- ------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.rivo_picker_basket_seq
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

CREATE TABLE IF NOT EXISTS public.picker_baskets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  basket_code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'assigned'
    CHECK (status IN (
      'assigned',
      'picking',
      'ready',
      'handed_over',
      'returned',
      'cancelled'
    )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);

ALTER TABLE public.order_item_picking_tasks
  ADD COLUMN IF NOT EXISTS basket_id uuid
    REFERENCES public.picker_baskets(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_picker_baskets_vendor
  ON public.picker_baskets(vendor_id);

CREATE INDEX IF NOT EXISTS idx_picker_baskets_order
  ON public.picker_baskets(order_id);

CREATE INDEX IF NOT EXISTS idx_picker_baskets_status
  ON public.picker_baskets(status);

CREATE INDEX IF NOT EXISTS idx_picker_tasks_basket
  ON public.order_item_picking_tasks(basket_id);


-- ------------------------------------------------------------
-- 2. Basket creator
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_picker_basket(
  p_order_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_basket_id uuid;
  v_vendor_id uuid;
  v_code text;
BEGIN

  SELECT o.vendor_id
  INTO v_vendor_id
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF v_vendor_id IS NULL THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  SELECT pb.id
  INTO v_basket_id
  FROM public.picker_baskets pb
  WHERE pb.order_id = p_order_id;

  IF v_basket_id IS NOT NULL THEN
    RETURN v_basket_id;
  END IF;

  v_code :=
    'RB-' ||
    LPAD(
      nextval('public.rivo_picker_basket_seq')::text,
      6,
      '0'
    );

  INSERT INTO public.picker_baskets (
    vendor_id,
    order_id,
    basket_code,
    status
  )
  VALUES (
    v_vendor_id,
    p_order_id,
    v_code,
    'assigned'
  )
  ON CONFLICT (order_id)
  DO UPDATE SET updated_at = now()
  RETURNING id INTO v_basket_id;

  RETURN v_basket_id;
END;
$$;


-- ------------------------------------------------------------
-- 3. Automatic task assignment
--
-- Vendor assigns Picker -> Lane.
--
-- Product has optional Product Location -> Lane.
--
-- The system then automatically:
-- Order -> Basket -> Order Item -> Lane -> Picker
--
-- Vendor does NOT assign individual products to Pickers.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auto_assign_picker_tasks_for_order(
  p_order_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order record;
  v_item record;
  v_location record;
  v_worker_id uuid;
  v_basket_id uuid;
BEGIN

  SELECT
    o.id,
    o.vendor_id,
    o.order_status
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF v_order.id IS NULL THEN
    RETURN;
  END IF;

  IF v_order.order_status NOT IN (
    'accepted',
    'preparing',
    'packed',
    'ready_for_pickup',
    'waiting_rider'
  ) THEN
    RETURN;
  END IF;

  v_basket_id :=
    public.ensure_picker_basket(p_order_id);

  FOR v_item IN
    SELECT
      oi.id,
      oi.product_id,
      oi.quantity
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
  LOOP

    v_worker_id := NULL;

    -- --------------------------------------------------------
    -- First choice:
    -- Product location -> Lane -> Picker assigned to that lane
    -- --------------------------------------------------------

    SELECT
      v.id
    INTO v_worker_id
    FROM public.product_storage_locations psl
    INNER JOIN public.vendor_lane_picker_assignments a
      ON a.lane_id = psl.lane_id
     AND a.vendor_id = v_order.vendor_id
     AND a.status = 'active'
    INNER JOIN public.vendor_workers v
      ON v.id = a.worker_id
     AND v.vendor_id = v_order.vendor_id
     AND v.status = 'active'
    WHERE psl.vendor_id = v_order.vendor_id
      AND psl.product_id = v_item.product_id
    ORDER BY psl.created_at ASC
    LIMIT 1;

    -- --------------------------------------------------------
    -- Fallback:
    -- If this product has no physical location and the vendor
    -- has exactly one active Picker, give it to that Picker.
    -- This keeps locations optional.
    -- --------------------------------------------------------

    IF v_worker_id IS NULL THEN

      SELECT min(x.id)
      INTO v_worker_id
      FROM (
        SELECT v.id
        FROM public.vendor_workers v
        WHERE v.vendor_id = v_order.vendor_id
          AND v.status = 'active'
      ) x
      WHERE (
        SELECT count(*)
        FROM public.vendor_workers vx
        WHERE vx.vendor_id = v_order.vendor_id
          AND vx.status = 'active'
      ) = 1;

    END IF;

    -- --------------------------------------------------------
    -- Create/update the task only when a Picker can actually
    -- receive it.
    -- --------------------------------------------------------

    IF v_worker_id IS NOT NULL THEN

      INSERT INTO public.order_item_picking_tasks (
        order_item_id,
        vendor_id,
        worker_id,
        quantity,
        status,
        basket_id,
        assigned_at,
        updated_at
      )
      VALUES (
        v_item.id,
        v_order.vendor_id,
        v_worker_id,
        v_item.quantity,
        'assigned',
        v_basket_id,
        now(),
        now()
      )
      ON CONFLICT (order_item_id)
      DO UPDATE SET
        worker_id = CASE
          WHEN public.order_item_picking_tasks.status = 'picked'
            THEN public.order_item_picking_tasks.worker_id
          ELSE EXCLUDED.worker_id
        END,
        quantity = EXCLUDED.quantity,
        basket_id = EXCLUDED.basket_id,
        assigned_at = CASE
          WHEN public.order_item_picking_tasks.status = 'picked'
            THEN public.order_item_picking_tasks.assigned_at
          ELSE now()
        END,
        updated_at = now();

    END IF;

  END LOOP;

END;
$$;


-- ------------------------------------------------------------
-- 4. Run automatic assignment when an order enters packing
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_auto_assign_picker_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN

  IF NEW.order_status IS DISTINCT FROM OLD.order_status
     AND NEW.order_status IN (
       'accepted',
       'preparing',
       'packed',
       'ready_for_pickup',
       'waiting_rider'
     )
  THEN
    PERFORM public.auto_assign_picker_tasks_for_order(NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  trg_auto_assign_picker_order
ON public.orders;

CREATE TRIGGER trg_auto_assign_picker_order
AFTER UPDATE OF order_status ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.trigger_auto_assign_picker_order();


-- ------------------------------------------------------------
-- 5. If an order item is added/changed while the order is already
--    in packing, route it automatically as well.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_auto_assign_picker_order_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $
BEGIN
  PERFORM public.auto_assign_picker_tasks_for_order(NEW.order_id);
  RETURN NEW;
END;
$;

DROP TRIGGER IF EXISTS
  trg_auto_assign_picker_order_item
ON public.order_items;

CREATE TRIGGER trg_auto_assign_picker_order_item
AFTER INSERT OR UPDATE OF product_id, quantity ON public.order_items
FOR EACH ROW
EXECUTE FUNCTION public.trigger_auto_assign_picker_order_item();


-- ------------------------------------------------------------
-- 6. If a lane is assigned after the order is already packing,
--    automatically assign matching pending items.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_auto_assign_picker_lane()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order_id uuid;
BEGIN

  FOR v_order_id IN
    SELECT DISTINCT oi.order_id
    FROM public.order_items oi
    INNER JOIN public.orders o
      ON o.id = oi.order_id
    INNER JOIN public.product_storage_locations psl
      ON psl.product_id = oi.product_id
     AND psl.vendor_id = NEW.vendor_id
     AND psl.lane_id = NEW.lane_id
    WHERE o.vendor_id = NEW.vendor_id
      AND o.order_status IN (
        'accepted',
        'preparing',
        'packed',
        'ready_for_pickup',
        'waiting_rider'
      )
  LOOP
    PERFORM public.auto_assign_picker_tasks_for_order(v_order_id);
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  trg_auto_assign_picker_lane
ON public.vendor_lane_picker_assignments;

CREATE TRIGGER trg_auto_assign_picker_lane
AFTER INSERT OR UPDATE OF status, worker_id
ON public.vendor_lane_picker_assignments
FOR EACH ROW
WHEN (NEW.status = 'active')
EXECUTE FUNCTION public.trigger_auto_assign_picker_lane();


-- ------------------------------------------------------------
-- 7. If a product is given a physical lane after the order
--    already exists, automatically assign its task.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_auto_assign_picker_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order_id uuid;
BEGIN

  FOR v_order_id IN
    SELECT DISTINCT oi.order_id
    FROM public.order_items oi
    INNER JOIN public.orders o
      ON o.id = oi.order_id
    WHERE oi.product_id = NEW.product_id
      AND o.vendor_id = NEW.vendor_id
      AND o.order_status IN (
        'accepted',
        'preparing',
        'packed',
        'ready_for_pickup',
        'waiting_rider'
      )
  LOOP
    PERFORM public.auto_assign_picker_tasks_for_order(v_order_id);
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  trg_auto_assign_picker_location
ON public.product_storage_locations;

CREATE TRIGGER trg_auto_assign_picker_location
AFTER INSERT OR UPDATE OF lane_id, rack_id
ON public.product_storage_locations
FOR EACH ROW
EXECUTE FUNCTION public.trigger_auto_assign_picker_location();


-- ------------------------------------------------------------
-- 8. Basket status follows picking progress
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_picker_basket_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total integer;
  v_picked integer;
  v_order_id uuid;
BEGIN

  IF NEW.basket_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT order_id
  INTO v_order_id
  FROM public.picker_baskets
  WHERE id = NEW.basket_id;

  SELECT count(*)
  INTO v_total
  FROM public.order_items
  WHERE order_id = v_order_id;

  SELECT count(*)
  INTO v_picked
  FROM public.order_item_picking_tasks
  WHERE basket_id = NEW.basket_id
    AND status = 'picked';

  UPDATE public.picker_baskets
  SET
    status = CASE
      WHEN v_total > 0 AND v_picked = v_total
        THEN 'ready'
      WHEN v_picked > 0
        THEN 'picking'
      ELSE 'assigned'
    END,
    updated_at = now()
  WHERE id = NEW.basket_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  trg_update_picker_basket_status
ON public.order_item_picking_tasks;

CREATE TRIGGER trg_update_picker_basket_status
AFTER INSERT OR UPDATE OF status
ON public.order_item_picking_tasks
FOR EACH ROW
EXECUTE FUNCTION public.update_picker_basket_status();


-- ============================================================
-- 9. Admin helper assignment
-- ============================================================

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
AS $$
DECLARE
  v_picker record;
  v_worker_id uuid;
  v_request_id uuid;
BEGIN

  -- Only Rivo Admin accounts can execute this.
  IF NOT EXISTS (
    SELECT 1
    FROM public.admin_users a
    WHERE a.auth_user_id = (select auth.uid())
  ) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT
    p.id,
    p.auth_user_id,
    p.full_name,
    p.application_status
  INTO v_picker
  FROM public.picker_profiles p
  WHERE p.id = p_picker_id;

  IF v_picker.id IS NULL THEN
    RAISE EXCEPTION 'Picker not found';
  END IF;

  IF v_picker.application_status <> 'approved' THEN
    RAISE EXCEPTION 'Picker is not approved';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.id = p_vendor_id
  ) THEN
    RAISE EXCEPTION 'Vendor not found';
  END IF;

  IF p_lane_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.vendor_lanes l
    WHERE l.id = p_lane_id
      AND l.vendor_id = p_vendor_id
      AND l.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Lane does not belong to this vendor';
  END IF;

  -- Existing worker for this vendor?
  SELECT vw.id
  INTO v_worker_id
  FROM public.vendor_workers vw
  WHERE vw.vendor_id = p_vendor_id
    AND vw.auth_user_id = v_picker.auth_user_id
  LIMIT 1;

  IF v_worker_id IS NULL THEN

    INSERT INTO public.vendor_workers (
      vendor_id,
      auth_user_id,
      worker_name,
      status
    )
    VALUES (
      p_vendor_id,
      v_picker.auth_user_id,
      v_picker.full_name,
      'active'
    )
    RETURNING id INTO v_worker_id;

  ELSE

    UPDATE public.vendor_workers
    SET
      worker_name = v_picker.full_name,
      status = 'active',
      updated_at = now()
    WHERE id = v_worker_id;

  END IF;

  -- Record the vendor relationship.
  SELECT pvr.id
  INTO v_request_id
  FROM public.picker_vendor_requests pvr
  WHERE pvr.vendor_id = p_vendor_id
    AND pvr.picker_id = p_picker_id
    AND pvr.status IN ('pending', 'accepted')
  ORDER BY pvr.requested_at DESC
  LIMIT 1;

  IF v_request_id IS NULL THEN

    INSERT INTO public.picker_vendor_requests (
      picker_id,
      vendor_id,
      status,
      requested_at,
      responded_at,
      updated_at
    )
    VALUES (
      p_picker_id,
      p_vendor_id,
      'accepted',
      now(),
      now(),
      now()
    )
    RETURNING id INTO v_request_id;

  ELSE

    UPDATE public.picker_vendor_requests
    SET
      status = 'accepted',
      responded_at = now(),
      updated_at = now()
    WHERE id = v_request_id;

  END IF;

  -- Optional lane assignment.
  IF p_lane_id IS NOT NULL THEN

    INSERT INTO public.vendor_lane_picker_assignments (
      vendor_id,
      lane_id,
      worker_id,
      status,
      assigned_at
    )
    VALUES (
      p_vendor_id,
      p_lane_id,
      v_worker_id,
      'active',
      now()
    )
    ON CONFLICT (lane_id)
    WHERE status = 'active'
    DO UPDATE SET
      worker_id = EXCLUDED.worker_id,
      assigned_at = now(),
      updated_at = now();

  END IF;

  -- Picker is now occupied by this vendor.
  UPDATE public.picker_profiles
  SET
    availability_status = 'busy',
    updated_at = now()
  WHERE id = p_picker_id;

  -- Mark the helper request as being handled.
  IF p_ticket_id IS NOT NULL THEN
    UPDATE public.vendor_support_tickets
    SET
      status = 'in_progress',
      updated_at = now()
    WHERE id = p_ticket_id
      AND vendor_id = p_vendor_id
      AND issue_type = 'picker_helper';
  END IF;

  RETURN jsonb_build_object(
    'vendor_id', p_vendor_id,
    'picker_id', p_picker_id,
    'worker_id', v_worker_id,
    'request_id', v_request_id,
    'lane_id', p_lane_id
  );

END;
$$;

REVOKE ALL
ON FUNCTION public.admin_assign_picker_helper(uuid, uuid, uuid, uuid)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.admin_assign_picker_helper(uuid, uuid, uuid, uuid)
TO authenticated;


-- ============================================================
-- 10. RLS for automatic baskets
-- ============================================================

ALTER TABLE public.picker_baskets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
  "Vendors can view their picker baskets"
ON public.picker_baskets;

CREATE POLICY
  "Vendors can view their picker baskets"
ON public.picker_baskets
FOR SELECT
TO authenticated
USING (
  vendor_id = (
    SELECT v.id
    FROM public.vendors v
    WHERE v.auth_user_id = (select auth.uid())
    LIMIT 1
  )
);

DROP POLICY IF EXISTS
  "Pickers can view vendor baskets"
ON public.picker_baskets;

CREATE POLICY
  "Pickers can view vendor baskets"
ON public.picker_baskets
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.vendor_workers w
    WHERE w.vendor_id = picker_baskets.vendor_id
      AND w.auth_user_id = (select auth.uid())
      AND w.status = 'active'
  )
);

DROP POLICY IF EXISTS
  "Admins can view picker baskets"
ON public.picker_baskets;

CREATE POLICY
  "Admins can view picker baskets"
ON public.picker_baskets
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.admin_users a
    WHERE a.auth_user_id = (select auth.uid())
  )
);


-- ============================================================
-- 11. Verification
-- ============================================================

SELECT
  table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'picker_baskets',
    'vendor_lanes',
    'vendor_racks',
    'product_storage_locations',
    'vendor_lane_picker_assignments',
    'vendor_support_tickets',
    'picker_vendor_requests',
    'order_item_picking_tasks'
  )
ORDER BY table_name;

COMMIT;
