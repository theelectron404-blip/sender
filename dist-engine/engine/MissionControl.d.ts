import type { Account, MailPayload, MissionControlConfig } from './types.js';
export declare class MissionControl {
    private readonly redis;
    private readonly queue;
    private readonly worker;
    private readonly pool;
    private readonly config;
    constructor(accounts: Account[], config: MissionControlConfig);
    enqueueMany(payloads: MailPayload[]): Promise<void>;
    close(): Promise<void>;
    private handleJob;
    static buildPayload(recipient: string, subject: string, html: string): MailPayload;
    static generateTraceToken(): string;
}
