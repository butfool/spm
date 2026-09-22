import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import pc from "picocolors";
import { SpmError } from "../errors.js";

/** Whether there is a user on the other end who can answer a question. */
export function canPrompt(): boolean {
  return process.stdin.isTTY === true;
}

export interface NameQuestion {
  /** The sentence the answer completes, without the question mark. */
  label: string;
  /** What an empty answer means. */
  fallback: string;
  /** Why the name cannot be used, or null when it can. */
  check: (name: string) => string | null;
}

/** Where a question reads from and writes to. Defaults to the terminal. */
export interface PromptIo {
  input?: (Readable & { isTTY?: boolean | undefined }) | undefined;
  output?: (Writable & { isTTY?: boolean | undefined }) | undefined;
}

/**
 * Asks for a name until the answer is one the caller accepts.
 *
 * An empty answer takes the fallback. When the fallback itself is refused the
 * user has to type something else, which is the whole point of asking: a name
 * is how every project refers to the directory, so a taken one cannot be
 * confirmed away.
 */
export async function askName(
  question: NameQuestion,
  io: PromptIo = {},
): Promise<string> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = readline.createInterface({
    input,
    output,
    terminal: input.isTTY === true && output.isTTY === true,
  });
  // Ctrl-C, Ctrl-D and a stream running out of lines all close the interface.
  // The flag is what turns that into one answer-shaped error.
  const session = { closed: false };
  rl.on("close", () => {
    session.closed = true;
  });

  try {
    for (;;) {
      const prompt =
        `${pc.cyan("?")} ${question.label} ${pc.dim(`[${question.fallback}]`)} `;
      const answer = (await readAnswer(rl, prompt, session)).trim();
      const name = answer === "" ? question.fallback : answer;

      const problem = question.check(name);
      if (problem === null) return name;
      output.write(`  ${pc.red("✗")} ${problem}\n`);
    }
  } finally {
    rl.close();
  }
}

/** Whether the user can still answer, as far as readline is concerned. */
interface Session {
  closed: boolean;
}

/**
 * One line from the user, rejecting when the input ends instead of answering.
 *
 * `readline.question` never calls back on a closed interface and throws when it
 * is asked anyway, so a session that has ended is reported as the missing
 * answer it is rather than as a readline state the user never chose.
 */
function readAnswer(
  rl: readline.Interface,
  prompt: string,
  session: Session,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const giveUp = (): void => {
      reject(new SpmError("no name was given"));
    };

    if (session.closed) {
      giveUp();
      return;
    }

    rl.once("close", giveUp);
    rl.question(prompt, (answer) => {
      rl.off("close", giveUp);
      resolve(answer);
    });
  });
}
