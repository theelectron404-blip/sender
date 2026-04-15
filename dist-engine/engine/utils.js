"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateMessageId = generateMessageId;
exports.generateEntityRefId = generateEntityRefId;
exports.randomXMailer = randomXMailer;
exports.currentDelaySeconds = currentDelaySeconds;
exports.normalizeUnsubscribeHeaders = normalizeUnsubscribeHeaders;
const node_crypto_1 = __importDefault(require("node:crypto"));
function generateMessageId(domain) {
    const uuidPart = node_crypto_1.default.randomUUID().replace(/-/g, '');
    const tsBase36 = Date.now().toString(36);
    return `<${uuidPart}.${tsBase36}@${domain}>`;
}
function generateEntityRefId(recipientEmail) {
    const nonce = node_crypto_1.default.randomBytes(8).toString('hex');
    const raw = `${recipientEmail}|${Date.now()}|${nonce}`;
    return Buffer.from(raw, 'utf8').toString('base64url');
}
function randomXMailer(prefix = 'AngrySender-Core-v1') {
    const suffix = node_crypto_1.default.randomBytes(3).toString('hex');
    return `${prefix}/${suffix}`;
}
function currentDelaySeconds(sentByAccount, pacing) {
    if (sentByAccount <= 0)
        return pacing.startSeconds;
    const steps = Math.floor(sentByAccount / Math.max(1, pacing.stepEveryEmails));
    const candidate = pacing.startSeconds - steps * pacing.stepDownSeconds;
    return Math.max(pacing.missionSeconds, candidate);
}
function normalizeUnsubscribeHeaders(unsubscribeUrl, postHeader) {
    if (!unsubscribeUrl)
        return {};
    return {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': postHeader || 'List-Unsubscribe=One-Click',
    };
}
