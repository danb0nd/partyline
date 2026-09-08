import { describe, expect, it } from "vitest";
import { MAX_BYTES, mediaKey, parseMediaKey, sniffType } from "../src/media";

describe("media helpers", () => {
  it("sniffs allowed types and extensions", () => {
    expect(sniffType("image/png", "x")).toBe("image/png");
    expect(sniffType("application/octet-stream", "notes.md")).toBe("text/markdown");
    expect(sniffType("text/plain", "log.txt")).toBe("text/plain");
    expect(sniffType("application/x-msdownload", "evil.exe")).toBeNull();
  });

  it("builds and parses room-scoped keys", () => {
    const key = mediaKey("rm_abc", "obj_1", "png");
    expect(key).toBe("room/rm_abc/obj_1.png");
    expect(parseMediaKey(key)).toEqual({ roomId: "rm_abc" });
    expect(parseMediaKey("other/x")).toBeNull();
  });

  it("caps uploads at 8MB", () => {
    expect(MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});
