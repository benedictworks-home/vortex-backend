-- Migration: #410 — Normalise intent token data into foreign keys on the tokens table
--
-- Strategy (expand/contract):
--   Phase 1 (this migration): ADD the FK columns and snapshot decimals columns.
--                              The JSON blobs are RETAINED — the application
--                              continues reading them in the transition period.
--   Phase 2 (follow-up):       DROP src_token/dst_token once every caller reads
--                              from the FK join.
--
-- Backfill logic:
--   Rows that can be resolved via (address, chain) against the tokens table
--   get their FK set.  Rows that cannot be resolved are logged via a RAISE
--   NOTICE so they are visible in the migration output.  They are NEVER dropped.
--
-- Volume-by-token index:
--   The composite index on (src_token_id, created_at DESC) enables
--   "volume by token by day" queries under 100 ms on 5M intents by allowing
--   an index scan over a single token's rows with the most-recent day's rows
--   returned first.

-- ── Phase 1: Add columns ─────────────────────────────────────────────────────

ALTER TABLE "intents"
  ADD COLUMN IF NOT EXISTS "src_token_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "dst_token_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "src_decimals"   INTEGER,
  ADD COLUMN IF NOT EXISTS "dst_decimals"   INTEGER;

-- ── Add foreign-key constraints (INITIALLY DEFERRED allows backfill in the
-- same transaction; they are checked at commit time only). ───────────────────

ALTER TABLE "intents"
  ADD CONSTRAINT "intents_src_token_id_fkey"
    FOREIGN KEY ("src_token_id") REFERENCES "tokens"("id")
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "intents"
  ADD CONSTRAINT "intents_dst_token_id_fkey"
    FOREIGN KEY ("dst_token_id") REFERENCES "tokens"("id")
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

-- ── Backfill: resolve JSON blobs → token FK ──────────────────────────────────
-- For each intent, attempt to find the tokens row whose (address, chain)
-- matches the JSON blob's address/chain fields.
-- dst_token only has a `contract` key (Stellar), so we match on address=contract
-- with chain='stellar'.

DO $$
DECLARE
  v_intent    RECORD;
  v_src_id    TEXT;
  v_dst_id    TEXT;
  v_src_dec   INTEGER;
  v_dst_dec   INTEGER;
  v_unresolved_src  INTEGER := 0;
  v_unresolved_dst  INTEGER := 0;
BEGIN
  FOR v_intent IN
    SELECT id, intent_id, src_token, dst_token
    FROM   intents
    WHERE  src_token_id IS NULL OR dst_token_id IS NULL
  LOOP
    -- Resolve src_token: JSON shape is { address, chain, decimals, ... }
    SELECT t.id, t.decimals
      INTO v_src_id, v_src_dec
      FROM tokens t
     WHERE t.address = v_intent.src_token->>'address'
       AND t.chain   = (v_intent.src_token->>'chain')::"SupportedChain"
     LIMIT 1;

    -- Resolve dst_token: JSON shape is { contract, decimals, ... }
    -- Stellar tokens use `contract` as the address.
    SELECT t.id, t.decimals
      INTO v_dst_id, v_dst_dec
      FROM tokens t
     WHERE t.address = v_intent.dst_token->>'contract'
       AND t.chain   = 'stellar'::"SupportedChain"
     LIMIT 1;

    IF v_src_id IS NOT NULL AND v_dst_id IS NOT NULL THEN
      UPDATE intents
         SET src_token_id = v_src_id,
             dst_token_id = v_dst_id,
             src_decimals = v_src_dec,
             dst_decimals = v_dst_dec
       WHERE id = v_intent.id;
    ELSIF v_src_id IS NULL THEN
      v_unresolved_src := v_unresolved_src + 1;
      RAISE NOTICE '[#410 backfill] unresolved src_token for intent_id=% address=% chain=%',
        v_intent.intent_id,
        v_intent.src_token->>'address',
        v_intent.src_token->>'chain';
    ELSIF v_dst_id IS NULL THEN
      v_unresolved_dst := v_unresolved_dst + 1;
      RAISE NOTICE '[#410 backfill] unresolved dst_token for intent_id=% contract=%',
        v_intent.intent_id,
        v_intent.dst_token->>'contract';
    END IF;
  END LOOP;

  RAISE NOTICE '[#410 backfill] complete — unresolved src_token: %, unresolved dst_token: %',
    v_unresolved_src, v_unresolved_dst;
END $$;

-- ── Volume-by-token-by-day index ─────────────────────────────────────────────
-- Supports queries like:
--   SELECT date_trunc('day', to_timestamp(created_at)), SUM(fill_amount::numeric)
--   FROM intents WHERE src_token_id = $1 AND state = 'filled'
--   GROUP BY 1 ORDER BY 1 DESC
--
-- The partial WHERE state='filled' keeps the index small (only terminal rows
-- contribute to volume), and created_at DESC puts the newest days first so
-- a LIMIT-based query can stop early.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "intents_volume_by_token_idx"
  ON "intents" ("src_token_id", "created_at" DESC)
  WHERE "state" = 'filled';

-- Secondary index for destination-token analytics (inbound volume on Stellar).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "intents_volume_by_dst_token_idx"
  ON "intents" ("dst_token_id", "created_at" DESC)
  WHERE "state" = 'filled';
