"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MissionControl = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const TransporterPool_js_1 = require("./TransporterPool.js");
const utils_js_1 = require("./utils.js");
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
class MissionControl {
    redis;
    queue;
    worker;
    pool;
    config;
    constructor(accounts, config) {
        this.config = {
            ...config,
            cooldownMs: config.cooldownMs ?? 15 * 60 * 1000,
            xMailerPrefix: config.xMailerPrefix ?? 'AngrySender-Core-v1',
            listUnsubscribePost: config.listUnsubscribePost ?? 'List-Unsubscribe=One-Click',
        };
        this.redis = new ioredis_1.default(config.redisUrl, { maxRetriesPerRequest: null });
        this.queue = new bullmq_1.Queue(config.queueName, { connection: this.redis });
        this.pool = new TransporterPool_js_1.TransporterPool(accounts, this.config.cooldownMs);
        this.worker = new bullmq_1.Worker(config.queueName, async (job) => this.handleJob(job), {
            connection: this.redis,
            concurrency: 5,
        });
    }
    async enqueueMany(payloads) {
        const jobs = payloads.map((payload, idx) => ({
            name: `mail-${idx}`,
            data: { payload },
            opts: {
                removeOnComplete: 500,
                removeOnFail: 1000,
                attempts: 3,
                backoff: { type: 'exponential', delay: 15_000 },
            },
        }));
        await this.queue.addBulk(jobs);
    }
    async close() {
        await this.worker.close();
        await this.queue.close();
        await this.redis.quit();
    }
    async handleJob(job) {
        const { payload } = job.data;
        const node = this.pool.pickNextNode();
        const account = node.account;
        const transporter = this.pool.getTransporter(account.id);
        const sentByAccount = this.pool.sentCount(account.id);
        const delaySeconds = (0, utils_js_1.currentDelaySeconds)(sentByAccount, this.config.pacing);
        if (delaySeconds > 0) {
            await sleep(delaySeconds * 1000);
        }
        const recipientEmail = payload.recipient.email;
        const msgId = (0, utils_js_1.generateMessageId)(account.fromDomain);
        const entityRef = (0, utils_js_1.generateEntityRefId)(recipientEmail);
        const xMailer = (0, utils_js_1.randomXMailer)(this.config.xMailerPrefix);
        const headers = {
            'Message-ID': msgId,
            'X-Entity-Ref-ID': entityRef,
            'X-Priority': '3',
            Priority: 'normal',
            'X-Mailer': xMailer,
            ...(0, utils_js_1.normalizeUnsubscribeHeaders)(payload.unsubscribeUrl, this.config.listUnsubscribePost),
        };
        const mail = {
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
        }
        catch (err) {
            const e = err;
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
    static buildPayload(recipient, subject, html) {
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
    static generateTraceToken() {
        return node_crypto_1.default.randomUUID();
    }
}
exports.MissionControl = MissionControl;
