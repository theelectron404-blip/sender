"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransporterPool = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
class TransporterPool {
    nodes;
    cursor = 0;
    cooldownMs;
    constructor(accounts, cooldownMs = 15 * 60 * 1000) {
        if (!accounts.length) {
            throw new Error('TransporterPool requires at least one account.');
        }
        this.cooldownMs = cooldownMs;
        this.nodes = accounts.map((account) => ({
            account,
            transporter: nodemailer_1.default.createTransport(this.toTransportOptions(account)),
            cooldownUntil: 0,
            sentCount: 0,
        }));
    }
    toTransportOptions(account) {
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
            tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        };
    }
    pickNextNode(now = Date.now()) {
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
    markSent(accountId) {
        const node = this.nodes.find((x) => x.account.id === accountId);
        if (node)
            node.sentCount += 1;
    }
    markRateLimited(accountId, now = Date.now()) {
        const node = this.nodes.find((x) => x.account.id === accountId);
        if (!node)
            return;
        node.cooldownUntil = now + this.cooldownMs;
    }
    sentCount(accountId) {
        return this.nodes.find((x) => x.account.id === accountId)?.sentCount ?? 0;
    }
    accountIds() {
        return this.nodes.map((x) => x.account.id);
    }
    getTransporter(accountId) {
        const node = this.nodes.find((x) => x.account.id === accountId);
        if (!node)
            throw new Error(`Unknown account: ${accountId}`);
        return node.transporter;
    }
    getAccount(accountId) {
        const node = this.nodes.find((x) => x.account.id === accountId);
        if (!node)
            throw new Error(`Unknown account: ${accountId}`);
        return node.account;
    }
}
exports.TransporterPool = TransporterPool;
