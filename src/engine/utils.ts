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