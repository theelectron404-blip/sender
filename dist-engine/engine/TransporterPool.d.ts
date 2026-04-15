import { type Transporter } from 'nodemailer';
import type { Account } from './types.js';
interface PoolNode {
    account: Account;
    transporter: Transporter;
    cooldownUntil: number;
    sentCount: number;
}
export declare class TransporterPool {
    private readonly nodes;
    private cursor;
    private readonly cooldownMs;
    constructor(accounts: Account[], cooldownMs?: number);
    private toTransportOptions;
    pickNextNode(now?: number): PoolNode;
    markSent(accountId: string): void;
    markRateLimited(accountId: string, now?: number): void;
    sentCount(accountId: string): number;
    accountIds(): string[];
    getTransporter(accountId: string): Transporter;
    getAccount(accountId: string): Account;
}
export {};
