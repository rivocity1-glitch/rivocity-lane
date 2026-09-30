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
