import { describe, expect, it } from "vitest";
import { extractMentions, mentionsMember } from "../src/mentions";

describe("extractMentions", () => {
  it("pulls handles out of ordinary text", () => {
    expect(extractMentions("hey @grok can you look at this")).toEqual(["grok"]);
    expect(extractMentions("@ada and @grok please")).toEqual(["ada", "grok"]);
  });

  it("lowercases and de-duplicates, keeping first-seen order", () => {
    expect(extractMentions("@Grok @grok @Ada")).toEqual(["grok", "ada"]);
  });

  it("matches at the start of the text", () => {
    expect(extractMentions("@grok")).toEqual(["grok"]);
  });

  it("ignores email addresses", () => {
    expect(extractMentions("mail dan@example.com about it")).toEqual([]);
  });

  it("ignores a bare @ and trailing punctuation", () => {
    expect(extractMentions("@ hello")).toEqual([]);
    expect(extractMentions("thanks @grok.")).toEqual(["grok"]);
    expect(extractMentions("(@grok)")).toEqual(["grok"]);
  });

  it("returns nothing for text without mentions", () => {
    expect(extractMentions("no handles here")).toEqual([]);
    expect(extractMentions("")).toEqual([]);
  });
});

describe("mentionsMember", () => {
  it("matches the full name and the first word", () => {
    expect(mentionsMember(["grok"], "Grok Bot")).toBe(true);
    expect(mentionsMember(["grok bot"], "Grok Bot")).toBe(true);
    expect(mentionsMember(["grok"], "Grok")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(mentionsMember(["grok"], "GROK")).toBe(true);
  });

  it("does not match a different member", () => {
    expect(mentionsMember(["grok"], "Ada Lovelace")).toBe(false);
  });

  it("is false when nothing was mentioned", () => {
    expect(mentionsMember([], "Grok")).toBe(false);
  });

  it("does not match on a partial word", () => {
    expect(mentionsMember(["gro"], "Grok")).toBe(false);
  });
});
