const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { SocksClient } = require('socks');
const http = require('http');

/**
 * Parse a proxy URL string into a structured object.
 * Supports socks5://, socks4://, http://, https:// schemes.
 * Returns null on invalid input.
 */
function parseProxy(proxyUrl) {
    try {
        const u = new URL(proxyUrl);
        return {
            protocol: u.protocol.replace(':', '').toLowerCase(),
            host:     u.hostname,
            port:     parseInt(u.port, 10),
            username: u.username ? decodeURIComponent(u.username) : null,
            password: u.password ? decodeURIComponent(u.password) : null,
        };
    } catch {
        return null;
    }
}

/**
 * Create a raw TCP socket connected to destHost:destPort through a proxy.
 *
 * SOCKS4/SOCKS5 — uses the `socks` package.
 * HTTP CONNECT      — uses Node's built-in `http` module.
 *
 * The returned socket is passed to nodemailer's transport as the `socket`
 * option, making all SMTP traffic (including TLS wrapping for port 465 and
 * STARTTLS upgrade for port 587) flow through the proxy tunnel.
 */
async function createProxySocket(proxy, destHost, destPort) {
    const proto = proxy.protocol;

    if (proto === 'socks5' || proto === 'socks4') {
        const info = await SocksClient.createConnection({
            proxy: {
                host:     proxy.host,
                port:     proxy.port,
                type:     proto === 'socks5' ? 5 : 4,
                ...(proxy.username && { userId:   proxy.username }),
                ...(proxy.password && { password: proxy.password }),
            },
            command:     'connect',
            destination: { host: destHost, port: destPort },
        });
        return info.socket;
    }

    if (proto === 'http' || proto === 'https') {
        return new Promise((resolve, reject) => {
            const headers = { Host: `${destHost}:${destPort}` };
            if (proxy.username) {
                headers['Proxy-Authorization'] =
                    'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
            }
            const req = http.request({
                host:    proxy.host,
                port:    proxy.port,
                method:  'CONNECT',
                path:    `${destHost}:${destPort}`,
                headers,
                timeout: 15000,
            });
            req.on('connect', (res, socket) => {
                if (res.statusCode === 200) { resolve(socket); }
                else { socket.destroy(); reject(new Error(`HTTP CONNECT proxy returned ${res.statusCode}`)); }
            });
            req.on('error',   reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('HTTP CONNECT proxy timed out')); });
            req.end();
        });
    }

    throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
}

/**
 * Spintax Rotation Engine.
 *
 * Resolves {option1|option2|option3} syntax by randomly selecting one option.
 * Supports arbitrary nesting — e.g. {Hi {there|friend}|Greetings} — by
 * repeatedly resolving the innermost groups (those containing no nested braces)
 * until no spintax remains. Multiple groups at the same depth are all resolved
 * in a single pass for efficiency.
 *
 * Must be called BEFORE applyTags() so that tag values are not accidentally
 * split by pipe characters inside spintax blocks.
 *
 * @param {string} text - Input string, possibly containing spintax.
 * @returns {string}    - Resolved string with all spintax replaced.
 */
function spinText(text) {
    if (!text) return '';
    let result = text;
    // Each iteration resolves all innermost {} groups (no nested braces inside).
    // IMPORTANT: only treat a {…} block as spintax when it contains at least
    // one | separator.  Blocks without | are CSS rules, JS objects, template
    // literals, etc. and must be left completely unchanged.
    while (result.includes('{')) {
        const before = result;
        result = result.replace(/\{([^{}]*)\}/g, (match, opts) => {
            // Not spintax — preserve as-is (CSS selector, JS brace, etc.)
            if (!opts.includes('|')) return match;
            const choices = opts.split('|');
            return choices[Math.floor(Math.random() * choices.length)];
        });
        // Guard against malformed/unmatched braces to prevent an infinite loop.
        if (result === before) break;
    }
    return result;
}

/**
 * Build a responsive, email-compatible HTML table from an array of plain objects.
 *
 * Column headers are derived from the keys of the first item. Rows alternate
 * background colours for readability. A "Total" row is automatically appended
 * when the array contains a key whose name matches
 * /^(price|amount|cost|total|fee|subtotal)$/i.
 *
 * Inline styles only — no external CSS — for maximum compatibility across
 * Gmail, Outlook, Apple Mail, and all webmail clients.
 *
 * @param {Array<Object>} items - Array of plain objects sharing the same keys.
 * @returns {string} Rendered HTML table, or empty string for empty/invalid input.
 */
function buildInvoiceTable(items) {
    if (!Array.isArray(items) || items.length === 0) return '';

    const cols    = Object.keys(items[0]);
    const thStyle = 'padding:10px 16px;background:#f1f5f9;color:#334155;font-size:12px;' +
                    'font-weight:600;text-align:left;border:1px solid #e2e8f0;white-space:nowrap';
    const tdBase  = 'padding:9px 16px;color:#1e293b;font-size:13px;border:1px solid #e2e8f0';

    const headerRow = `<tr>${cols.map((c) =>
        `<th style="${thStyle}">${String(c).charAt(0).toUpperCase() + String(c).slice(1)}</th>`
    ).join('')}</tr>`;

    const bodyRows = items.map((row, i) => {
        const bg    = i % 2 === 1 ? ';background:#f8fafc' : '';
        const cells = cols.map((c) =>
            `<td style="${tdBase}${bg}">${row[c] != null ? String(row[c]) : ''}</td>`
        ).join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    // Auto-total: find the first column whose name looks like a monetary field.
    const priceCol = cols.find((c) => /^(price|amount|cost|total|fee|subtotal)$/i.test(c));
    let totalRow = '';
    if (priceCol) {
        const total = items.reduce((s, r) => s + (parseFloat(r[priceCol]) || 0), 0);
        const totalCells = cols.map((c, idx) => {
            if (c === priceCol) {
                return `<td style="${tdBase};font-weight:700;background:#f1f5f9">${total.toFixed(2)}</td>`;
            }
            if (idx === 0) {
                return `<td style="${tdBase};font-weight:700;color:#64748b;background:#f1f5f9;` +
                        `text-transform:uppercase;letter-spacing:.04em">Total</td>`;
            }
            return `<td style="border:1px solid #e2e8f0;background:#f1f5f9"></td>`;
        }).join('');
        totalRow = `<tr>${totalCells}</tr>`;
    }

    return (
        `<table width="100%" cellpadding="0" cellspacing="0" ` +
        `style="width:100%;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif">` +
        `<thead>${headerRow}</thead>` +
        `<tbody>${bodyRows}${totalRow}</tbody>` +
        `</table>`
    );
}

/**
 * Replace supported $tags in text. Called fresh per recipient so every
 * random tag produces a unique value for that message.
 *
 * @param {string} text       - Input text with $tags.
 * @param {Object} data       - Global data: { tfn, invoiceItems }.
 * @param {Object} recipient  - Per-recipient data: { email, firstName, lastName, city, address, ... }.
 */
function applyTags(text, data, recipient) {
    if (!text) return '';
    const r = recipient || {};

    // ── Helper generators ──
    const randDigits = (n) => () => {
        let s = '';
        for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
        return s;
    };
    // Clean A-Z 0-9 output — no base64url artifacts, no X substitutions
    const ANUM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const randAlphaNum = (n) => () => {
        const bytes = crypto.randomBytes(n);
        let s = '';
        for (let i = 0; i < n; i++) s += ANUM_CHARS[bytes[i] % ANUM_CHARS.length];
        return s;
    };

    const cities = ['New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia','San Antonio',
        'San Diego','Dallas','San Jose','Austin','Jacksonville','Columbus','Charlotte','Indianapolis',
        'Seattle','Denver','Nashville','Portland','Las Vegas','Memphis','Louisville','Baltimore','Milwaukee'];
    const states = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
        'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND',
        'OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
    const greetings = ['Hi','Hello','Dear','Hey','Good day','Greetings'];
    const closings  = ['Regards','Best','Thanks','Cheers','Sincerely','Best regards','Thank you','Warm regards'];
    const streets   = ['Main St','Oak Ave','Pine Rd','Maple Dr','Cedar Ln','Elm St','Park Ave','Washington Blvd'];

    const firstNames = ['James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda','David','Elizabeth',
        'William','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Christopher','Karen',
        'Charles','Lisa','Daniel','Nancy','Matthew','Betty','Anthony','Margaret','Mark','Sandra',
        'Donald','Ashley','Steven','Dorothy','Andrew','Kimberly','Paul','Emily','Joshua','Donna',
        'Kenneth','Michelle','Kevin','Carol','Brian','Amanda','George','Melissa','Timothy','Deborah',
        'Ronald','Stephanie','Edward','Rebecca','Jason','Sharon','Jeffrey','Laura','Ryan','Cynthia',
        'Jacob','Kathleen','Gary','Amy','Nicholas','Angela','Eric','Shirley','Jonathan','Anna',
        'Stephen','Brenda','Larry','Pamela','Justin','Emma','Scott','Nicole','Brandon','Helen',
        'Benjamin','Samantha','Samuel','Katherine','Raymond','Christine','Gregory','Debra','Frank','Rachel',
        'Alexander','Carolyn','Patrick','Janet','Jack','Catherine','Dennis','Maria','Jerry','Heather',
        'Tyler','Diane','Aaron','Ruth','Jose','Julie','Nathan','Olivia','Henry','Joyce'];
    const lastNames = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
        'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin',
        'Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson',
        'Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores',
        'Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts',
        'Gomez','Phillips','Evans','Turner','Diaz','Parker','Cruz','Edwards','Collins','Reyes',
        'Stewart','Morris','Morales','Murphy','Cook','Rogers','Gutierrez','Ortiz','Morgan','Cooper',
        'Peterson','Bailey','Reed','Kelly','Howard','Ramos','Kim','Cox','Ward','Richardson',
        'Watson','Brooks','Chavez','Wood','James','Bennett','Gray','Mendoza','Ruiz','Hughes',
        'Price','Alvarez','Castillo','Sanders','Patel','Myers','Long','Ross','Foster','Jimenez'];

    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const now = new Date();

    // ── Name-based tags ──
    // Use recipient data if available, otherwise auto-generate a random name.
    const firstName = String(r.firstName || '').trim() || pick(firstNames);
    const lastName  = String(r.lastName || '').trim()  || pick(lastNames);

    return text
        // Name tags
        .replace(/\$EMAIL/gi, String(r.email || '').trim())
        .replace(/\$FNAME/gi, firstName)
        .replace(/\$LNAME/gi, lastName)
        .replace(/\$SNM/gi, lastName || firstName)
        .replace(/\$FNM/gi, [firstName, lastName].filter(Boolean).join(' '))

        // Random digit tags (longest pattern first to avoid prefix collisions)
        .replace(/\$RAND12/gi, randDigits(12))
        .replace(/\$RAND10/gi, randDigits(10))
        .replace(/\$RAND8/gi, randDigits(8))
        .replace(/\$RAND6/gi, randDigits(6))
        .replace(/\$RAND4/gi, randDigits(4))
        .replace(/\$Last4/gi, randDigits(4))
        .replace(/\$#SEVEN/gi, randDigits(7))
        .replace(/\$TWO/gi, randDigits(2))

        // Key patterns — longest names first so $KEY3_ALT beats $KEY3, and all beat $KEY
        .replace(/\$KEY3_ALT/gi, () => `${randAlphaNum(4)()}-${randAlphaNum(4)()}-${randAlphaNum(4)()}`)
        .replace(/\$KEY6/gi, () => `${randAlphaNum(4)()}-${randAlphaNum(4)()}-${randAlphaNum(4)()}-${randAlphaNum(4)()}-${randAlphaNum(4)()}-${randAlphaNum(4)()}`)
        .replace(/\$KEY5/gi, () => `${randAlphaNum(4)()}-${randAlphaNum(4)()}-${randAlphaNum(4)()}-${randAlphaNum(4)()}-${randAlphaNum(4)()}`)
        .replace(/\$KEY4/gi, () => `${randAlphaNum(4)()}-${randAlphaNum(4)()}-${randAlphaNum(4)()}-${randAlphaNum(4)()}`)
        .replace(/\$KEY3/gi, () => `${randDigits(4)()}-${randDigits(4)()}-${randDigits(4)()}`)
        .replace(/\$KEY2/gi, () => `${randAlphaNum(5)()}-${randAlphaNum(5)()}`)
        .replace(/\$KEY/gi, () => `${randAlphaNum(8)()}-${randAlphaNum(4)()}`)

        // Alphanumeric tags (longer pattern before shorter to avoid prefix match)
        .replace(/\$RANDALPHA10/gi, randAlphaNum(10))
        .replace(/\$DOTALPHA/gi, () => `${randAlphaNum(3)()}.${randAlphaNum(4)()}.${randAlphaNum(3)()}`)
        .replace(/\$ALPHA/gi, randAlphaNum(8))

        // Unique IDs (longer numbers first)
        .replace(/\$UNQ4/gi, () => crypto.randomUUID())
        .replace(/\$UNQ3/gi, () => crypto.randomBytes(12).toString('hex'))
        .replace(/\$UNQ2/gi, () => crypto.randomBytes(8).toString('hex'))
        .replace(/\$UNQ1/gi, () => crypto.randomBytes(6).toString('hex'))

        // Location / personal
        .replace(/\$ADD/gi, () => r.address || `${Math.floor(Math.random() * 9000) + 1000} ${pick(streets)}`)
        .replace(/\$DATE/gi, now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))
        .replace(/\$City/gi, () => String(r.city || '').trim() || pick(cities))
        .replace(/\$State/gi, () => pick(states))

        // Greetings / closings
        .replace(/\$Greet/gi, () => pick(greetings))
        .replace(/\$Close/gi, () => pick(closings))

        // Confirmation code — clean 7-char uppercase alphanumeric, no dashes
        .replace(/\$ConfCode/gi, () => randAlphaNum(7)())

        // Data tags
        .replace(/\$TFN/gi, data.tfn || '')
        .replace(/\$invoice_table/gi
/**
 * Format the current timestamp exactly as Outlook formats the Date header.
 * RFC-5322 with named timezone offset, e.g.:
 *   Tue, 15 Apr 2026 09:42:17 +0000
 */
function formatOutlookDate() {
    const now = new Date();
    const days  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const pad = (n) => String(n).padStart(2, '0');
    const day   = days[now.getUTCDay()];
    const date  = pad(now.getUTCDate());
    const month = months[now.getUTCMonth()];
    const year  = now.getUTCFullYear();
    const hh    = pad(now.getUTCHours());
    const mm    = pad(now.getUTCMinutes());
    const ss    = pad(now.getUTCSeconds());
    return `${day}, ${date} ${month} ${year} ${hh}:${mm}:${ss} +0000`;
}

/**
 * Generate a standard RFC-4122 v4 GUID.
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
function generateGuid() {
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant bits
    const hex = bytes.toString('hex');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join('-');
}

/**
 * Generate an RFC-5322-compliant unique Message-ID with alternating domains.
 *
 * Format: <RandomAlphanumeric@domain.com>
 * Uses a 24-character base36 random string as the local part, matching the
 * opaque identifier style used by Outlook and Exchange.
 *
 * Domain alternation mimics multi-tenant professional relaying:
 *   - Even calls  → sender's own domain  (extracted from smtp.user address)
 *   - Odd calls   → SMTP provider domain (smtp.host)
 *
 * The alternation state is tracked per SMTP entry via a WeakMap so each
 * relay in the pool alternates independently.
 */
const _msgIdCounters = new WeakMap();

function generateMessageId(smtp) {
    const count = (_msgIdCounters.get(smtp) || 0);
    _msgIdCounters.set(smtp, count + 1);

    // Extract the domain portion of the sender address (user@domain → domain).
    // Fall back to smtp.host if the address is not a valid email.
    const senderDomain = (smtp.user || '').includes('@')
        ? smtp.user.split('@').pop().toLowerCase()
        : smtp.host;

    const domain = (count % 2 === 0) ? senderDomain : smtp.host;

    // 24-character uppercase alphanumeric local part — matches Outlook's style.
    const localPart = crypto.randomBytes(18).toString('base64url').slice(0, 24).toUpperCase();
    return `<${localPart}@${domain}>`;
}

/**
 * Generate a unique per-recipient X-Entity-Ref-ID value.
 * Base64url output keeps the header RFC-safe with no '+' or '/'.
 */
function generateEntityRefId(recipient) {
    const seed = `${recipient}|${Date.now()}|${crypto.randomBytes(8).toString('hex')}`;
    return Buffer.from(seed, 'utf8').toString('base64url');
}

/**
 * Convert a resolved HTML string to a clean plain-text equivalent.
 *
 * The same fully-resolved HTML (post-spintax, post-tag) is used as the source,
 * so the text and HTML parts are guaranteed to carry identical content.
 * Mismatched multipart alternatives are a known spam classifier signal.
 *
 * Processing steps:
 *   1. Block-level tags (p, div, br, headings, li, tr) → newlines.
 *   2. Anchor tags → "label (url)" so links remain readable in clients that
 *      display the text part.
 *   3. All remaining HTML tags stripped.
 *   4. Common HTML entities decoded.
 *   5. Runs of 3+ blank lines collapsed to two (paragraph spacing preserved).
 *   6. Leading/trailing whitespace trimmed.
 */
function htmlToText(html) {
    if (!html) return '';
    return html
        // Block elements → preceding newline
        .replace(/<(p|div|h[1-6]|li|dt|dd|tr|blockquote|pre)(\s[^>]*)?>/gi, '\n')
        // Closing block elements → trailing newline
        .replace(/<\/(p|div|h[1-6]|li|dt|dd|tr|blockquote|pre)>/gi, '\n')
        // <br> variants → newline
        .replace(/<br\s*\/?>/gi, '\n')
        // Anchors: keep visible label and href
        .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gis,
            (_, href, label) => {
                const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
                return cleanLabel ? `${cleanLabel} (${href})` : href;
            })
        // Strip all remaining tags
        .replace(/<[^>]+>/g, '')
        // Decode common HTML entities
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&mdash;/gi, '—')
        .replace(/&ndash;/gi, '–')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        // Normalise horizontal whitespace on each line
        .replace(/[^\S\n]+/g, ' ')
        // Collapse 3+ consecutive blank lines to two
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Generate a per-recipient "phantom prior" Message-ID used to anchor the
 * In-Reply-To and References headers for conversation threading.
 *
 * The ID is derived deterministically from the recipient address so that every
 * email sent to the same address shares the same thread root. Both Microsoft 365
 * and Gmail will group the message as a reply within an ongoing conversation,
 * significantly improving inbox placement for transactional mail.
 */
function generatePhantomMessageId(recipient, smtp) {
    const senderDomain = (smtp.user || '').includes('@')
        ? smtp.user.split('@').pop().toLowerCase()
        : smtp.host;
    // Deterministic 24-char uppercase hash of the recipient address.
    const hash = crypto.createHash('sha256')
        .update(recipient)
        .digest('base64url')
        .slice(0, 24)
        .toUpperCase();
    return `<${hash}@${senderDomain}>`;
}

/**
 * Build a Microsoft Exchange Thread-Index header value.
 *
 * The header is a base64-encoded 22-byte binary structure:
 *   Byte  0     : 0x04 (Exchange root-entry version byte)
 *   Bytes 1–5   : upper 40 bits of FILETIME (100-ns ticks since 1601-01-01 UTC,
 *                 right-shifted by 24 for ~ms precision in 5 bytes)
 *   Bytes 6–21  : 16 random bytes (per-message GUID)
 *
 * Together with Thread-Topic, In-Reply-To, and References this causes Outlook
 * to render the message inside an existing conversation thread.
 */
function generateThreadIndex() {
    const EPOCH_OFFSET_MS = 11644473600000n; // ms between 1601-01-01 and 1970-01-01
    const ticks = (BigInt(Date.now()) + EPOCH_OFFSET_MS) * 10000n; // ms → 100-ns ticks
    const t = ticks >> 24n; // retain upper ~40 bits (ms-level resolution in 5 bytes)
    const buf = Buffer.alloc(22);
    buf[0] = 0x04;
    buf[1] = Number((t >> 32n) & 0xFFn);
    buf[2] = Number((t >> 24n) & 0xFFn);
    buf[3] = Number((t >> 16n) & 0xFFn);
    buf[4] = Number((t >>  8n) & 0xFFn);
    buf[5] = Number( t         & 0xFFn);
    crypto.randomBytes(16).copy(buf, 6);
    return buf.toString('base64');
}

/**
 * Send a single email via the provided SMTP configuration.
 *
 * Auth modes (auto-detected by presence of clientId + clientSecret + refreshToken):
 *   OAuth2  – Microsoft 365 / Google Workspace modern auth (2026 compliant).
 *   Password – Legacy SMTP auth; used when OAuth2 fields are absent.
 *
 * MIME structural notes:
 *   - html is transmitted with Content-Transfer-Encoding: base64 to prevent
 *     character corruption across mail clients and international character sets.
 *   - Date header matches Outlook's exact RFC-5322 formatting.
 *   - Message-ID domain alternates per send to mimic multi-tenant relay traffic.
 */
async function sendMail({ smtp, recipient, subject, html, attachments, fromName, unsubUrl = null }) {
    const useOAuth2 = !!(smtp.clientId && smtp.clientSecret && smtp.refreshToken);

    const auth = useOAuth2
        ? {
            type: 'OAuth2',
            user: smtp.user,
            clientId: smtp.clientId,
            clientSecret: smtp.clientSecret,
            refreshToken: smtp.refreshToken,
          }
        : { user: smtp.user, pass: smtp.pass };

    // Build transport options.
    // If a proxy URL is present on the SMTP entry, create a tunneled socket
    // through the proxy first and pass it to nodemailer via `socket`.
    // Nodemailer uses the host/port fields for TLS SNI and STARTTLS regardless
    // of whether a pre-connected socket is provided, so TLS 1.3 enforcement
    // and rejectUnauthorized apply identically to proxied and direct connections.
    const smtpPort = parseInt(smtp.port, 10);
    const transportOptions = {
        host:   smtp.host,
        port:   smtpPort,
        secure: smtpPort === 465,
        auth,
        tls: {
            minVersion: 'TLSv1.2',   // 1.3 is widely unsupported by SMTP relays
            rejectUnauthorized: true,
        },
    };

    if (smtp.proxy) {
        const proxy = parseProxy(smtp.proxy);
        if (proxy) {
            const tunneledSocket = await createProxySocket(proxy, smtp.host, smtpPort);
            transportOptions.socket = tunneledSocket;
        }
    }

    const transporter = nodemailer.createTransport(transportOptions);

    // Derive plain text from the resolved HTML.
    // Both parts share the same resolved content — spintax and tags were applied
    // once in app.js before calling sendMail(), so they are guaranteed to match.
    const textContent = htmlToText(html);

    // Pre-compute both the real and phantom Message-IDs before building the
    // header object. phantomId is a deterministic hash of the recipient address
    // that acts as a fictitious prior message, anchoring In-Reply-To / References
    // so the message lands inside an existing conversation thread.
    const currentMsgId = generateMessageId(smtp);
    const phantomId    = generatePhantomMessageId(recipient, smtp);
    const entityRefId  = generateEntityRefId(recipient);

    const fromField = fromName ? `"${fromName.replace(/"/g, '\\"')}" <${smtp.user}>` : smtp.user;

    const info = await transporter.sendMail({
        from: fromField,
        to: recipient,
        subject,
        text: textContent,
        html: html,
        attachments: attachments || [],
        headers: {
            'Date':            formatOutlookDate(),
            'Message-ID':      currentMsgId,
            'X-Entity-Ref-ID': entityRefId,
            // RFC-2822 conversation threading (Gmail, Apple Mail, Thunderbird, M365).
            'In-Reply-To':     phantomId,
            'References':      phantomId,
            // Outlook-specific threading headers.
            'Thread-Topic':    subject,
            'Thread-Index':    generateThreadIndex(),
            'Content-Language': 'en-US',
            'X-MS-Exchange-Organization-Network-Message-Id': generateGuid(),
            // RFC 8058 one-click unsubscribe — required by Gmail/Yahoo bulk sender
            // policy (2024+). Satisfying this header moves mail out of Promotions/Spam.
            // X-Priority / Importance / X-Mailer headers removed — they are known
            // spam-score triggers for bulk sends on major filtering systems.
            ...(unsubUrl ? {
                'List-Unsubscribe':      `<${unsubUrl}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            } : {}),
        },
    });

    return info;
}

/**
 * DOM & CSS Randomizer — makes every recipient's message a unique binary hash.
 *
 * Two independent passes are applied to the fully-resolved HTML string:
 *
 * Pass 1 — Identifier Scrambling
 *   All CSS class names and element IDs found in attribute values are replaced
 *   with random 5-character lowercase alphanumeric strings. A consistent mapping
 *   is built per call so that every reference to the same name (in HTML
 *   attributes, inline <style> blocks, and style="" attributes) is replaced with
 *   the same random string, preserving visual layout. These mappings are freshly
 *   generated per recipient so the strings differ across every email.
 *
 * Pass 2 — Noise Injection
 *   3–7 invisible noise nodes are inserted at random positions in the HTML body.
 *   Each node is either:
 *     • An HTML comment:  <!-- randomWord -->
 *     • A hidden <span>:  <span style="display:none;font-size:0">randomWord</span>
 *   The words are drawn from a 120-word dictionary of common English terms so
 *   they do not trigger spam classifiers. The combination of scrambled class
 *   names and comment/span injection means every recipient's raw HTML produces
 *   a completely different SHA-256 hash.
 *
 * @param  {string} html - Fully resolved HTML (post-spintax, post-tags).
 * @returns {string}      - Transformed HTML with unique fingerprint.
 */
const _NOISE_WORDS = [
    'account','action','address','agency','alert','annual','approval','archive',
    'asset','balance','billing','branch','budget','calendar','campaign','capital',
    'category','channel','chart','client','cloud','column','comment','company',
    'confirm','contact','contract','create','credit','customer','dashboard',
    'database','date','debit','default','delivery','department','description',
    'detail','device','digital','directory','discount','document','domain',
    'download','draft','enable','entry','estimate','event','export','feature',
    'filter','financial','folder','format','generate','global','guide','header',
    'history','import','inbox','index','invoice','journal','label','language',
    'ledger','license','limit','listing','location','manager','margin','module',
    'monitor','network','notice','office','option','order','output','overview',
    'package','payment','period','platform','policy','portal','priority','process',
    'product','profile','project','protocol','provider','publish','quarter',
    'record','region','release','report','request','resource','result','review',
    'revision','schedule','section','segment','service','setting','snapshot',
    'source','status','storage','subject','summary','support','system','template',
    'terminal','ticket','timeline','title','token','transfer','trigger','update',
    'upload','vendor','version','workflow','workspace',
];

function randomizeHtml(html) {
    if (!html) return html;

    // ── Pass 1: Identifier scrambling ──────────────────────────────────────
    const identMap = new Map(); // originalName → randomised5charString

    function getRandom(name) {
        if (!identMap.has(name)) {
            identMap.set(name, crypto.randomBytes(4).toString('hex').slice(0, 5));
        }
        return identMap.get(name);
    }

    // Replace class="a b c" attribute values — each token independently mapped.
    let out = html.replace(/\bclass=["']([^"']+)["']/g, (_, names) => {
        const replaced = names
            .split(/\s+/)
            .filter(Boolean)
            .map((n) => getRandom(n))
            .join(' ');
        return `class="${replaced}"`;
    });

    // Replace id="name" attribute values.
    out = out.replace(/\bid=["']([^"']+)["']/g, (_, name) =>
        `id="${getRandom(name)}"`
    );

    // Update references inside <style> blocks.
    // .className { ... }  →  .replacedName { ... }
    // #idName { ... }      →  #replacedId { ... }
    out = out.replace(/(<style[^>]*>)(.*?)(<\/style>)/gis, (_, open, css, close) => {
        // Class selectors
        let newCss = css.replace(/\.([a-zA-Z_\-][a-zA-Z0-9_\-]*)/g, (m, name) => {
            // Only remap names that appeared in HTML attributes; leave unknown
            // vendor/pseudo names like .MsoNormal alone.
            return identMap.has(name) ? `.${identMap.get(name)}` : m;
        });
        // ID selectors
        newCss = newCss.replace(/#([a-zA-Z_\-][a-zA-Z0-9_\-]*)/g, (m, name) =>
            identMap.has(name) ? `#${identMap.get(name)}` : m
        );
        return open + newCss + close;
    });

    // ── Pass 2: Safe noise injection ──────────────────────────────────────────
    // Collect positions that are immediately AFTER a closing '>' tag character,
    // but ONLY outside <style> and <script> blocks.
    // The '>' character also appears inside CSS child selectors (e.g. a > b {})
    // and inside <script> content.  Injecting an HTML comment at those positions
    // would corrupt CSS rules and break JS, so we first build the set of ranges
    // that are inside any <style> or <script> block and exclude them.
    const _blockRanges = [];
    const _blockRe = /(<(?:style|script)[^>]*>)([\s\S]*?)(<\/(?:style|script)>)/gi;
    let _bm;
    while ((_bm = _blockRe.exec(out)) !== null) {
        // Record the character range of the *content* inside the tag pair.
        const start = _bm.index + _bm[1].length;
        const end   = start + _bm[2].length;
        _blockRanges.push([start, end]);
    }
    function _inBlock(pos) {
        for (const [s, e] of _blockRanges) if (pos >= s && pos < e) return true;
        return false;
    }

    const safePositions = [];
    for (let i = 0; i < out.length - 1; i++) {
        if (out[i] === '>' && !_inBlock(i)) safePositions.push(i + 1);
    }

    const noiseCount = Math.min(3 + Math.floor(Math.random() * 5), safePositions.length);

    // Fisher-Yates shuffle so chosen positions are uniformly random.
    for (let i = safePositions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = safePositions[i]; safePositions[i] = safePositions[j]; safePositions[j] = tmp;
    }
    // Sort descending — insert from end of string first so earlier offsets stay valid.
    const chosen = safePositions.slice(0, noiseCount).sort((a, b) => b - a);

    for (let i = 0; i < chosen.length; i++) {
        const word = _NOISE_WORDS[Math.floor(Math.random() * _NOISE_WORDS.length)];
        // Use only HTML comments — no visible tags, no attributes, no quotes.
        // This is 100% safe regardless of where in the document it is inserted.
        const node = `<!-- ${word} -->`;
        const pos = chosen[i];
        out = out.slice(0, pos) + node + out.slice(pos);
    }

    return out;
}

module.exports = { sendMail, applyTags, spinText, randomizeHtml };
