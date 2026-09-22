import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { askName, type NameQuestion } from "../src/cli/prompt.js";

const LABEL = "Register the repository as";

function question(check: NameQuestion["check"], fallback = "Obsidian"): NameQuestion {
  return { label: LABEL, fallback, check };
}

/**
 * A stand-in for a terminal with a person behind it.
 *
 * Each answer is handed over only after the question asking for it has been
 * shown, because that is what a terminal does. Feeding every line at once
 * would let readline swallow the answers that arrive while no question is
 * pending. When the lines run out the input ends, the way Ctrl-D ends a real
 * one.
 */
function terminal(lines: string[]): {
  input: PassThrough;
  output: Writable;
  text: () => string;
} {
  const input = new PassThrough();
  let collected = "";
  let fed = 0;

  const feed = (): void => {
    if (fed < lines.length) input.write(lines[fed++]!);
    else input.end();
  };

  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString("utf8");
      collected += text;
      if (text.includes(LABEL)) feed();
      callback();
    },
  });

  return { input, output, text: () => collected };
}

describe("askName", () => {
  it("takes the fallback when the answer is empty", async () => {
    const tty = terminal(["\n"]);

    const name = await askName(question(() => null), {
      input: tty.input,
      output: tty.output,
    });

    expect(name).toBe("Obsidian");
    expect(tty.text()).toContain("[Obsidian]");
  });

  it("takes the name the user types instead of the fallback", async () => {
    const tty = terminal(["notes\n"]);

    const name = await askName(question(() => null), {
      input: tty.input,
      output: tty.output,
    });

    expect(name).toBe("notes");
  });

  it("asks again when the answer is refused", async () => {
    const tty = terminal(["mine\n", "notes\n"]);
    const asked: string[] = [];

    const name = await askName(
      question((candidate) => {
        asked.push(candidate);
        return candidate === "mine" ? '"mine" is already registered' : null;
      }),
      { input: tty.input, output: tty.output },
    );

    expect(name).toBe("notes");
    expect(asked).toEqual(["mine", "notes"]);
    expect(tty.text()).toContain('"mine" is already registered');
  });

  it("refuses the fallback too, so a taken name cannot be confirmed away", async () => {
    const tty = terminal(["\n", "\n", "notes\n"]);
    const asked: string[] = [];

    const name = await askName(
      question((candidate) => {
        asked.push(candidate);
        return candidate === "mine" ? '"mine" is already registered' : null;
      }, "mine"),
      { input: tty.input, output: tty.output },
    );

    expect(name).toBe("notes");
    expect(asked).toEqual(["mine", "mine", "notes"]);
  });

  it("trims the answer, so a stray space is not part of the name", async () => {
    const tty = terminal(["  notes  \n"]);

    const name = await askName(question(() => null), {
      input: tty.input,
      output: tty.output,
    });

    expect(name).toBe("notes");
  });

  it("fails when the input ends without an acceptable name", async () => {
    const tty = terminal(["\n"]);

    await expect(
      askName(question(() => '"mine" is already registered', "mine"), {
        input: tty.input,
        output: tty.output,
      }),
    ).rejects.toThrow(/no name was given/);
  });
});
