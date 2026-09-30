# RivoCity Lane

RivoCity Lane is a small worker-facing PWA for one job: **show a specific worker what they need to pick and record what they picked**.

## Worker flow

1. Worker opens RivoCity Lane.
2. Worker sees only items assigned to their profile.
3. Each item shows the order number, product and quantity.
4. Worker taps **Mark Picked**.
5. Completed picks move to History.
6. Worker Profile keeps a simple picking record for future incentive calculations.

## Current local/demo mode

The repository currently uses demo data and browser localStorage so the picking flow can be tested without changing the production Supabase database.

The Profile tab includes a demo worker selector. Production authentication and task assignment will identify the worker from the existing RivoCity backend.

## Run locally

```bash
npm install
npm run dev
```

Open the Vite local URL shown in the terminal.

For phone testing on the same Wi-Fi:

```bash
npm run dev -- --host 0.0.0.0
```

## Scope

Lane intentionally does **not** contain a vendor dashboard, store management, lanes/departments, restocking, packing workflow, or order-management dashboard. Those responsibilities stay in the Vendor Portal.

Lane is only the worker's picking interface.


## Supabase worker setup

Lane now uses Supabase for worker authentication, assignments, picking status and history. Apply the migration at supabase/migrations/20260930000000_vendor_worker_picking.sql to the shared Rivo Supabase project before testing the live flow.

Create a worker's Supabase Auth email/password account, then create the matching vendor_workers row with that user's Auth UUID, the vendor UUID and the worker name. The Vendor Portal Lane Picking page assigns order items to that worker. No service-role key is used by either frontend.
