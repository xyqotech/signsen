import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";

export interface OutboxMessage {
  file: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: { filename: string; contentType: string; size: number }[];
}

/**
 * Reads the e-mails the application really sent (MAIL_TRANSPORT=file writes one
 * JSON file per message). Tests wait for a message instead of sleeping.
 */
export class Mailbox {
  constructor(private readonly dir: string) {}

  messagesTo(address: string): OutboxMessage[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((file) => ({ file, ...JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) }) as OutboxMessage)
      .filter((m) => m.to === address.toLowerCase());
  }

  async waitFor(address: string, match: (m: OutboxMessage) => boolean, options: { after?: number; timeout?: number } = {}) {
    let found: OutboxMessage | undefined;
    await expect
      .poll(
        () => {
          found = this.messagesTo(address)
            .slice(options.after ?? 0)
            .filter(match)
            .pop();
          return found !== undefined;
        },
        { timeout: options.timeout ?? 15_000, message: `no matching e-mail for ${address}` },
      )
      .toBe(true);
    return found!;
  }

  /** The personal signing link of the latest invitation sent to this address. */
  async invitationLink(address: string): Promise<string> {
    const mail = await this.waitFor(address, (m) => /\/s\/[A-Za-z0-9_-]{43}/.test(m.text));
    return mail.text.match(/https?:\/\/\S+\/s\/[A-Za-z0-9_-]{43}/)![0];
  }

  /** The password reset link of the latest reset e-mail sent to this address. */
  async resetLink(address: string): Promise<string> {
    const mail = await this.waitFor(address, (m) => /\/reset\/[A-Za-z0-9_-]{43}/.test(m.text));
    return mail.text.match(/https?:\/\/\S+\/reset\/[A-Za-z0-9_-]{43}/)![0];
  }

  /** Waits for a one-time code mailed after `after` messages, and returns it. */
  async nextCode(address: string, after: number): Promise<string> {
    const mail = await this.waitFor(address, (m) => /^(Votre code|Your code)/.test(m.subject), { after });
    return mail.subject.match(/(\d{6})/)![1];
  }
}
