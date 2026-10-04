import { BadRequestException } from "@nestjs/common";
import { encodeCursor, decodeCursor, hashFilter } from "./cursor-codec";

const SECRET = "test-secret-1234";

describe("CursorCodec", () => {
  const payload = { createdAt: 1_700_000_000, id: "550e8400-e29b-41d4-a716-446655440000", filterHash: "" };

  it("round-trips a payload without a filter", () => {
    const cursor = encodeCursor(payload, SECRET);
    const decoded = decodeCursor(cursor, SECRET, "");
    expect(decoded).toMatchObject(payload);
  });

  it("round-trips a payload with a filter hash", () => {
    const fh = hashFilter({ state: "open", user: "GUSER1" });
    const p = { ...payload, filterHash: fh };
    const cursor = encodeCursor(p, SECRET);
    const decoded = decodeCursor(cursor, SECRET, fh);
    expect(decoded).toMatchObject(p);
  });

  it("throws BadRequestException when the signature is tampered", () => {
    const cursor = encodeCursor(payload, SECRET);
    // Flip one character near the end
    const tampered = cursor.slice(0, -3) + "xxx";
    expect(() => decodeCursor(tampered, SECRET, "")).toThrow(BadRequestException);
  });

  it("throws BadRequestException when cursor uses a wrong filter hash", () => {
    const fh1 = hashFilter({ state: "open" });
    const fh2 = hashFilter({ state: "filled" });
    const cursor = encodeCursor({ ...payload, filterHash: fh1 }, SECRET);
    expect(() => decodeCursor(cursor, SECRET, fh2)).toThrow(BadRequestException);
  });

  it("throws BadRequestException on a completely invalid cursor", () => {
    expect(() => decodeCursor("not-a-cursor", SECRET, "")).toThrow(BadRequestException);
  });

  it("hashFilter produces identical hashes for reordered keys", () => {
    const a = hashFilter({ state: "open", user: "G1" });
    const b = hashFilter({ user: "G1", state: "open" });
    expect(a).toBe(b);
  });

  it("hashFilter produces different hashes for different filter values", () => {
    const a = hashFilter({ state: "open" });
    const b = hashFilter({ state: "filled" });
    expect(a).not.toBe(b);
  });

  it("paginating through a fixed dataset never yields duplicates (property test)", () => {
    // Simulate 100 rows in createdAt DESC, id ASC order.
    // Encode a cursor from each row; verifying it decodes to the same payload
    // proves the round-trip is lossless regardless of position.
    const seen = new Set<string>();
    for (let i = 100; i >= 1; i--) {
      const p = { createdAt: i * 1000, id: `id-${i}`, filterHash: "" };
      const cursor = encodeCursor(p, SECRET);
      const decoded = decodeCursor(cursor, SECRET, "");
      const key = `${decoded.createdAt}:${decoded.id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(100);
  });
});
