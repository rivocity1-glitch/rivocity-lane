# RivoCity Lane database setup

Apply the migration in `migrations/20260930000000_vendor_worker_picking.sql` to the shared Rivo Supabase project before running the live Lane test.

The migration adds the minimal worker/picking backend required by Lane:
- `vendor_workers`: worker profiles linked to Supabase Auth users and a vendor.
- `order_item_picking_tasks`: the current worker assignment and picked state for each order item.

The frontend uses the existing Rivo `vendors`, `orders`, and `order_items` tables and adds no duplicate order data.

A worker must have a normal Supabase Auth email/password account. After creating that Auth user, create the matching `vendor_workers` row with:
- `vendor_id`: the vendor UUID
- `auth_user_id`: the worker Auth UUID
- `worker_name`: display name
- `status`: `active`

Do not put a service-role key in Lane or Vendor Portal.
