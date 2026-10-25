// A configuration refusal: the process cannot run as configured, and restarting it will not help.
//
// It exists for two reasons, both learned the hard way:
//   * the entry point prints the CLASS of an error and not its message, because a message can carry a
//     webhook URL, a write key or the row being handled. A refusal built HERE, out of environment variable
//     names and values this repository chose (group ids, store codes, mode names), is safe to print — and an
//     operator who is told "ENGAGEMENT_DLQ_GROUPS does not watch engagement.cdp.int4" can act, where
//     `error_class: "Error"` leaves them guessing (#590);
//   * it exits **2**, not 1. A supervisor that restarts on a crash should NOT restart on a configuration it
//     has already refused: the same environment will be refused again, forever, and the restart loop hides
//     the message. 1 stays what it always was — something went wrong at runtime.
//
// So: never put a payload, a secret, an e-mail address or anything a customer typed into one of these
// messages. The whole class is printable only because that rule holds.

export class ConfigRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigRefusedError';
  }
}

/** The exit code every configuration refusal uses. */
export const CONFIG_REFUSED_EXIT = 2;
