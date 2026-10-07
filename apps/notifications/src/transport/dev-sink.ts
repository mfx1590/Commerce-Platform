// The development transport: the email becomes files on disk and a PII-free log line (#360).
//
// `<dir>/<store_code>/<event_id>.html` (what a mail client would show), `.txt` (the plain-text alternative,
// with the subject line on top) and `.json` (the envelope: who it was from and to, which event, when). The
// address IS in the .json and the recipient's name IS in the body — that is the point of a sink you open in a
// browser — which is why the directory is git-ignored and the log line carries neither.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeliveryMeta, RenderedEmail, SendResult, Transport } from '../types.js';

export class DevSinkTransport implements Transport {
  readonly name = 'dev';

  constructor(readonly dir: string) {}

  async send(email: RenderedEmail, meta: DeliveryMeta): Promise<SendResult> {
    const dir = join(this.dir, meta.storeCode);
    await mkdir(dir, { recursive: true });
    const base = join(dir, meta.eventId);
    await writeFile(`${base}.html`, email.html, 'utf8');
    await writeFile(`${base}.txt`, `Subject: ${email.subject}\n\n${email.text}`, 'utf8');
    await writeFile(
      `${base}.json`,
      JSON.stringify(
        {
          ...meta,
          from: email.from,
          to: email.to,
          replyTo: email.replyTo,
          subject: email.subject,
          writtenAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
    return { providerMessageId: `dev:${meta.eventId}` };
  }
}
