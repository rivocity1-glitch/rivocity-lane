# RivoCity Picker

RivoCity Picker is a worker-facing Progressive Web App (PWA). It lets an assigned Picker claim an order, see its products and shelf locations, and confirm each item after physically picking it.

## Worker workflow

1. The Picker registers or signs in.
2. Admin approval and vendor assignment are required before picking.
3. The Picker sees only the assigned vendor's available orders through Supabase row-level security.
4. The Picker claims one order at a time.
5. The Picker scans a barcode/SKU as a verification aid (optional), then manually taps **Mark Picked**.
6. Completed tasks appear in History.

Barcode scanning is a verification aid, not an inventory or billing integration. It does not create sales, update external billing software, adjust stock, or auto-complete a task.

## Supabase setup

Apply the migrations in timestamp order:

1. `20260930000000_vendor_worker_picking.sql`
2. `20261001000000_picker_recruitment.sql`
3. `20261007000000_shared_picker_pool.sql`
4. `20261010000000_vendor_read_assigned_picker_availability.sql`
5. `20261018000000_picker_claim_reconciliation.sql`
6. `20261018000002_handling_fee.sql`
7. `20261019000000_sequential_picker_ids.sql`
8. `20261102000000_picker_registration_and_login.sql`

The final migration ensures the profile columns, the before/after Auth triggers that generate and persist `PC-1000`-style IDs, and removes the legacy public email-lookup RPC if one was manually created.

### Deploy Picker ID sign-in

Picker ID sign-in resolves the Auth email inside a Supabase Edge Function. The email is never returned to the browser.

From the repository root, set the function secrets and deploy:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
supabase functions deploy picker-login
```

The Supabase project already provides `SUPABASE_URL` and `SUPABASE_ANON_KEY` to Edge Functions. Never put the service-role key in the Vite `.env` file or frontend code.

The Edge Function uses the existing Auth password convention `Rivo@<password of up to 4 characters>` so older Picker accounts remain compatible. New registrations are restricted to a 4-digit PIN. Five failed attempts per IP + Picker ID are blocked for 15 minutes. This short-PIN model still has a small search space; keep Supabase Auth rate limits enabled and plan a stronger credential / OTP flow before broad public rollout.

### Frontend environment

Create `.env.local`:

```env
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

Use only the project URL and anon/publishable key in the browser. Do not expose a service-role key.

## Run locally

```bash
npm ci
npm run check
npm run build
npm run dev
```

For Android testing on the same Wi-Fi, use HTTPS or a secure tunnel for camera access. The camera API is generally unavailable on plain LAN HTTP.

## Required manual tests

- Register with a new email and a 4-digit PIN; confirm a unique Picker ID is displayed.
- Confirm email (when email confirmation is enabled), then sign in using Picker ID and short password.
- Verify wrong IDs/PINs return the same generic error.
- Verify pending Picker cannot access picking tools.
- Approve and assign a Picker, then claim an order.
- Confirm two Pickers cannot claim the same order simultaneously.
- Mark one item picked and verify it appears once in History.
- Verify a Picker cannot access another vendor's order/task.
- Test PWA install and camera permission on actual Android Chrome over HTTPS.
- Test manual barcode entry on browsers without native BarcodeDetector support.

## Scope

Picker is only the worker picking interface. It is not a vendor dashboard, inventory-management tool, billing system, or customer-order app.
