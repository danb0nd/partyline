import { describe, expect, it } from "vitest";
import { sha256Hex, signValue, verifySignedValue } from "../src/crypto";

describe("crypto helpers", () => {
  it("hashes deterministically", async () => {
    const a = await sha256Hex("pl_test");
    const b = await sha256Hex("pl_test");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("signs and verifies session values", async () => {
    const signed = await signValue("ses_abc", "secret");
    expect(await verifySignedValue(signed, "secret")).toBe("ses_abc");
    expect(await verifySignedValue(signed, "other")).toBeNull();
    expect(await verifySignedValue("ses_abc", "secret")).toBeNull();
  });
});
