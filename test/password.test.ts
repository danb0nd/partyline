import { describe, expect, it } from "vitest";
import { hashPassword, validatePassword, verifyPassword } from "../src/password";

describe("password hashing", () => {
  it("rejects short passwords", () => {
    expect(validatePassword("abc")).toBeTruthy();
    expect(validatePassword("longenough")).toBeNull();
  });

  it("hashes with PBKDF2 and verifies", async () => {
    const stored = await hashPassword("correct horse", 1_000);
    expect(stored.startsWith("pbkdf2-sha256$1000$")).toBe(true);
    expect(await verifyPassword("correct horse", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
    expect(await verifyPassword("correct horse", "not-a-hash")).toBe(false);
  });
});
