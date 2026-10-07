-- RivoCity shared Picker pool
-- Vendor accepts an order -> every order item gets one shared picking task.
-- worker_id stays NULL until the Picker who physically picks the item completes it.
-- Lane/rack are location hints only; they never assign an item to a Picker.
--
-- This migration intentionally uses only the columns that exist on
-- public.order_item_picking_tasks:
-- id, order_item_id, vendor_id, worker_id, quantity, status,
-- assigned_at, picked_at, updated_at.
-- No basket_id is used.

BEGIN;

ALTER TABLE public.order_item_picking_tasks
  ALTER COLUMN worker_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS order_item_picking_tasks_vendor_status_idx
  ON public.order_item_picking_tasks(vendor_id, status, assigned_at);

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
BEGIN
  SELECT o.id, o.vendor_id, o.order_status
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF v_order.id IS NULL THEN
    RETURN;
  END IF;

  IF v_order.order_status NOT IN ('accepted', 'preparing') THEN
    RETURN;
  END IF;

  FOR v_item IN
    SELECT oi.id, oi.quantity
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
  LOOP
    INSERT INTO public.order_item_picking_tasks (
      order_item_id,
      vendor_id,
      worker_id,
      quantity,
      status,
      assigned_at,
      updated_at
    )
    VALUES (
      v_item.id,
      v_order.vendor_id,
      NULL,
      v_item.quantity,
      'assigned',
      now(),
      now()
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
  IF NEW.order_status IS DISTINCT FROM OLD.order_status
     AND NEW.order_status IN ('accepted', 'preparing')
  THEN
    PERFORM public.auto_assign_picker_tasks_for_order(NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_assign_picker_order ON public.orders;

CREATE TRIGGER trg_auto_assign_picker_order
AFTER UPDATE OF order_status ON public.orders
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
  SELECT o.order_status
  INTO v_status
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

DROP TRIGGER IF EXISTS trg_auto_assign_picker_lane
ON public.vendor_lane_picker_assignments;

DROP TRIGGER IF EXISTS trg_auto_assign_picker_location
ON public.product_storage_locations;

DROP POLICY IF EXISTS "Picker can read vendor picking tasks"
ON public.order_item_picking_tasks;

CREATE POLICY "Picker can read vendor picking tasks"
ON public.order_item_picking_tasks
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.vendor_workers w
    WHERE w.vendor_id = order_item_picking_tasks.vendor_id
      AND w.auth_user_id = (SELECT auth.uid())
      AND w.status = 'active'
  )
  OR EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.id = order_item_picking_tasks.vendor_id
      AND v.auth_user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "Vendor can update own picking tasks"
ON public.order_item_picking_tasks;

CREATE POLICY "Vendor can update own picking tasks"
ON public.order_item_picking_tasks
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.id = order_item_picking_tasks.vendor_id
      AND v.auth_user_id = (SELECT auth.uid())
  )
  OR EXISTS (
    SELECT 1
    FROM public.vendor_workers w
    WHERE w.vendor_id = order_item_picking_tasks.vendor_id
      AND w.auth_user_id = (SELECT auth.uid())
      AND w.status = 'active'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.id = order_item_picking_tasks.vendor_id
      AND v.auth_user_id = (SELECT auth.uid())
  )
  OR EXISTS (
    SELECT 1
    FROM public.vendor_workers w
    WHERE w.vendor_id = order_item_picking_tasks.vendor_id
      AND w.auth_user_id = (SELECT auth.uid())
      AND w.status = 'active'
  )
);

DO $$
DECLARE
  v_order_id uuid;
BEGIN
  FOR v_order_id IN
    SELECT id
    FROM public.orders
    WHERE order_status IN ('accepted', 'preparing')
  LOOP
    PERFORM public.auto_assign_picker_tasks_for_order(v_order_id);
  END LOOP;
END;
$$;

COMMIT;
