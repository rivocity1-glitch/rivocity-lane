# Picker Barcode Experiment

Status: Experimental; not production-validated.

## Goal
Let a Picker use a mobile camera or manual entry to verify that a physical product matches an item in the Picker's currently claimed order. This is intended to make picking easier when vendors continue to use separate billing software.

## Current prototype
- Scanner appears only after the worker has claimed an order.
- Uses the rear-facing camera when the browser supports `getUserMedia`.
- Attempts barcode detection with the browser's native `BarcodeDetector` API when present.
- Provides manual barcode/SKU entry as a fallback.
- Looks up only product IDs already present in the Picker's claimed order and compares scanned digits with the product's `barcode` or `sku`.
- Highlights/scrolls to the matching task; the Picker must still tap **Mark Picked**. It does not create a sale, modify external billing software, adjust stock, or auto-complete tasks.
- Duplicate barcode matches are rejected as ambiguous.

## Important limitations
- Native browser barcode support varies. On unsupported mobile browsers, manual barcode entry remains available; a later iteration should integrate a dedicated scanner library and test on actual Android devices.
- Existing products need accurate `barcode` or `sku` values for automatic matching.
- Camera access normally requires HTTPS or localhost and the worker must grant permission.
- Matching is limited to the currently claimed picking order for the logged-in worker.

## Test checklist
1. Sign in as an active Picker assigned to a vendor.
2. Confirm the Picker account has a claimed order with an item whose product has a saved barcode or SKU.
3. Open the scanner on an Android phone over HTTPS and grant camera access.
4. Scan a barcode matching an unpicked product in that order.
5. Confirm the message identifies the expected product and scrolls to the task.
6. Tap **Mark Picked** manually and verify the task updates using the existing secure RPC.
7. Scan a barcode that is not in the order and verify it does not mark anything picked.
8. Test duplicate barcode/SKU values and verify the ambiguity is shown.
9. Test manual entry when camera permission is denied or barcode detection is unsupported.
10. Verify another vendor's product/order cannot be looked up through this workflow.

Do not merge this experiment into `main` until the actual phone tests and Supabase permissions have been reviewed.
