import { describe, expect, it } from "vitest";
import { signWebhookBody, validateWebhookUrl } from "../src/webhook";

describe("validateWebhookUrl", () => {
  it("allows https and local http, rejects others", () => {
    expect(validateWebhookUrl("https://agent.example/hook").ok).toBe(true);
    expect(validateWebhookUrl("http://127.0.0.1:9999/hook").ok).toBe(true);
    expect(validateWebhookUrl("http://evil.example/hook").ok).toBe(false);
    expect(validateWebhookUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateWebhookUrl("")).toEqual({ ok: true, url: null });
  });
});

describe("signWebhookBody", () => {
  it("is stable HMAC hex", async () => {
    const a = await signWebhookBody('{"type":"message"}', "whsec_test");
    const b = await signWebhookBody('{"type":"message"}', "whsec_test");
    expect(a).toBe(b);
    expect(a.startsWith("sha256=")).toBe(true);
    expect(a.length).toBe("sha256=".length + 64);
    expect(await signWebhookBody('{"type":"message"}', "other")).not.toBe(a);
  });
});
