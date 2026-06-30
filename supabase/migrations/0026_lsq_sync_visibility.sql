-- Per-contact LSQ sync visibility.
--
-- ensure-lead is fire-and-forget from the webhook; until now its
-- outcome was opaque — if Source / Sub Source didn't apply or the
-- create call failed, the operator had no way to see why. These
-- columns capture the last sync attempt so the dashboard can surface
-- "LSQ: ✓ created with Source=URoots" / "LSQ: ✗ Attribute does not
-- exist" right next to the chat.
--
-- Status values used:
--   'created'  → new LSQ lead was inserted with our defaults
--   'linked'   → lead already existed, we just cached its prospect_id
--   'skipped'  → flag off / not configured / contact missing
--   'error'    → LSQ call failed; see lsq_last_sync_error for details

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lsq_last_sync_at     timestamptz,
  ADD COLUMN IF NOT EXISTS lsq_last_sync_status text,
  ADD COLUMN IF NOT EXISTS lsq_last_sync_error  text,
  ADD COLUMN IF NOT EXISTS lsq_last_sync_fields text[];
