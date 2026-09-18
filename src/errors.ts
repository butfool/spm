/**
 * A user-facing error: something the caller did wrong, or something the
 * environment couldn't satisfy. The CLI prints `message` and, when present,
 * `hint` as a follow-up suggestion. Never a bug — bugs should throw plain
 * Errors so they surface with a stack trace.
 */
export class SpmError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "SpmError";
    this.hint = hint;
  }
}
