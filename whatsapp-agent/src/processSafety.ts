/**
 * Process-level safety nets.
 *
 * Nothing here overrode Node's defaults, so a single stray promise rejection anywhere in the
 * app took the entire bot down. The live outage this addresses looked nothing like a crash from
 * the outside: Fi answered a message normally, then went completely silent — including to
 * "start", which is the very first branch of the message handler and does no I/O before
 * replying. Nothing was wrong with any conversation; the process was simply gone, and stayed
 * gone, with no stack trace to say why.
 *
 * The two cases are treated differently on purpose:
 *
 *  - An unhandled REJECTION is almost always a stray promise on a background path (a fetch, a
 *    fire-and-forget send). The process state is intact, so taking the whole bot offline is a
 *    far worse outcome than the rejection itself. Log it with a full stack and keep serving.
 *  - An uncaught EXCEPTION unwound a synchronous stack at an arbitrary point and can leave state
 *    genuinely inconsistent. Log it with a full stack, then exit non-zero so the platform
 *    restarts cleanly — a fast restart beats a process left in an unknown state.
 *
 * Either way the stack reaches the logs, which is what was missing.
 */

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function handleUnhandledRejection(reason: unknown, log: (msg: string) => void = console.error): void {
  log(`[process] unhandled promise rejection — staying up so the bot keeps answering:\n${describe(reason)}`);
}

export function handleUncaughtException(
  error: unknown,
  log: (msg: string) => void = console.error,
  exit: (code: number) => void = process.exit as (code: number) => void
): void {
  log(`[process] uncaught exception — exiting for a clean restart:\n${describe(error)}`);
  exit(1);
}

/** Registers both handlers. Idempotent, so repeated calls cannot stack duplicate listeners. */
export function installProcessSafetyNets(): void {
  if (process.listenerCount("unhandledRejection") === 0) {
    process.on("unhandledRejection", (reason) => handleUnhandledRejection(reason));
  }
  if (process.listenerCount("uncaughtException") === 0) {
    process.on("uncaughtException", (error) => handleUncaughtException(error));
  }
}
