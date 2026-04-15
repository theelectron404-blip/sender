import type { PacingConfig } from './types.js';
export declare function generateMessageId(domain: string): string;
export declare function generateEntityRefId(recipientEmail: string): string;
export declare function randomXMailer(prefix?: string): string;
export declare function currentDelaySeconds(sentByAccount: number, pacing: PacingConfig): number;
export declare function normalizeUnsubscribeHeaders(unsubscribeUrl?: string, postHeader?: string): Record<string, string>;
