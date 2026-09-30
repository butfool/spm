import { describe, expect, it } from "vitest";
import { sanitize } from "../src/log.js";

/**
 * `sanitize` is the output boundary: skill descriptions, frontmatter values,
 * and repository paths are all third-party text, and none of them may carry a
 * terminal control sequence to the user's screen.
 */
describe("sanitize", () => {
  it("removes cursor and erase sequences", () => {
    expect(sanitize("a\u001b[2Kb\u001b[1Gc")).toBe("abc");
  });

  it("removes an OSC window-title sequence", () => {
    expect(sanitize("a\u001b]0;title\u0007b")).toBe("ab");
  });

  it("removes a carriage return, which would overwrite the line", () => {
    expect(sanitize("a\rb")).toBe("ab");
  });

  it("removes a bare escape sequence and other C0 controls", () => {
    // ESC followed by any character is a two-character escape sequence.
    expect(sanitize("a\u001bb")).toBe("a");
    expect(sanitize("a\u0007b\u007fc")).toBe("abc");
    // A trailing ESC with nothing after it is still removed.
    expect(sanitize("a\u001b")).toBe("a");
  });

  it("keeps tab and newline", () => {
    expect(sanitize("a\tb\nc")).toBe("a\tb\nc");
  });

  it("keeps SGR colour codes so spm's own styling survives", () => {
    const styled = "\u001b[1m\u001b[32mok\u001b[39m\u001b[22m";
    expect(sanitize(styled)).toBe(styled);
  });

  it("leaves ordinary text untouched", () => {
    expect(sanitize("plain description")).toBe("plain description");
  });
});
