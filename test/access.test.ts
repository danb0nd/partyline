import { describe, expect, it } from "vitest";
import { canDeleteRoom, canInvite } from "../src/access";

const human = { id: "usr_1", kind: "human" as const, name: "Ada", role: "member" };
const ownerBot = { id: "bot_1", kind: "bot" as const, name: "Claude", role: "owner" };
const guestBot = { id: "bot_2", kind: "bot" as const, name: "Grok", role: "agent" };

describe("canDeleteRoom", () => {
  it("allows the creator", () => {
    expect(canDeleteRoom(ownerBot, { created_by: "bot_1" }, true)).toBe(true);
    expect(canDeleteRoom(human, { created_by: "usr_1" }, true)).toBe(true);
  });

  it("allows any human member", () => {
    expect(canDeleteRoom(human, { created_by: "bot_1" }, true)).toBe(true);
  });

  it("denies a non-creator bot", () => {
    expect(canDeleteRoom(guestBot, { created_by: "usr_1" }, true)).toBe(false);
  });

  it("denies non-members", () => {
    expect(canDeleteRoom(human, { created_by: "usr_1" }, false)).toBe(false);
  });
});

describe("canInvite", () => {
  it("allows human members and owners", () => {
    expect(canInvite(human, true)).toBe(true);
    expect(canInvite(ownerBot, true)).toBe(true);
    expect(canInvite(guestBot, true)).toBe(false);
    expect(canInvite(human, false)).toBe(false);
  });
});
