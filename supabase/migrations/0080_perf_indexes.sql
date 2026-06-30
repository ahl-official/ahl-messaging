-- =====================================================================
-- 0080 — Hot-path performance indexes
-- ---------------------------------------------------------------------
-- Three seq-scans verified missing in the perf audit, each on a path that
-- runs on every inbound webhook or every inbox mount:
--
--   1. campaign_recipients — the per-inbound "did this number reply to a
--      recent campaign?" lookup filters on wa_id alone, but the only
--      index touching wa_id is the composite (campaign_id, wa_id), useless
--      for a wa_id-only scan. (webhook/route.ts)
--   2. messages — the auto-close "most-recent inbound" sweep filters
--      direction='inbound' ordered by timestamp over 3.8M rows; the only
--      messages index is (contact_id, timestamp). (actions.ts)
--   3. contacts — stage-counts groups by lsq_stage per business number;
--      no lsq_stage index exists.
--
-- NOTE: the messages index touches a 3.8M-row table. Run during low
-- traffic, or create it with CREATE INDEX CONCURRENTLY (outside a
-- transaction) to avoid briefly locking writes while it builds.
-- =====================================================================

CREATE INDEX IF NOT EXISTS campaign_recipients_wa_id_sent_at_idx
  ON public.campaign_recipients (wa_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_inbound_timestamp
  ON public.messages (timestamp DESC)
  WHERE direction = 'inbound';

CREATE INDEX IF NOT EXISTS idx_contacts_bpid_lsq_stage
  ON public.contacts (business_phone_number_id, lsq_stage);
