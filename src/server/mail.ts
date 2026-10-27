import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import type { AppConfig } from "./config";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text only: no HTML that a phishing e-mail could imitate. */
  text: string;
  attachments?: MailAttachment[];
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Keeps messages in memory — used by the test suite. */
export class MemoryMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  async send(message: MailMessage) {
    this.messages.push(message);
  }
  to(address: string) {
    return this.messages.filter((m) => m.to === address);
  }
  last(address: string) {
    const list = this.to(address);
    return list[list.length - 1];
  }
}

export function createMailer(config: AppConfig): Mailer {
  const from = config.mail.from;
  switch (config.mail.transport) {
    case "smtp": {
      const transport = nodemailer.createTransport(config.mail.smtpUrl!);
      return {
        async send(m) {
          await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, attachments: m.attachments });
        },
      };
    }
    case "file": {
      // One JSON file per message: handy in development and for end-to-end tests.
      const dir = path.join(config.dataDir, "outbox");
      fs.mkdirSync(dir, { recursive: true });
      return {
        async send(m) {
          const name = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
          const record = {
            from,
            to: m.to,
            subject: m.subject,
            text: m.text,
            attachments: (m.attachments ?? []).map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              size: a.content.length,
            })),
          };
          fs.writeFileSync(path.join(dir, name), JSON.stringify(record, null, 2), { mode: 0o600 });
        },
      };
    }
    case "console":
      return {
        async send(m) {
          console.info(`[mail] to=${m.to} subject=${JSON.stringify(m.subject)}\n${m.text}`);
        },
      };
  }
}
