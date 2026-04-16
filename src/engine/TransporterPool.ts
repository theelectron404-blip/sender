import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import type { Account } from './types.js';

interface PoolNode {
  account: Account;
  transporter: Transporter;
  cooldownUntil: number;
  sentCount: number;
}

export class TransporterPool {
  private readonly nodes: PoolNode[];
  private cursor = 0;
  private readonly cooldownMs: number;

  constructor(accounts: Account[], cooldownMs = 15 * 60 * 1000) {
    if (!accounts.length) {
      throw new Error('TransporterPool requires at least one account.');
    }
    this.cooldownMs = cooldownMs;
    this.nodes = accounts.map((account) => ({
      account,
      transporter: nodemailer.createTransport(this.toTransportOptions(account)),
      cooldownUntil: 0,
      sentCount: 0,
    }));
  }

  private toTransportOptions(account: Account): SMTPPool.Options {
    const useOAuth2 = !!(account.clientId && account.clientSecret && account.refreshToken);
    return {
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: useOAuth2
        ? {
            type: 'OAuth2',
            user: account.user,
            clientId: account.clientId,
            clientSecret: account.clientSecret,
            refreshToken: account.refreshToken,
          }
        : { user: account.user, pass: account.pass },
      // RFC 5321 persistent connections: nodemailer reuses a single TCP/TLS
      // session for multiple messages rather than opening a new connection per
      // send. maxConnections caps the pool per account; maxMessages prevents
      // a single long-lived connection from accumulating too many sends before
      // being recycled (reduces greylisting risk on major providers).
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    };
  }

  public pickNextNode(now = Date.now()): PoolNode {
    const n = this.nodes.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const node = this.nodes[idx];
      if (node.cooldownUntil <= now) {
        this.cursor = (idx + 1) % n;
        return node;
      }
    }
    throw new Error('All SMTP accounts are cooling down.');
  }

  public markSent(accountId: string): void {
    const node = this.nodes.find((x) => x.account.id === accountId);
    if (node) node.sentCount += 1;
  }

  public markRateLimited(accountId: string, now = Date.now()): void {
    const node = this.nodes.find((x) => x.account.id === accountId);
    if (!node) return;
    node.cooldownUntil = now + this.cooldownMs;
  }

  public sentCount(accountId: string): number {
    return this.nodes.find((x) => x.account.id === accountId)?.sentCount ?? 0;
  }

  public accountIds(): string[] {
    return this.nodes.map((x) => x.account.id);
  }

  public getTransporter(accountId: string): Transporter {
    const node = this.nodes.find((x) => x.account.id === accountId);
    if (!node) throw new Error(`Unknown account: ${accountId}`);
    return node.transporter;
  }

  public getAccount(accountId: string): Account {
    const node = this.nodes.find((x) => x.account.id === accountId);
    if (!node) throw new Error(`Unknown account: ${accountId}`);
    return node.account;
  }
}