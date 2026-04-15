export type AccountProvider = 'gmail' | 'outlook' | 'custom';
export interface Account {
    id: string;
    provider: AccountProvider;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    fromDomain: string;
}
export interface Recipient {
    email: string;
    firstName?: string;
    lastName?: string;
    metadata?: Record<string, string | number | boolean | null>;
}
export interface AttachmentPayload {
    filename: string;
    contentType?: string;
    content?: Buffer;
    path?: string;
}
export interface MailPayload {
    recipient: Recipient;
    subject: string;
    html: string;
    text?: string;
    fromName?: string;
    unsubscribeUrl?: string;
    attachments?: AttachmentPayload[];
}
export interface QueueJobData {
    payload: MailPayload;
}
export interface PacingConfig {
    startSeconds: number;
    missionSeconds: number;
    stepEveryEmails: number;
    stepDownSeconds: number;
}
export interface MissionControlConfig {
    redisUrl: string;
    queueName: string;
    listUnsubscribePost?: string;
    xMailerPrefix?: string;
    cooldownMs?: number;
    pacing: PacingConfig;
}
export interface DeliveryResult {
    ok: boolean;
    accountId: string;
    recipient: string;
    messageId?: string;
    error?: string;
}
