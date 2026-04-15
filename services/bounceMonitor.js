/**
 * Reputation Guard — Automated Bounce Monitor.
 *
 * Scans the Inbox of each configured IMAP account every 30 minutes, looking
 * for Delivery Status Notification (DSN / NDR) failure messages. Confirmed
 * bounced addresses are appended to blacklist.json. The main send loop reads
 * this file before every send and skips blacklisted recipients.
 *
 * Processed DSN messages are marked \Seen so they are not re-scanned on the
 * next interval, preventing duplicate blacklist entries.
 */

const { ImapFlow } = require('imapflow');
const fs            = require('fs');
const path          = require('path');

const BLACKLIST_PATH     = path.join(__dirname, '..', 'blacklist.json');
const IMAP_ACCOUNTS_PATH = path.join(__dirname, '..', 'imap-accounts.json');
const INTERVAL_MS        = 30 * 60 * 1000; // 30 minutes

// Subject substrings that identify DSN failure messages (case-insensitive)
const DSN_PATTERNS = [
    'delivery status notification',
    'undeliverable',
    'mail delivery failed',
    'returned mail',
    'failure notice',
    'delivery failure',
    'mail delivery failure',
    'non-delivery',
    'non deliverable',
    'message not delivered',
    'returned to sender',
];

// ── Blacklist helpers ────────────────────────────────────────────────────────

function loadBlacklist() {
    try {
        if (fs.existsSync(BLACKLIST_PATH)) {
            const raw = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf8'));
            return new Set(Array.isArray(raw) ? raw.map(e => e.toLowerCase()) : []);
        }
    } catch {}
    return new Set();
}

function saveBlacklist(set) {
    fs.writeFileSync(BLACKLIST_PATH, JSON.stringify([...set].sort(), null, 2), 'utf8');
}

function loadImapAccounts() {
    try {
        if (fs.existsSync(IMAP_ACCOUNTS_PATH)) {
            return JSON.parse(fs.readFileSync(IMAP_ACCOUNTS_PATH, 'utf8'));
        }
    } catch {}
    return [];
}

// ── DSN address extraction ───────────────────────────────────────────────────

/**
 * Extract the bounced recipient address from raw DSN message bytes.
 *
 * Priority order:
 *   1. RFC-3464 Final-Recipient field  (authoritative, most precise)
 *   2. X-Failed-Recipients header       (common in Postfix / cPanel MTAs)
 */
function extractBounced(source) {
    const text = source.toString('utf8');

    const finalRecipient = text.match(
        /Final-Recipient:\s*rfc822;\s*<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/i
    );
    if (finalRecipient) return [finalRecipient[1].toLowerCase()];

    const xFailed = text.match(/X-Failed-Recipients:\s*([^\r\n]+)/i);
    if (xFailed) {
        const emails = xFailed[1].match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g);
        if (emails) return emails.map(e => e.toLowerCase());
    }

    return [];
}

// ── Per-account scanner ──────────────────────────────────────────────────────

async function scanAccount(account, io) {
    const client = new ImapFlow({
        host:   account.host,
        port:   parseInt(account.port, 10) || 993,
        secure: account.secure !== false,
        auth:   { user: account.user, pass: account.pass },
        logger: false,
    });

    let totalAdded = 0;

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');

        try {
            const blacklist = loadBlacklist();
            const uids = await client.search({ seen: false }, { uid: true });

            for (const uid of uids) {
                const msg = await client.fetchOne(
                    String(uid),
                    { uid: true, envelope: true, source: true },
                    { uid: true }
                );
                if (!msg) continue;

                const subject = (msg.envelope?.subject || '').toLowerCase();
                if (!DSN_PATTERNS.some(p => subject.includes(p))) continue;

                const bounced = extractBounced(msg.source || Buffer.alloc(0));
                for (const email of bounced) {
                    if (!blacklist.has(email)) {
                        blacklist.add(email);
                        totalAdded++;
                    }
                }

                // Mark as \Seen so this DSN is not re-processed next interval.
                await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            }

            if (totalAdded > 0) {
                saveBlacklist(blacklist);
                if (io) io.emit('bounce:update', {
                    added:     totalAdded,
                    account:   account.user,
                    timestamp: Date.now(),
                });
                console.log(`[BounceMonitor] ${account.user}: blacklisted ${totalAdded} address(es)`);
            }
        } finally {
            lock.release();
        }

        await client.logout();
    } catch (err) {
        try { await client.logout(); } catch {}
        console.error(`[BounceMonitor] ${account.user}: ${err.message}`);
        if (io) io.emit('bounce:error', {
            account:   account.user,
            message:   err.message,
            timestamp: Date.now(),
        });
    }

    return totalAdded;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function runScan(io) {
    const accounts = loadImapAccounts();
    if (!accounts.length) return 0;
    let total = 0;
    for (const account of accounts) {
        total += await scanAccount(account, io);
    }
    return total;
}

function start(io) {
    runScan(io);
    setInterval(() => runScan(io), INTERVAL_MS);
    console.log('[BounceMonitor] Started — scanning every 30 minutes.');
}

module.exports = { start, runScan };
