import crypto from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import type { SendMailOptions } from 'nodemailer';
import { TransporterPool } from './TransporterPool.js';
import {
  currentDelaySeconds,
  generateEntityRefId,
  generateMessageId,
  normalizeUnsubscribeHeaders,
  randomXMailer,
} from './utils.js';
import type {
  Account,
  DeliveryResult,
  MailPayload,
  MissionControlConfig,
  QueueJobData,
} from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MissionControl {
  private readonly redis;
  private readonly queue: Queue<QueueJobData>;
  private readonly worker: Worker<QueueJobData, DeliveryResult>;
  private readonly pool: TransporterPool;
  private readonly config: MissionControlConfig;

  constructor(accounts: Account[], config: MissionControlConfig) {
    this.config = {
      ...config,
      cooldownMs: config.cooldownMs ?? 15 * 60 * 1000,
      xMailerPrefix: config.xMailerPrefix ?? 'AngrySender-Core-v1',
      listUnsubscribePost: config.listUnsubscribePost ?? 'List-Unsubscribe=One-Click',
    };
    this.redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<QueueJobData>(config.queueName, { connection: this.redis });
    this.pool = new TransporterPool(accounts, this.config.cooldownMs);

    this.worker = new Worker<QueueJobData, DeliveryResult>(
      config.queueName,
      async (job) => this.handleJob(job),
      {
        connection: this.redis,
        concurrency: 5,
      },
    );
  }

  public async enqueueMany(payloads: MailPayload[]): Promise<void> {
    const jobs = payloads.map((payload, idx) => ({
      name: `mail-${idx}`,
      data: { payload },
      opts: {
        removeOnComplete: 500,
        removeOnFail: 1000,
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 15_000 },
      },
    }));
    await this.queue.addBulk(jobs);
  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await this.redis.quit();
  }

  private async handleJob(job: Job<QueueJobData>): Promise<DeliveryResult> {
    const { payload } = job.data;
    const node = this.pool.pickNextNode();
    const account = node.account;
    const transporter = this.pool.getTransporter(account.id);

    const sentByAccount = this.pool.sentCount(account.id);
    const delaySeconds = currentDelaySeconds(sentByAccount, this.config.pacing);
    if (delaySeconds > 0) {
      await sleep(delaySeconds * 1000);
    }

    const recipientEmail = payload.recipient.email;
    const msgId = generateMessageId(account.fromDomain);
    const entityRef = generateEntityRefId(recipientEmail);
    const xMailer = randomXMailer(this.config.xMailerPrefix);

    const headers: Record<string, string> = {
      'Message-ID': msgId,
      'X-Entity-Ref-ID': entityRef,
      'X-Priority': '3',
      Priority: 'normal',
      'X-Mailer': xMailer,
      ...normalizeUnsubscribeHeaders(payload.unsubscribeUrl, this.config.listUnsubscribePost),
    };

    const mail: SendMailOptions = {
      from: payload.fromName
        ? `"${payload.fromName.replace(/"/g, '\\"')}" <${account.user}>`
        : account.user,
      to: recipientEmail,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      attachments: payload.attachments,
      headers,
      messageId: msgId,
    };

    try {
      const info = await transporter.sendMail(mail);
      this.pool.markSent(account.id);
      return {
        ok: true,
        accountId: account.id,
        recipient: recipientEmail,
        messageId: info.messageId,
      };
    } catch (err) {
      const e = err as { responseCode?: number; message?: string };
      if (e.responseCode === 421 || e.responseCode === 454) {
        this.pool.markRateLimited(account.id);
      }
      return {
        ok: false,
        accountId: account.id,
        recipient: recipientEmail,
        error: e.message || 'send failed',
      };
    }
  }

  public static buildPayload(recipient: string, subject: string, html: string): MailPayload {
    return {
      recipient: { email: recipient },
      subject,
      html,
      text: html.replace(/<[^>]+>/g, ' '),
      fromName: 'Transactional Service',
      unsubscribeUrl: undefined,
      attachments: [],
    };
  }

  public static generateTraceToken(): string {
    return crypto.randomUUID();
  }
}