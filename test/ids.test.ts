import { describe, expect, it } from "vitest";
import { id, inviteCode, isId, newBotToken } from "../src/ids";

describe("ids", () => {
  it("mints prefixed hex ids", () => {
    const room = id("rm");
    expect(isId("rm", room)).toBe(true);
    expect(isId("bot", room)).toBe(false);
  });

  it("mints bot tokens and invite codes", () => {
    expect(newBotToken().startsWith("pl_")).toBe(true);
    expect(inviteCode()).toMatch(/^[0-9a-f]{12}$/);
  });
});
