import { createHash } from "node:crypto";
import { RfqResponseSignaturePayload } from "../intents/rfq.types";

/** Canonical domain-separated message signed by a solver for an RFQ response. */
export function buildRfqResponseMessage(payload: RfqResponseSignaturePayload): string {
  const canonicalPayload = JSON.stringify(
    Object.fromEntries(
      Object.entries(payload)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  const payloadHash = createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
  return `vortex:rfq:v1:${payload.requestId}:${payloadHash}`;
}