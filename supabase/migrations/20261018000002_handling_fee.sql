-- RivoCity handling fee support
-- Fee is calculated per vendor order from total item quantity:
-- 1 item = ₹2; 2–3 = ₹4; 4–6 = ₹6; 7–10 = ₹8; 11+ = ₹10.
-- The fee is stored at order creation so later pricing changes do not alter old orders.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS handling_fee numeric(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.orders.handling_fee IS
  'Customer handling fee calculated by total item quantity for this vendor order; retained as a separate platform charge.';
