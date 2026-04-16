import crypto from 'node:crypto';
import type { PacingConfig } from './types.js';

export function generateMessageId(domain: string): string {
  const uuidPart = crypto.randomUUID().replace(/-/g, '');
  const tsBase36 = Date.now().toString(36);
  return `<${uuidPart}.${tsBase36}@${domain}>`;
}

export function generateEntityRefId(recipientEmail: string): string {
  const nonce = crypto.randomBytes(8).toString('hex');
  const raw = `${recipientEmail}|${Date.now()}|${nonce}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function randomXMailer(prefix = 'AngrySender-Core-v1'): string {
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${prefix}/${suffix}`;
}

/**
 * Returns the inter-send delay in milliseconds for the current staircase
 * position, with a uniformly-distributed jitter of ±0.5 s (range 1.5 s–2.5 s
 * at mission-cruise speed) so every send timestamp is unique.
 */
export function currentDelayMs(
  sentByAccount: number,
  pacing: PacingConfig,
  jitterMinMs = 1500,
  jitterMaxMs = 2500,
): number {
  const steps = Math.floor(sentByAccount / Math.max(1, pacing.stepEveryEmails));
  const staircaseSeconds =
    sentByAccount <= 0
      ? pacing.startSeconds
      : Math.max(pacing.missionSeconds, pacing.startSeconds - steps * pacing.stepDownSeconds);

  // Uniform jitter in [jitterMinMs, jitterMaxMs]
  const jitter = jitterMinMs + Math.random() * (jitterMaxMs - jitterMinMs);

  // The staircase provides the baseline pace; jitter replaces fixed millisecond
  // sleep so the actual inter-send gap is staircaseSeconds*1000 ± jitter.
  return Math.round(staircaseSeconds * 1000 + jitter);
}

/** @deprecated Use currentDelayMs instead. Kept for backward compatibility. */
export function currentDelaySeconds(sentByAccount: number, pacing: PacingConfig): number {
  if (sentByAccount <= 0) return pacing.startSeconds;
  const steps = Math.floor(sentByAccount / Math.max(1, pacing.stepEveryEmails));
  const candidate = pacing.startSeconds - steps * pacing.stepDownSeconds;
  return Math.max(pacing.missionSeconds, candidate);
}

export function normalizeUnsubscribeHeaders(unsubscribeUrl?: string, postHeader?: string): Record<string, string> {
  if (!unsubscribeUrl) return {};
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': postHeader || 'List-Unsubscribe=One-Click',
  };
}