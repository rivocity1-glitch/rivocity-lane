# RivoCity Picker

RivoCity Picker is a small worker-facing PWA for one job: **show a specific worker what they need to pick and record what they picked**.

## Worker flow

1. Worker signs in with the Supabase Auth account linked to their worker profile.
2. Worker sees only items assigned to that worker.
3. Each item shows the order number, product and quantity.
4. Worker taps **Mark Picked**.
5. Completed picks remain in Supabase and appear in History.
6. Picking totals are calculated from completed picking tasks for future incentive calculations.

## Vendor flow

The Vendor Portal has a **RivoCity Picker** page.

1. Vendor opens Picker.
2. Vendor sees the vendor's current order items.
3. Vendor assigns an item to an active Picker worker.
4. The worker immediately receives that assignment in RivoCity Picker through Supabase Realtime.
5. When the worker marks the item picked, the Vendor Portal reflects the picked status.

## Supabase setup

This repository contains the migration:

`supabase/migrations/20260930000000_vendor_worker_picking.sql`

Apply that migration to the shared Rivo Supabase project before testing the live integration.

Picker requires these Vite variables:

`VITE_SUPABASE_URL`
`VITE_SUPABASE_ANON_KEY`

Create a worker's Supabase Auth email/password account, then create a matching `vendor_workers` row containing:

- the vendor UUID
- the worker Auth UUID
- the worker name
- active status

The Vendor Portal can then assign order items to that worker.

No service-role key is used by either frontend.

## Run locally

```bash
npm install
npm run dev
```

For phone testing on the same Wi-Fi:

```bash
npm run dev -- --host 0.0.0.0
```

## Scope

Picker intentionally does **not** contain a vendor dashboard, store management, lanes/departments, restocking, packing workflow, or order-management dashboard.

Picker is only the worker's picking interface.