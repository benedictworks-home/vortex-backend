CREATE TABLE "price_history" (
  "id" BIGSERIAL NOT NULL,
  "token_id" TEXT NOT NULL,
  "price_usd" DOUBLE PRECISION NOT NULL,
  "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "price_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "price_history_token_id_fkey" FOREIGN KEY ("token_id")
    REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX CONCURRENTLY "price_history_token_id_recorded_at_idx"
  ON "price_history"("token_id", "recorded_at" DESC);