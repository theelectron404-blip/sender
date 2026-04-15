/**
 * Pre-Send Validation Layer
 *
 * Three escalating checks — run only as deep as the requested mode allows:
 *
 *   'syntax'  — RFC-5321 regex only. Zero network I/O.  ~0 ms
 *   'mx'      — Syntax + DNS MX lookup.                 ~50–200 ms
 *   'deep'    — Syntax + MX + SMTP probe (EHLO → MAIL FROM → RCPT TO → QUIT).
 *               The probe uses a disposable TCP socket, never sends DATA,
 *               so no message is delivered and sender reputation is untouched.
 *              ~200–1500 ms depending on target MTA latency.
 *
 * Results:
 *   { valid: true }
 *   { valid: false, reason: '<human-readable explanation>' }
 *
 * DNS and SMTP results are cached in-process (per Node instance) to avoid
 * redundant network calls for the same domain within a single batch.
 */

'use strict';

const dnsRaw = require('dns');
const dns    = dnsRaw.promises;
const net    = require('net');

// Use well-known public resolvers so Windows system DNS quirks don't cause
// false negatives (ESERVFAIL / ETIMEOUT) for perfectly valid domains like gmail.com.
const _resolver = new dns.Resolver();
_resolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1']);

// ── Per-batch caches (module-level singletons) ────────────────────────────────
// Cleared between batches via clearCaches() called from app.js before each run.
const _mxCache   = new Map();  // domain → MX hostname (best priority)
const _smtpCache = new Map();  // email  → { valid, reason }

function clearCaches() {
    _mxCache.clear();
    _smtpCache.clear();
}

// ── 1. Syntax check ───────────────────────────────────────────────────────────
// Stricter than the minimal regex used at the API boundary (5321 §4.1.2):
// local part may not start/end with a dot and must be ≤64 chars; domain ≤255.
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

function checkSyntax(email) {
    const [local = '', domain = ''] = email.split('@');
    if (!EMAIL_RE.test(email))    return { valid: false, reason: `Syntax: malformed address` };
    if (local.length > 64)        return { valid: false, reason: `Syntax: local part exceeds 64 chars` };
    if (domain.length > 255)      return { valid: false, reason: `Syntax: domain exceeds 255 chars` };
    return { valid: true };
}

// ── 2. DNS MX lookup ──────────────────────────────────────────────────────────
// Returns:
//   string   — best-priority MX hostname (domain itself if only A record exists)
//   null     — domain definitively does not exist (ENOTFOUND / ENODATA + no A)
//   'UNKNOWN' — transient resolver error; caller should treat recipient as valid
async function resolveMx(domain) {
    if (_mxCache.has(domain)) return _mxCache.get(domain);

    try {
        const records = await _resolver.resolveMx(domain);
        if (!records || records.length === 0) {
            // RFC 5321 §5.1: no MX → fall back to A/AAAA implicit MX
            const implicit = await aRecordFallback(domain);
            _mxCache.set(domain, implicit);
            return implicit;
        }
        records.sort((a, b) => a.priority - b.priority);
        const best = records[0].exchange;
        _mxCache.set(domain, best);
        return best;
    } catch (err) {
        // ENOTFOUND / ENODATA = domain genuinely doesn't exist → invalid
        if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
            // Double-check with A record before ruling out entirely
            const implicit = await aRecordFallback(domain);
            _mxCache.set(domain, implicit);
            return implicit;
        }
        // ESERVFAIL / ETIMEOUT / ECONNREFUSED = resolver hiccup → don't block send
        // Do NOT cache so the next call can retry.
        return 'UNKNOWN';
    }
}

async function aRecordFallback(domain) {
    try {
        const addrs = await _resolver.resolve4(domain);
        if (addrs && addrs.length > 0) return domain; // domain is its own implicit MX
    } catch { /* ignore */ }
    return null;
}

// ── 3. SMTP probe ─────────────────────────────────────────────────────────────
/**
 * Open a plain TCP connection to the MX host on port 25, walk through:
 *   220 banner → EHLO → 250 → MAIL FROM:<probe@verify.local> → RCPT TO:<email>
 * then immediately send QUIT regardless of the RCPT response.
 *
 * A 250 or 251 on RCPT TO means the mailbox is accepted.
 * A 550/551/552/553/450/421 indicates the mailbox is unknown or the domain
 * rejects the address — mark as invalid.
 * Any 2xx response that is NOT to RCPT may indicate a catch-all or grey-listing;
 * we treat those as valid (conservative — avoids false negatives).
 *
 * Port 25 is used for the probe (not 587) because 587 requires STARTTLS and
 * SMTP AUTH before RCPT can be tested, which means providing real credentials.
 * Port 25 is the standard MTA-to-MTA port and accepts unauthenticated probes.
 *
 * Many large providers (Gmail, Outlook) always return 250 on RCPT regardless
 * of mailbox existence to prevent harvesting — the probe will return valid:true
 * in those cases, which is the correct conservative behaviour (let the real send
 * produce the bounce if needed, rather than pre-emptively discarding).
 *
 * @param {string} email   - Full recipient address.
 * @param {string} mxHost  - MX hostname resolved in step 2.
 * @param {number} timeout - Connection + I/O timeout in ms.
 */
async function probeSmtp(email, mxHost, timeout = 8000) {
    // Return cached result for this address within the same batch.
    if (_smtpCache.has(email)) return _smtpCache.get(email);

    return new Promise((resolve) => {
        const result = (valid, reason = '') => {
            const r = valid ? { valid: true } : { valid: false, reason };
            _smtpCache.set(email, r);
            resolve(r);
        };

        let settled = false;
        const settle = (valid, reason) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch { /* ignore */ }
            result(valid, reason);
        };

        const sock = net.createConnection({ host: mxHost, port: 25 });
        sock.setTimeout(timeout);

        // ── State machine ─────────────────────────────────────────────────────
        // step: 'banner' → 'ehlo' → 'mailfrom' → 'rcptto' → 'quit'
        let step = 'banner';
        let buf  = '';

        sock.on('data', (chunk) => {
            buf += chunk.toString();

            // Buffer until we have a complete SMTP response line (ends in \n).
            // Multi-line responses use "250-..." continuations; wait for "250 ".
            while (true) {
                const nl = buf.indexOf('\n');
                if (nl === -1) break;
                const line = buf.slice(0, nl + 1);
                buf = buf.slice(nl + 1);

                // Skip continuation lines (e.g. "250-STARTTLS\r\n")
                if (/^\d{3}-/.test(line)) continue;

                const code = parseInt(line.slice(0, 3), 10);

                if (step === 'banner') {
                    if (code === 220) {
                        sock.write(`EHLO verify.local\r\n`);
                        step = 'ehlo';
                    } else {
                        // Unexpected banner — treat as valid (conservative)
                        settle(true);
                    }

                } else if (step === 'ehlo') {
                    if (code === 250) {
                        sock.write(`MAIL FROM:<probe@verify.local>\r\n`);
                        step = 'mailfrom';
                    } else {
                        // EHLO rejected; server may require TLS — can't probe, assume valid
                        sock.write('QUIT\r\n');
                        settle(true);
                    }

                } else if (step === 'mailfrom') {
                    if (code >= 200 && code < 300) {
                        sock.write(`RCPT TO:<${email}>\r\n`);
                        step = 'rcptto';
                    } else {
                        // MAIL FROM rejected (policy/block) — can't determine; assume valid
                        sock.write('QUIT\r\n');
                        settle(true);
                    }

                } else if (step === 'rcptto') {
                    sock.write('QUIT\r\n');
                    step = 'quit';
                    if (code >= 200 && code < 300) {
                        settle(true);
                    } else if (code === 550 || code === 551 || code === 552 ||
                               code === 553 || code === 554) {
                        // Permanent rejection — mailbox does not exist
                        settle(false, `Deep SMTP: server rejected mailbox (${code})`);
                    } else if (code === 450 || code === 451 || code === 452) {
                        // Temporary rejection — address may exist; treat as valid
                        settle(true);
                    } else {
                        settle(true); // Unknown code — conservative
                    }

                } else if (step === 'quit') {
                    settle(true); // QUIT acknowledged — connection clean
                }
            }
        });

        sock.on('timeout', () => settle(true));  // Timeout = can't determine; assume valid
        sock.on('error',   () => settle(true));  // Network error = can't probe; assume valid
        sock.on('close',   () => { if (!settled) settle(true); });
    });
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Validate a single recipient email address.
 *
 * @param {string} email            - The address to validate.
 * @param {'syntax'|'mx'|'deep'} mode - How deep to probe.
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
async function validateRecipient(email, mode = 'mx') {
    // Step 1 — syntax (always run)
    const syntaxResult = checkSyntax(email);
    if (!syntaxResult.valid) return syntaxResult;
    if (mode === 'syntax') return { valid: true };

    // Step 2 — MX
    const domain = email.split('@')[1];
    const mxHost = await resolveMx(domain);
    if (mxHost === null) return { valid: false, reason: `MX: no MX record found for domain "${domain}"` };
    if (mxHost === 'UNKNOWN') return { valid: true }; // DNS resolver error — don't block
    if (mode === 'mx') return { valid: true };

    // Step 3 — SMTP probe (skip if mxHost couldn't be resolved reliably)
    return probeSmtp(email, mxHost);
}

module.exports = { validateRecipient, clearCaches };
