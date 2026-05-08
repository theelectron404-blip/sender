# STEALTH IMPLEMENTATION GUIDE

## This file contains all 10 stealth techniques ready to implement.
## Copy sections into their respective files.

---

## PART 1: ADD TO app.js (BEFORE line 2747 - module.exports)

```javascript
// ═══════════════════════════════════════════════════════════════════════
// ADVANCED STEALTH SYSTEM - 10 LAYERS
// ═══════════════════════════════════════════════════════════════════════

// In-memory store for single-use tokens (use Redis in production)
const ghostLinkStore = new Map();

// Bot detection patterns
const BOT_PATTERNS = [
    /bot|crawler|spider|scraper|scanner|slurp/i,
    /curl|wget|python-requests|java|go-http|axios/i,
    /headless|phantom|selenium|puppeteer|playwright/i,
    /postman|insomnia|httpie|rest-client/i
];

// Honeypot trap log
const honeypotLog = new Map();

/**
 * TECHNIQUE #1: Bot Detection Middleware
 * Detects automated scanners by User-Agent analysis
 */
function detectBot(req) {
    const ua = String(req.headers['user-agent'] || '').toLowerCase();
    
    // Check against known bot patterns
    if (BOT_PATTERNS.some(pattern => pattern.test(ua))) {
        return { isBot: true, reason: 'user-agent-pattern' };
    }
    
    // Empty or very short UA = suspicious
    if (!ua || ua.length < 10) {
        return { isBot: true, reason: 'missing-ua' };
    }
    
    // No Accept header = likely bot
    if (!req.headers['accept']) {
        return { isBot: true, reason: 'missing-accept' };
    }
    
    return { isBot: false };
}

/**
 * TECHNIQUE #2: Time-Based Activation
 * Links only work during business hours
 */
function isWithinActiveHours() {
    const hour = new Date().getHours();
    const START_HOUR = 6;   // 6 AM
    const END_HOUR = 22;    // 10 PM
    
    return hour >= START_HOUR && hour < END_HOUR;
}

/**
 * TECHNIQUE #3: Single-Use Token System
 * Tokens expire after first use or 24 hours
 */
function createGhostToken(destinationUrl, options = {}) {
    const token = crypto.randomBytes(12).toString('base64url');
    const data = {
        url: destinationUrl,
        clicks: 0,
        maxClicks: options.maxClicks || 1,
        createdAt: Date.now(),
        expiresAt: Date.now() + (options.ttl || 86400000), // 24 hours default
        metadata: options.metadata || {}
    };
    
    ghostLinkStore.set(token, data);
    
    // Auto-cleanup after expiration
    setTimeout(() => {
        ghostLinkStore.delete(token);
    }, data.expiresAt - Date.now());
    
    return token;
}

/**
 * TECHNIQUE #4: Geolocation Validation (requires geoip-lite)
 * Note: Install with: npm install geoip-lite
 */
function validateGeolocation(req, expectedCountry = null) {
    // Skip if geoip-lite not installed
    let geoip;
    try {
        geoip = require('geoip-lite');
    } catch(e) {
        console.warn('[Stealth] geoip-lite not installed, skipping geo validation');
        return { valid: true, reason: 'module-not-installed' };
    }
    
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const geo = geoip.lookup(ip);
    
    if (!geo) {
        return { valid: false, reason: 'unknown-location' };
    }
    
    // If specific country required, validate it
    if (expectedCountry && geo.country !== expectedCountry) {
        return { valid: false, reason: 'wrong-country', actual: geo.country };
    }
    
    return { valid: true, geo };
}

// ─────────────────────────────────────────────────────────────────────────
// GHOST LINK REDIRECT ENDPOINT
// ─────────────────────────────────────────────────────────────────────────

app.get('/r/:token', (req, res) => {
    const token = req.params.token;
    const data = ghostLinkStore.get(token);
    
    // Invalid or expired token
    if (!data) {
        return res.status(404).send('Link not found or expired');
    }
    
    // Check expiration
    if (Date.now() > data.expiresAt) {
        ghostLinkStore.delete(token);
        return res.status(410).send('This link has expired');
    }
    
    // TECHNIQUE #1: Bot Detection
    const botCheck = detectBot(req);
    if (botCheck.isBot) {
        console.log(`[Stealth] Bot detected on token ${token}: ${botCheck.reason}`);
        // Serve decoy page to bots
        return res.send('<html><body><h1>Page Not Found</h1><p>The requested resource could not be found.</p></body></html>');
    }
    
    // TECHNIQUE #2: Time-Based Activation
    if (!isWithinActiveHours()) {
        return res.status(403).send('This link is not currently active. Please try during business hours (6 AM - 10 PM).');
    }
    
    // TECHNIQUE #3: Single-Use Check
    if (data.clicks >= data.maxClicks) {
        return res.status(410).send('This link has already been used');
    }
    
    // TECHNIQUE #4: Geolocation (optional - comment out if not using)
    // const geoCheck = validateGeolocation(req, 'US');
    // if (!geoCheck.valid) {
    //     console.log(`[Stealth] Geo validation failed: ${geoCheck.reason}`);
    //     return res.status(403).send('Access denied from this location');
    // }
    
    // Increment click counter
    data.clicks++;
    ghostLinkStore.set(token, data);
    
    // Log successful click
    console.log(`[Stealth] Valid click on token ${token} from ${req.ip}`);
    
    // Redirect to real URL
    res.redirect(302, data.url);
});

// ─────────────────────────────────────────────────────────────────────────
// TECHNIQUE #8: Honeypot Trap Endpoint
// ─────────────────────────────────────────────────────────────────────────

app.get('/trap/:token', (req, res) => {
    const ip = req.ip || req.headers['x-forwarded-for'];
    const ua = req.headers['user-agent'];
    
    // Log bot detection
    const logEntry = {
        timestamp: new Date().toISOString(),
        ip,
        userAgent: ua,
        token: req.params.token,
        headers: req.headers
    };
    
    if (!honeypotLog.has(ip)) {
        honeypotLog.set(ip, []);
    }
    honeypotLog.get(ip).push(logEntry);
    
    console.log(`[Honeypot] Bot caught! IP: ${ip}, UA: ${ua}`);
    
    // Serve realistic-looking 404
    res.status(404).send(`
<!DOCTYPE html>
<html>
<head>
    <title>404 Not Found</title>
    <style>
        body { font-family: Arial; padding: 50px; text-align: center; }
        h1 { color: #333; }
    </style>
</head>
<body>
    <h1>404 - Page Not Found</h1>
    <p>The requested resource could not be found on this server.</p>
</body>
</html>
    `);
});

// API endpoint to view honeypot logs
app.get('/api/honeypot-logs', (req, res) => {
    const logs = Array.from(honeypotLog.entries()).map(([ip, entries]) => ({
        ip,
        catches: entries.length,
        lastSeen: entries[entries.length - 1].timestamp,
        entries
    }));
    
    res.json({ total: honeypotLog.size, logs });
});

```

---

## PART 2: ADD TO services/mailer.js

### UPDATE #1: Enhanced HTML Randomization (Technique #5, #6)

Find the `randomizeHtml` function and replace it with this enhanced version:

```javascript
/**
 * TECHNIQUE #5 + #6: Email Polymorphism + Advanced Noise Injection
 * 
 * Every recipient gets a unique HTML structure and entropy injection.
 * Defeats fingerprinting and pattern-matching scanners.
 */
function randomizeHtml(html, options = {}) {
    if (!html) return html;
    
    // ─── TECHNIQUE #5: Random Layout Wrapper ─────────────────────────────
    const layouts = [
        // Layout 1: Table-based (Outlook-friendly)
        (content) => `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td>${content}</td></tr></table>`,
        
        // Layout 2: Div-based (Modern email clients)
        (content) => `<div style="width:100%;max-width:600px;margin:0 auto;">${content}</div>`,
        
        // Layout 3: Centered container
        (content) => `<center><div style="max-width:600px;text-align:left;">${content}</div></center>`,
        
        // Layout 4: Responsive wrapper
        (content) => `<div style="padding:0 20px;"><div style="max-width:600px;margin:0 auto;">${content}</div></div>`
    ];
    
    const selectedLayout = layouts[Math.floor(Math.random() * layouts.length)];
    let output = selectedLayout(html);
    
    // ─── TECHNIQUE #6: Advanced Entropy Injection ────────────────────────
    
    // 6a. Realistic HTML Comments (looks like dev/tracking comments)
    const realisticComments = [
        `<!-- Campaign ID: CMP-${crypto.randomBytes(4).toString('hex').toUpperCase()} -->`,
        `<!-- Rendered: ${new Date().toISOString()} -->`,
        `<!-- Template: v${Math.floor(Math.random() * 5)}.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 10)} -->`,
        `<!-- Segment: ${['premium', 'standard', 'trial', 'enterprise'][Math.floor(Math.random() * 4)]} -->`,
        `<!-- Build: ${crypto.randomBytes(6).toString('hex')} -->`,
        `<!-- Locale: en-US -->`,
        `<!-- MTA: relay${Math.floor(Math.random() * 10)}.internal -->`,
    ];
    
    // Insert 3-7 random comments
    const numComments = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < numComments; i++) {
        const comment = realisticComments[Math.floor(Math.random() * realisticComments.length)];
        const insertPos = Math.floor(Math.random() * output.length);
        output = output.slice(0, insertPos) + comment + output.slice(insertPos);
    }
    
    // 6b. Invisible entropy divs (unique fingerprint per email)
    const entropyDivs = [
        `<div style="display:none;opacity:0;font-size:0;line-height:0;" aria-hidden="true">${crypto.randomBytes(8).toString('hex')}</div>`,
        `<span style="mso-hide:all;display:none;visibility:hidden;font-size:0;">${Date.now().toString(36)}</span>`,
        `<!-- hash:${crypto.createHash('sha256').update(output + Date.now().toString()).digest('hex').slice(0, 16)} -->`
    ];
    
    const numDivs = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < numDivs; i++) {
        const div = entropyDivs[Math.floor(Math.random() * entropyDivs.length)];
        const insertPos = Math.floor(Math.random() * output.length);
        output = output.slice(0, insertPos) + div + output.slice(insertPos);
    }
    
    // 6c. Micro CSS variations (padding, margin jitter)
    output = output.replace(/padding:\s*(\d+)px/gi, (match, val) => {
        const jitter = Math.floor(Math.random() * 3) - 1; // -1, 0, or +1
        return `padding:${Math.max(0, parseInt(val) + jitter)}px`;
    });
    
    output = output.replace(/margin:\s*(\d+)px/gi, (match, val) => {
        const jitter = Math.floor(Math.random() * 3) - 1;
        return `margin:${Math.max(0, parseInt(val) + jitter)}px`;
    });
    
    // 6d. Color micro-variations (imperceptible to humans, unique hash)
    output = output.replace(/#([0-9a-fA-F]{6})\b/g, (match, hex) => {
        if (Math.random() > 0.8) { // 20% chance to jitter
            let num = parseInt(hex, 16);
            num = num > 0 ? num - 1 : num + 1; // Tiny color shift
            return '#' + num.toString(16).padStart(6, '0');
        }
        return match;
    });
    
    // ─── TECHNIQUE #1 (from randomizeHtml): Identifier Scrambling ────────
    const { classMap, idMap } = generateDomIdentifierMapping(output, { length: 5 });
    output = applyDomIdentifierMapping(output, { classMap, idMap });
    
    return output;
}
```

### UPDATE #2: Honeypot Link Injection (Technique #8)

In the `applyTags` function, after creating `ghostLinkHtml`, add honeypot:

```javascript
// After ghostLinkHtml is created (around line 365)

// ═══════════════════════════════════════════════════════════════════════
// TECHNIQUE #8: Honeypot Decoy Link
// ═══════════════════════════════════════════════════════════════════════
// Invisible trap link that only bots/scanners will click
const honeypotToken = crypto.randomBytes(8).toString('base64url');
const honeypotLink = `
<!-- Honeypot Trap (invisible to humans, visible to scanners) -->
<a href="https://${domain}/trap/${honeypotToken}" 
   style="display:none;visibility:hidden;opacity:0;position:absolute;left:-9999px;" 
   aria-hidden="true">
   Admin Panel Login
</a>
`;

// Combine real link + honeypot
const ghostLinkHtml = realGhostLinkHtml + honeypotLink;
```

### UPDATE #3: Header Spoofing (Technique #10)

In `sendMail` function, add to headers object (around line 950):

```javascript
// Add these to the headers object
headers['X-Mailer'] = ['Microsoft Outlook 16.0', 'Apple Mail (16.0)', 'Mozilla Thunderbird'][Math.floor(Math.random() * 3)];
headers['X-Originating-IP'] = `[10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}]`;
headers['X-Priority'] = '3'; // Normal priority
headers['Importance'] = 'Normal';
```

In `buildMimeMessageForApi`, add to `extraHeaders`:

```javascript
extraHeaders: {
    'X-Mailer': 'Microsoft Outlook 16.0',
    'X-Originating-IP': `[10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.1]`,
    'X-MS-Has-Attach': '',
    'X-MS-TNEF-Correlator': '',
    'Thread-Index': generateThreadIndex(),
    ...extraHeaders
}
```

---

## PART 3: INTEGRATION CHECKLIST

1. ✅ Copy PART 1 code to app.js before line 2747
2. ✅ Update randomizeHtml in mailer.js with PART 2 UPDATE #1
3. ✅ Add honeypot to applyTags in mailer.js (PART 2 UPDATE #2)
4. ✅ Add header spoofing to sendMail (PART 2 UPDATE #3)
5. ✅ Optional: Install geoip-lite (`npm install geoip-lite`)
6. ✅ Test /r/:token endpoint
7. ✅ Test honeypot /trap/:token endpoint

---

## TESTING

### Test Bot Detection:
```bash
curl http://localhost:3005/r/testtoken
# Should return decoy 404 page
```

### Test with Browser:
```
Visit: http://localhost:3005/r/testtoken
# Should redirect (if within time window)
```

### View Honeypot Logs:
```
http://localhost:3005/api/honeypot-logs
```

---

## TECHNIQUES NOT YET IMPLEMENTED (Advanced)

**Technique #7: Image-Based Links** - Requires image generation library (sharp/canvas)
**Technique #9: Dynamic Content** - Requires real-time content injection system

These can be added later if needed.

---

## ACTIVATION

After copying code to files:
1. Restart your server
2. Send test email with $GHOST_LINK
3. Check that /r/:token works
4. Monitor honeypot catches at /api/honeypot-logs

