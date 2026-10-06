/**
 * The e2e stack's mail catcher (infra/docker/docker-compose.e2e-mail.yml):
 * read what LobbyForge sent through Mailpit's HTTP API
 * (https://mailpit.axllent.org/docs/api-v1/).
 *
 *   LF_E2E_MAILPIT_URL  Mailpit's web UI / API (default http://localhost:19626)
 *
 * Every spec uses its own addresses (a run id in the local part), so a
 * search by recipient only ever sees that spec's mail; nothing is deleted
 * that another run might be waiting for.
 */
import { request, type APIRequestContext } from '@playwright/test';

export const MAILPIT_URL = process.env.LF_E2E_MAILPIT_URL ?? 'http://localhost:19626';

export interface MailSummary {
  ID: string;
  Subject: string;
  Created: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
}

export interface Mail extends MailSummary {
  Text: string;
  HTML: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

export class Mailpit {
  private constructor(private readonly api: APIRequestContext) {}

  static async connect(baseURL: string = MAILPIT_URL): Promise<Mailpit> {
    return new Mailpit(await request.newContext({ baseURL }));
  }

  /** Is Mailpit answering at all? */
  async reachable(): Promise<boolean> {
    try {
      return (await this.api.get('/api/v1/info', { timeout: 5_000 })).ok();
    } catch {
      return false;
    }
  }

  /** Every message to `address`, newest first. */
  async inbox(address: string): Promise<MailSummary[]> {
    const res = await this.api.get(`/api/v1/search?limit=50&query=${encodeURIComponent(`to:"${address}"`)}`);
    if (!res.ok()) throw new Error(`mailpit search: HTTP ${res.status()} ${await res.text()}`);
    const body = (await res.json()) as { messages?: MailSummary[] };
    // The search matches substrings; keep exact recipients only.
    return (body.messages ?? []).filter((m) => m.To.some((to) => to.Address.toLowerCase() === address.toLowerCase()));
  }

  async read(id: string): Promise<Mail> {
    const res = await this.api.get(`/api/v1/message/${id}`);
    if (!res.ok()) throw new Error(`mailpit message ${id}: HTTP ${res.status()}`);
    return (await res.json()) as Mail;
  }

  /**
   * The next message to `address` whose subject matches, that is not one of
   * `seen` (ids already handled). Polls until `timeout`.
   */
  async waitFor(
    address: string,
    { subject, seen = new Set<string>(), timeout = 20_000 }: { subject?: RegExp; seen?: Set<string>; timeout?: number } = {}
  ): Promise<Mail> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const match = (await this.inbox(address)).find((m) => !seen.has(m.ID) && (!subject || subject.test(m.Subject)));
      if (match) {
        seen.add(match.ID);
        return this.read(match.ID);
      }
      if (Date.now() > deadline) {
        const got = (await this.inbox(address)).map((m) => m.Subject);
        throw new Error(`no mail to ${address}${subject ? ` matching ${subject}` : ''} within ${timeout} ms (inbox: ${JSON.stringify(got)})`);
      }
      await sleep(400);
    }
  }

  /** How many messages `address` has received. */
  async count(address: string): Promise<number> {
    return (await this.inbox(address)).length;
  }

  /** Delete every message to these addresses (a spec's own clean-up). */
  async deleteFor(addresses: readonly string[]): Promise<void> {
    const ids: string[] = [];
    for (const address of addresses) ids.push(...(await this.inbox(address)).map((m) => m.ID));
    if (ids.length > 0) await this.api.delete('/api/v1/messages', { data: { IDs: ids } });
  }

  async dispose(): Promise<void> {
    await this.api.dispose();
  }
}

/** The 6-digit code of a verify, change-confirm or reset email (its plain-text part). */
export function codeOf(mail: Mail): string {
  const match = /^\s+(\d{6})\s*$/m.exec(mail.Text) ?? /\b(\d{6})\b/.exec(mail.Text);
  if (!match) throw new Error(`no 6-digit code in "${mail.Subject}": ${mail.Text.slice(0, 400)}`);
  return match[1]!;
}

/** The link of a verify, change-confirm or reset email. */
export function linkOf(mail: Mail): string {
  const match = /(https?:\/\/[^\s<>"]+\/(?:verify-email|reset-password)\?t=[A-Za-z0-9_-]+)/.exec(mail.Text);
  if (!match) throw new Error(`no link in "${mail.Subject}": ${mail.Text.slice(0, 400)}`);
  return match[1]!;
}
