import type { PacingConfig } from './types.js';
export declare function generateMessageId(domain: string): string;
export declare function generateEntityRefId(recipientEmail: string): string;
export declare function randomXMailer(prefix?: string): string;
/**
 * Returns the inter-send delay in milliseconds for the current staircase
 * position, with a uniformly-distributed jitter of ±0.5 s (range 1.5 s–2.5 s
 * at mission-cruise speed) so every send timestamp is unique.
 */
export declare function currentDelayMs(sentByAccount: number, pacing: PacingConfig, jitterMinMs?: number, jitterMaxMs?: number): number;
/** @deprecated Use currentDelayMs instead. Kept for backward compatibility. */
export declare function currentDelaySeconds(sentByAccount: number, pacing: PacingConfig): number;
export declare function normalizeUnsubscribeHeaders(unsubscribeUrl?: string, postHeader?: string): Record<string, string>;
