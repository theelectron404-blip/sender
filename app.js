const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { google } = require('googleapis'); // MOVED FROM LINE 75
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { sendMail, buildTransporter, applyTags, spinText, randomizeHtml } = require('./services/mailer');
const { renderAttachment, processInvoicePdf } = require('./services/renderer');
const { rewriteText } = require('./services/variator');
const { validateRecipient, clearCaches } = require('./services/validator');
const { renderTemplate, clearTemplateCache } = require('./services/templater');
const bounceMonitor = require('./services/bounceMonitor');
const { checkDomainAuth } = require('./services/domainAuth');
const { DeliverabilityMonitor } = require('./services/deliverabilityMonitor');
const { ContentAnalyzer } = require('./services/contentAnalyzer');
const { runEngagementSimulation } = require('./services/engagementSim');

// Initialize deliverability monitoring
const deliverabilityMonitor = new DeliverabilityMonitor();
const contentAnalyzer = new ContentAnalyzer();

// --- NEW: Global Crawler Trap State ---
let _globalBotSafeUrl = 'https://www.youtube.com/@BlackBoxAnimated';
const BLACKLIST_PATH = path.join(__dirname, 'blacklist.json');

function loadBlacklist() {
    try {
        const raw = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf8'));
        return new Set(Array.isArray(raw) ? raw.map(e => e.toLowerCase()) : []);
    } catch {
        return new Set();
    }
}

// ── Dynamic Link Cloaking ──────────────────────────────────────────────────────
// In-memory store: redirectId → { url, createdAt, clicks }
// Persisted to click-log.json so clicks survive server restarts.
const _redirectStore = new Map();
const CLICK_LOG_PATH = path.join(__dirname, 'click-log.json');

// ── Microsoft Graph OAuth (delegated / personal account) ─────────────────────
// State map: random hex → { clientId, clientSecret, redirectUri, createdAt }
const _graphOAuthState = new Map();
// Token store: clientId → { refreshToken, accessToken, expiresAt, senderEmail, clientId, clientSecret }
const _graphTokenStore = new Map();


function _loadClickLog() {
    try {
        const entries = JSON.parse(fs.readFileSync(CLICK_LOG_PATH, 'utf8'));
        if (Array.isArray(entries)) {
            for (const e of entries) _redirectStore.set(e.id, e);
        }
    } catch { /* first run — file doesn't exist yet */ }
}
_loadClickLog();

function _saveClickLog() {
    const entries = [..._redirectStore.values()];
    try { fs.writeFileSync(CLICK_LOG_PATH, JSON.stringify(entries, null, 2), 'utf8'); }
    catch { /* non-fatal */ }
}

/**
 * Register a destination URL under a new random ID.
 * domain is one of the user's redirect domains chosen by the rotation logic.
 * Returns the full cloaked URL: https://domain/r/id
 */
function registerRedirect(finalUrl, domain) {
    const id = crypto.randomUUID(); 
    // 1. Generate a random 8-character hex string
    const salt = crypto.randomBytes(4).toString('hex'); 
    
    _redirectStore.set(id, { id, url: finalUrl, domain, clicks: 0, createdAt: Date.now() });
    _saveClickLog();
    
    // 2. Append it as a query parameter ?h=salt
    return `https://${domain}/go/${id}?h=${salt}`; 
}


/**
 * Replace all href="...", src="...", and action="..." attribute values in HTML
 * with cloaked redirect URLs, using round-robin domain rotation.
 *
 * Built-in URL schemes (mailto:, tel:, cid:) and # anchors are left untouched.
 * The function is idempotent: already-cloaked /r/ paths are not double-wrapped.
 *
 * @param {string} html         - Fully resolved HTML for one recipient.
 * @param {string[]} domains    - Array of redirect domains (non-empty).
 * @returns {string}            - HTML with all external links cloaked.
 */
let _domainRoundRobin = 0;
function cloakLinks(html, domains) {
    if (!domains || domains.length === 0) return html;
    return html.replace(
        /(href|src|action)=["']([^"']+)["']/g,
        (match, attr, url) => {
            // Skip non-navigable URLs (mailto, tel, etc.)
            if (/^(mailto:|tel:|cid:|#)/i.test(url)) return match;
            if (!/^https?:\/\//i.test(url)) return match;

            // Pick the next bridge domain in rotation
            const rawDomain = domains[_domainRoundRobin % domains.length];
            _domainRoundRobin++;
            
            // Normalize domain
            const cleanDomain = rawDomain.replace(/^https?:\/\//i, '');

            // REGISTER THE REDIRECT: This creates a unique entry in click-log.json
            const uniqueVercelUrl = registerRedirect(url, cleanDomain);
            
            return `${attr}="${uniqueVercelUrl}"`;
        }
    );
}

async function getGraphAccessToken(graphConfig) {
    const clientId = String(graphConfig.clientId || '').trim();

    // ── Delegated flow: use stored refresh_token (personal & work accounts) ──
    const stored = clientId ? _graphTokenStore.get(clientId) : null;
    if (stored && stored.refreshToken) {
        // Return cached access token if still valid (60 s buffer)
        if (stored.accessToken && stored.expiresAt > Date.now() + 60000) {
            return stored.accessToken;
        }
        // Refresh using refresh_token
        const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                ...(stored.clientSecret ? { client_secret: stored.clientSecret } : {}),
                refresh_token: stored.refreshToken,
                grant_type: 'refresh_token',
                scope: 'https://graph.microsoft.com/Mail.Send offline_access',
            }),
        });
        const tokenData = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !tokenData.access_token) {
            throw new Error(tokenData.error_description || tokenData.error || 'Token refresh failed. Reconnect via Microsoft login.');
        }
        stored.accessToken = tokenData.access_token;
        stored.expiresAt = Date.now() + (tokenData.expires_in || 3600) * 1000;
        if (tokenData.refresh_token) stored.refreshToken = tokenData.refresh_token;
        return stored.accessToken;
    }

    // ── Client credentials flow: work/org accounts ──────────────────────────
    const tenantId = String(graphConfig.tenantId || '').trim();
    const clientSecret = String(graphConfig.clientSecret || '').trim();
    if (!tenantId || !clientId || !clientSecret) {
        throw new Error('Not connected to Microsoft. Click "Connect with Microsoft" to log in, or fill Tenant ID + Client Secret for a work account.');
    }
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default',
    });
    const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || tokenData.error || 'Unable to obtain Graph access token.');
    }
    return tokenData.access_token;
}

async function sendGraphMail({ graphConfig, recipient, subject, html, unsubUrl }) {
    const clientId = String(graphConfig.clientId || '').trim();
    const stored = clientId ? _graphTokenStore.get(clientId) : null;
    const sender = String(graphConfig.sender || (stored && stored.senderEmail) || '').trim();
    const isDelegated = stored && stored.refreshToken;

    const accessToken = await getGraphAccessToken(graphConfig);

    // For delegated auth (personal accounts), use /me/sendMail — no sender email needed
    // For client_credentials (work accounts), use /users/{sender}/sendMail
    let sendUrl;
    if (isDelegated) {
        sendUrl = 'https://graph.microsoft.com/v1.0/me/sendMail';
        // Try to fill senderEmail if we don't have it yet
        if (!stored.senderEmail) {
            try {
                const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
                const meData = await meRes.json().catch(() => ({}));
                stored.senderEmail = meData.mail || meData.userPrincipalName || '';
            } catch { /* non-fatal */ }
        }
    } else {
        if (!sender) throw new Error('Graph sender mailbox is required.');
        sendUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;
    }

    // Generate plain text version for dual-MIME compliance (2026+ requirement)
    const textContent = htmlToPlainText(html || '');
    
    const payload = {
        message: {
            subject: subject || '(No subject)',
            body: { contentType: 'HTML', content: html || '' },
            toRecipients: [{ emailAddress: { address: recipient } }],
            // Add RFC 8058 headers for 2026+ compliance
            internetMessageHeaders: [
                ...(unsubUrl ? [
                    { name: 'List-Unsubscribe', value: `<${unsubUrl}>` },
                    { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }
                ] : []),
                { name: 'X-Mailer', value: 'Microsoft Graph API' },
                { name: 'Content-Language', value: 'en-US' }
            ]
        },
        saveToSentItems: true,
    };

    const sendRes = await fetch(sendUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!sendRes.ok) {
        const errBody = await sendRes.text().catch(() => '');
        throw new Error(`Graph send failed (${sendRes.status}): ${errBody || sendRes.statusText}`);
    }
}

const app = express();
app.set('trust proxy', true);

// Speed controls for adaptive throttling after provider rate limits.
// Keep defaults fast while still backing off when 421/454 responses appear.
const SMTP_COOLDOWN_MS = Math.max(1000, parseInt(process.env.SMTP_COOLDOWN_MS || '30000', 10));
const ADAPTIVE_DELAY_MAX = Math.max(1, parseFloat(process.env.ADAPTIVE_DELAY_MAX || '2'));
const ADAPTIVE_DELAY_STEP_UP = Math.max(0.05, parseFloat(process.env.ADAPTIVE_DELAY_STEP_UP || '0.25'));
const ADAPTIVE_DELAY_RECOVERY = Math.min(0.99, Math.max(0.5, parseFloat(process.env.ADAPTIVE_DELAY_RECOVERY || '0.9')));

// Basic dashboard authentication (cookie + HMAC token).
const LOGIN_ENABLED = String(process.env.LOGIN_ENABLED || 'true').toLowerCase() !== 'false';
const AUTH_COOKIE_NAME = 'as_auth';
const AUTH_TOKEN_TTL_MS = Math.max(5 * 60 * 1000, parseInt(process.env.AUTH_TOKEN_TTL_MS || String(24 * 60 * 60 * 1000), 10));
const AUTH_SECRET = String(process.env.APP_LOGIN_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');
const AUTH_COOKIE_SECURE = String(process.env.AUTH_COOKIE_SECURE || 'auto').toLowerCase(); // auto | true | false
const AUTH_COOKIE_SAMESITE = String(process.env.AUTH_COOKIE_SAMESITE || 'lax').toLowerCase(); // lax | strict | none
const DEFAULT_ADMIN_USER = String(process.env.APP_LOGIN_USER || 'Douxkali').trim();
const DEFAULT_ADMIN_PASS = String(process.env.APP_LOGIN_PASS || 'Doux.kali@999').trim();
const LEGACY_DEFAULT_ADMIN_USER = 'douxkali';
const LEGACY_DEFAULT_ADMIN_PASS = 'Douxkali';

// --- Multi-user file-based storage ---
const USERS_FILE = path.join(__dirname, 'users.json');
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            if (Array.isArray(users) && users.length) {
                // Ensure every user has a role field
                let dirty = false;
                users.forEach((u, i) => {
                    if (u && !u.role) {
                        users[i].role = (i === 0) ? 'admin' : 'user';
                        dirty = true;
                    }
                });
                // One-time migration for installs that still use the old built-in default credentials.
                if (!process.env.APP_LOGIN_USER && !process.env.APP_LOGIN_PASS) {
                    const hasRequestedDefault = users.some(u => u && u.username === DEFAULT_ADMIN_USER);
                    const legacyIdx = users.findIndex(u => u && u.username === LEGACY_DEFAULT_ADMIN_USER && u.password === LEGACY_DEFAULT_ADMIN_PASS);
                    if (!hasRequestedDefault && legacyIdx !== -1) {
                        users[legacyIdx].username = DEFAULT_ADMIN_USER;
                        users[legacyIdx].password = DEFAULT_ADMIN_PASS;
                        users[legacyIdx].role = users[legacyIdx].role || 'admin';
                        dirty = true;
                    }
                }
                if (dirty) saveUsers(users);
                return users;
            }
        }
    } catch { /* corrupt file, reset */ }
    // Seed with default user from env vars
    const users = [{ username: DEFAULT_ADMIN_USER, password: DEFAULT_ADMIN_PASS, role: 'admin' }];
    saveUsers(users);
    return users;
}
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}
function findUser(username) {
    return loadUsers().find(u => u.username === username);
}

// Socket.io instance — injected by server.js after the http server is created
let io = null;
function setIo(instance) { io = instance; }


// Per-socket batch state: batchKey → 'running' | 'paused' | 'stopped'
// Each user's batch is fully isolated — no cross-user log leaks.
const _batchMap = new Map();

// Global emit — used outside of send handlers (e.g. bounce monitor).
function emit(event, data) {
    if (!io) return;
    io.emit(event, data);
}

function parseCookies(req) {
    const raw = String(req.headers.cookie || '');
    if (!raw) return {};
    return raw.split(';').reduce((acc, part) => {
        const i = part.indexOf('=');
        if (i <= 0) return acc;
        const k = part.slice(0, i).trim();
        const v = decodeURIComponent(part.slice(i + 1).trim());
        acc[k] = v;
        return acc;
    }, {});
}

function signAuthPayload(payload) {
    return crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
}

function createAuthToken(username) {
    const exp = Date.now() + AUTH_TOKEN_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ u: username, exp }), 'utf8').toString('base64url');
    const sig = signAuthPayload(payload);
    return `${payload}.${sig}`;
}

function verifyAuthToken(token) {
    try {
        if (!token || typeof token !== 'string') return false;
        const parts = token.split('.');
        if (parts.length !== 2) return false;
        const payload = parts[0];
        const sig = parts[1];
        const expected = signAuthPayload(payload);
        const sigBuf = Buffer.from(sig, 'utf8');
        const expBuf = Buffer.from(expected, 'utf8');
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!decoded || typeof decoded.exp !== 'number') return false;
        if (Date.now() >= decoded.exp) return false;
        return true;
    } catch {
        return false;
    }
}

function isAuthenticated(req) {
    if (!LOGIN_ENABLED) return true;
    const cookies = parseCookies(req);
    return verifyAuthToken(cookies[AUTH_COOKIE_NAME]);
}

function getAuthUsername(req) {
    try {
        const cookies = parseCookies(req);
        const token = cookies[AUTH_COOKIE_NAME];
        if (!token) return null;
        const parts = token.split('.');
        if (parts.length !== 2) return null;
        const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        return decoded.u || null;
    } catch { return null; }
}

function shouldUseSecureCookie(req) {
    if (AUTH_COOKIE_SECURE === 'true' || AUTH_COOKIE_SECURE === '1') return true;
    if (AUTH_COOKIE_SECURE === 'false' || AUTH_COOKIE_SECURE === '0') return false;
    // auto mode: secure only when the current request is HTTPS.
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return req.secure || proto === 'https';
}

function authCookie(req, token, maxAgeSec) {
    const secure = shouldUseSecureCookie(req) ? '; Secure' : '';
    const expires = new Date(Date.now() + Math.max(0, maxAgeSec) * 1000).toUTCString();
    let sameSite = 'Lax';
    if (AUTH_COOKIE_SAMESITE === 'strict') sameSite = 'Strict';
    if (AUTH_COOKIE_SAMESITE === 'none') sameSite = 'None';
    return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=${sameSite}; Max-Age=${maxAgeSec}; Expires=${expires}${secure}`;
}

function requireAuth(req, res, next) {
    if (isAuthenticated(req)) return next();
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
}

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.post('/api/auth/login', (req, res) => {
    if (!LOGIN_ENABLED) {
        const token = createAuthToken('admin');
        res.setHeader('Set-Cookie', authCookie(req, token, Math.floor(AUTH_TOKEN_TTL_MS / 1000)));
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, '/dashboard');
    }

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
        return res.redirect(302, '/login?error=' + encodeURIComponent('Username and password are required.'));
    }
    const user = findUser(username);
    if (!user || user.password !== password) {
        return res.redirect(302, '/login?error=' + encodeURIComponent('Invalid username or password.'));
    }

    const token = createAuthToken(username);
    res.setHeader('Set-Cookie', authCookie(req, token, Math.floor(AUTH_TOKEN_TTL_MS / 1000)));
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, '/dashboard');
});

app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', authCookie(req, '', 0));
    return res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const username = getAuthUsername(req) || '';
    const user = username ? findUser(username) : null;
    res.json({ authenticated: isAuthenticated(req), loginEnabled: LOGIN_ENABLED, username, role: (user && user.role) || 'user' });
});

// --- Admin user management routes ---
app.get('/api/admin/users', requireAuth, (req, res) => {
    const caller = getAuthUsername(req);
    const callerUser = caller ? findUser(caller) : null;
    if (!callerUser || callerUser.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    const users = loadUsers().map(u => ({ username: u.username, role: u.role || 'user' }));
    res.json({ users });
});

app.post('/api/admin/users', requireAuth, (req, res) => {
    const caller = getAuthUsername(req);
    const callerUser = caller ? findUser(caller) : null;
    if (!callerUser || callerUser.role !== 'admin') return res.status(403).json({ error: 'Only admins can create users.' });
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || 'user').trim();
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    if (username.length < 2 || username.length > 50) return res.status(400).json({ error: 'Username must be 2-50 characters.' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    const users = loadUsers();
    if (users.find(u => u.username === username)) return res.status(409).json({ error: 'User already exists.' });
    users.push({ username, password, role: role === 'admin' ? 'admin' : 'user' });
    saveUsers(users);
    res.json({ ok: true });
});

app.delete('/api/admin/users/:username', requireAuth, (req, res) => {
    const caller = getAuthUsername(req);
    const callerUser = caller ? findUser(caller) : null;
    if (!callerUser || callerUser.role !== 'admin') return res.status(403).json({ error: 'Only admins can delete users.' });
    const target = req.params.username;
    if (target === caller) return res.status(400).json({ error: 'You cannot delete yourself.' });
    const users = loadUsers();
    if (users.length <= 1) return res.status(400).json({ error: 'Cannot delete the last user.' });
    const idx = users.findIndex(u => u.username === target);
    if (idx === -1) return res.status(404).json({ error: 'User not found.' });
    users.splice(idx, 1);
    saveUsers(users);
    res.json({ ok: true });
});

app.put('/api/admin/users/:username/password', requireAuth, (req, res) => {
    const caller = getAuthUsername(req);
    const target = req.params.username;
    if (caller !== target) return res.status(403).json({ error: 'You can only change your own password.' });
    const newPassword = String(req.body?.password || '');
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    const users = loadUsers();
    const user = users.find(u => u.username === target);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    user.password = newPassword;
    saveUsers(users);
    res.json({ ok: true });
});

app.get('/login', (req, res) => {
    if (isAuthenticated(req)) return res.redirect('/dashboard');
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/login');
    return res.redirect('/dashboard');
});

app.get('/dashboard', requireAuth, (req, res) => {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Debug route to check configuration
app.get('/api/debug/config', (req, res) => {
    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;
    
    res.json({
        NODE_ENV: process.env.NODE_ENV,
        PORT: process.env.PORT,
        DOMAIN: process.env.DOMAIN,
        detected_protocol: protocol,
        detected_host: host,
        detected_baseUrl: baseUrl,
        redirect_override: process.env.GMAIL_REDIRECT_OVERRIDE,
        final_redirect_uri: process.env.GMAIL_REDIRECT_OVERRIDE || `${baseUrl}/api/gmail/callback`,
        gmail_apps_count: gmailApps.length,
        gmail_accounts_count: gmailAccounts.length,
        headers: {
            'x-forwarded-proto': req.headers['x-forwarded-proto'],
            'x-forwarded-host': req.headers['x-forwarded-host'], 
            'host': req.headers.host,
            'user-agent': req.headers['user-agent']
        }
    });
});

// ── Microsoft Graph OAuth routes (public — no auth cookie required) ──────────

// Returns a Microsoft login URL for the delegated OAuth2 flow.
// No auth required — generates a public OAuth authorize URL; security is in the state CSRF token.
app.get('/api/graph/auth-url', (req, res) => {
    const clientId     = String(req.query.clientId     || '').trim();
    const clientSecret = String(req.query.clientSecret || '').trim();
    const redirectUri  = String(req.query.redirectUri  || '').trim();
    if (!clientId || !redirectUri) return res.status(400).json({ error: 'clientId and redirectUri are required.' });
    const state = crypto.randomBytes(16).toString('hex');
    // Clean up stale states (>10 min)
    for (const [k, v] of _graphOAuthState) { if (Date.now() - v.createdAt > 600000) _graphOAuthState.delete(k); }
    _graphOAuthState.set(state, { clientId, clientSecret, redirectUri, createdAt: Date.now() });
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: 'https://graph.microsoft.com/Mail.Send offline_access',
        response_mode: 'query',
        state,
    });
    return res.json({ url: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}` });
});

// OAuth callback — Microsoft redirects here after login.
app.get('/api/graph/callback', async (req, res) => {
    const code    = String(req.query.code  || '');
    const state   = String(req.query.state || '');
    const errMsg  = String(req.query.error_description || req.query.error || '');

    const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const page = (type, payload) => {
        const bg = type === 'graph-auth-success' ? '#0a3d1f' : '#3d0a0a';
        const icon = type === 'graph-auth-success' ? '✓' : '✗';
        const msg  = type === 'graph-auth-success' ? `Connected as ${esc(payload.sender)}` : esc(payload.error);
        const safePayload = JSON.stringify({ type, ...payload }).replace(/<\//g, '<\\/');
        return `<!DOCTYPE html><html><head><title>Microsoft Auth</title></head><body style="margin:0;display:grid;place-items:center;height:100vh;background:${bg};font-family:sans-serif;color:#e2e8f0"><div style="text-align:center;padding:32px"><div style="font-size:40px;margin-bottom:12px">${icon}</div><p style="font-size:18px;font-weight:600">${msg}</p><p style="color:#94a3b8;font-size:14px">You can close this window.</p></div><script>try{window.opener.postMessage(${safePayload},'*');}catch(e){}setTimeout(()=>window.close(),2000);</script></body></html>`;
    };

    if (errMsg) return res.send(page('graph-auth-error', { error: errMsg }));

    const oauthData = _graphOAuthState.get(state);
    if (!oauthData) return res.send(page('graph-auth-error', { error: 'Invalid or expired state. Try again.' }));
    _graphOAuthState.delete(state);

    try {
        const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: oauthData.clientId,
                ...(oauthData.clientSecret ? { client_secret: oauthData.clientSecret } : {}),
                code,
                redirect_uri: oauthData.redirectUri,
                grant_type: 'authorization_code',
            }),
        });
        const tokenData = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !tokenData.access_token) {
            throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed.');
        }
        // Extract email from id_token JWT payload
        let senderEmail = '';
        try {
            const parts = (tokenData.id_token || '').split('.');
            if (parts[1]) {
                const pl = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                senderEmail = pl.preferred_username || pl.email || pl.unique_name || '';
            }
        } catch { /* non-fatal */ }
        _graphTokenStore.set(oauthData.clientId, {
            clientId: oauthData.clientId,
            clientSecret: oauthData.clientSecret,
            refreshToken: tokenData.refresh_token || '',
            accessToken: tokenData.access_token,
            expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
            senderEmail,
        });
        return res.send(page('graph-auth-success', { sender: senderEmail }));
    } catch (e) {
        return res.send(page('graph-auth-error', { error: e.message }));
    }
});

// Returns current connection status for a given clientId.
app.get('/api/graph/token-status', (req, res) => {
    const clientId = String(req.query.clientId || '').trim();
    const stored = _graphTokenStore.get(clientId);
    if (!stored) return res.json({ connected: false });
    return res.json({ connected: true, sender: stored.senderEmail });
});

// ── Device Code Flow (microsoft.com/devicelogin) ──────────────────────────
// Step 1: Request a device code from Microsoft
app.post('/api/graph/device-code', async (req, res) => {
    const clientId = String(req.body.clientId || '').trim();
    if (!clientId) return res.status(400).json({ error: 'clientId is required.' });
    try {
        const dcRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/devicecode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                scope: 'https://graph.microsoft.com/Mail.Send offline_access',
            }),
        });
        const dcData = await dcRes.json().catch(() => ({}));
        if (!dcRes.ok || !dcData.device_code) {
            throw new Error(dcData.error_description || dcData.error || 'Failed to get device code.');
        }
        return res.json({
            userCode: dcData.user_code,
            verificationUri: dcData.verification_uri,
            deviceCode: dcData.device_code,
            expiresIn: dcData.expires_in || 900,
            interval: dcData.interval || 5,
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// Step 2: Poll until user completes login at microsoft.com/devicelogin
app.post('/api/graph/device-poll', async (req, res) => {
    const clientId = String(req.body.clientId || '').trim();
    const clientSecret = String(req.body.clientSecret || '').trim();
    const deviceCode = String(req.body.deviceCode || '').trim();
    if (!clientId || !deviceCode) return res.status(400).json({ error: 'clientId and deviceCode required.' });
    try {
        const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                ...(clientSecret ? { client_secret: clientSecret } : {}),
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: deviceCode,
            }),
        });
        const tokenData = await tokenRes.json().catch(() => ({}));
        // Still waiting for user to login
        if (tokenData.error === 'authorization_pending') {
            return res.json({ status: 'pending' });
        }
        if (tokenData.error === 'slow_down') {
            return res.json({ status: 'slow_down' });
        }
        if (tokenData.error === 'expired_token') {
            return res.json({ status: 'expired', error: 'Code expired. Try again.' });
        }
        if (!tokenRes.ok || !tokenData.access_token) {
            throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed.');
        }
        // Success — extract email and store tokens
        let senderEmail = '';
        try {
            const parts = (tokenData.id_token || '').split('.');
            if (parts[1]) {
                const pl = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                senderEmail = pl.preferred_username || pl.email || pl.unique_name || '';
            }
        } catch { /* non-fatal */ }
        // If id_token didn't give us an email, fetch from /me
        if (!senderEmail && tokenData.access_token) {
            try {
                const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
                    headers: { Authorization: `Bearer ${tokenData.access_token}` },
                });
                const meData = await meRes.json().catch(() => ({}));
                senderEmail = meData.mail || meData.userPrincipalName || '';
            } catch { /* non-fatal */ }
        }
        _graphTokenStore.set(clientId, {
            clientId,
            clientSecret,
            refreshToken: tokenData.refresh_token || '',
            accessToken: tokenData.access_token,
            expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
            senderEmail,
        });
        return res.json({ status: 'success', sender: senderEmail });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.use((req, res, next) => {
    if (req.path === '/unsub' || req.path.startsWith('/r/') || req.path === '/api/graph/callback') return next();
    if (req.path === '/login.html') return res.redirect('/login');
    if (req.path.startsWith('/api/auth')) return next();

    const isDashboardPage = req.path === '/index.html' || req.path === '/dashboard';
    const isApiCall = req.path.startsWith('/api/');
    if (isDashboardPage || isApiCall) return requireAuth(req, res, next);
    return next();
});

app.use(express.static(path.join(__dirname, 'public')));


// Change /r/:id to /v/:id so it matches your registerRedirect function
// --- UPDATED: Crawler Trap Bouncer ---
// Full list of known email security scanner / bot User-Agent patterns
const BOT_PATTERNS = [
    // Search engine bots
    'googlebot', 'adsbot-google', 'bingbot', 'slurp', 'duckduckbot', 'baiduspider',
    // Email security scanners
    'mimecast', 'proofpoint', 'fireeye', 'trendmicro', 'barracuda',
    'ironport', 'messagelabs', 'symantec', 'sophos', 'forcepoint',
    'cisco', 'cloudmark', 'spamassassin', 'msging', 'microsoft preview',
    'zscaler', 'checkpoint', 'paloalto', 'fortinet', 'watchguard',
    'knowbe4', 'cofense', 'abnormal', 'inky', 'egress',
    // Generic bot indicators
    'scanner', 'crawler', 'spider', 'bot/', 'headless', 'phantomjs',
    'selenium', 'puppeteer', 'wget', 'curl/', 'python-requests',
    'go-http-client', 'java/', 'libwww', 'zgrab',
    // Microsoft link preview
    'skypeuripreview', 'microsoftpreview', 'outlook',
];

function detectBot(req) {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    
    // Check User-Agent patterns
    if (BOT_PATTERNS.some(p => ua.includes(p))) return { isBot: true, reason: 'ua_pattern' };

    // No User-Agent at all = likely a scanner/prefetch
    if (!ua || ua.trim() === '') return { isBot: true, reason: 'no_ua' };

    // Accept header check — real browsers always send Accept with text/html
    const accept = (req.headers['accept'] || '').toLowerCase();
    if (accept && !accept.includes('text/html') && !accept.includes('*/*')) {
        return { isBot: true, reason: 'no_html_accept' };
    }

    return { isBot: false };
}

app.get('/go/:id', (req, res) => { 
    const entry = _redirectStore.get(req.params.id);
    if (!entry) {
        // Fallback: redirect to humanDefaultUrl if set, otherwise 404
        if (global._humanDefaultUrl) {
            return res.redirect(302, global._humanDefaultUrl);
        }
        return res.status(404).send('Link not found.');
    }

    const { isBot, reason } = detectBot(req);

    if (isBot) {
        // Bot detected: redirect to safe URL, do NOT count the click
        console.log(`[CrawlerTrap] Bot blocked (${reason}) UA: ${req.headers['user-agent'] || 'none'} → ${_globalBotSafeUrl}`);
        return res.redirect(302, _globalBotSafeUrl); 
    }

    // Real human: count the click and redirect to real URL
    entry.clicks++;
    entry.lastClick = Date.now();
    _saveClickLog();

    if (io) io.emit('link:click', { 
        id: req.params.id, 
        url: entry.url, 
        domain: entry.domain, 
        clicks: entry.clicks, 
        timestamp: Date.now() 
    });

    console.log(`[ClickTrack] Human click on ${req.params.id} → ${entry.url}`);
    return res.redirect(302, entry.url);
});

// Test endpoint for crawler trap (for debugging)
app.get('/api/crawler-trap/test', (req, res) => {
    const { isBot, reason } = detectBot(req);
    res.json({
        isBot,
        reason: reason || 'none',
        userAgent: req.headers['user-agent'] || 'none',
        accept: req.headers['accept'] || 'none',
        botSafeUrl: _globalBotSafeUrl,
        humanDefaultUrl: global._humanDefaultUrl || 'not set',
        trackedLinks: _redirectStore.size,
        message: isBot
            ? `BOT → would go to: ${_globalBotSafeUrl}`
            : `HUMAN → would go to real link (or fallback: ${global._humanDefaultUrl || 'not set'})`
    });
});

// GET /api/click-log — return all tracked links and their click counts.
app.get('/api/click-log', (_req, res) => {
    const log = [..._redirectStore.values()].sort((a, b) => b.createdAt - a.createdAt);
    res.json(log);
});

// Shared unsubscribe logic for both GET and POST (RFC 8058 compliance)
function handleUnsubscribe(email, req, res) {
    try {
        const raw = email.trim().toLowerCase();
        if (!raw || !raw.includes('@') || !raw.includes('.')) {
            return res.status(400).send('Invalid unsubscribe request.');
        }
        
        let list = [];
        try { 
            list = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf8')); 
            if (!Array.isArray(list)) list = []; 
        } catch { 
            list = []; 
        }
        
        if (!list.includes(raw)) {
            list.push(raw);
            fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(list, null, 2), 'utf8');
            if (io) io.emit('bounce:update', { account: 'unsubscribe', added: 1, timestamp: Date.now() });
        }
        
        const safe = raw.replace(/[<>&"]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' })[c]);
        return res.send(
            `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Unsubscribed</title>` +
            `<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;` +
            `display:flex;align-items:center;justify-content:center;height:100vh;background:#f8fafc;color:#334155}` +
            `h2{color:#16a34a;margin-bottom:12px;font-size:22px}p{color:#64748b;font-size:14px}</style></head>` +
            `<body><div style="text-align:center;padding:40px"><h2>&#10003; Unsubscribed</h2>` +
            `<p><strong>${safe}</strong> has been removed from future mailings.</p></div></body></html>`
        );
    } catch {
        return res.status(400).send('Invalid unsubscribe request.');
    }
}

// GET /unsub?e=<base64url-encoded-email> — Traditional unsubscribe link
// Called when users click unsubscribe links in emails
app.get('/unsub', (req, res) => {
    try {
        const raw = Buffer.from(String(req.query.e || ''), 'base64url').toString('utf8');
        return handleUnsubscribe(raw, req, res);
    } catch {
        return res.status(400).send('Invalid unsubscribe link.');
    }
});

// POST /unsub — RFC 8058 One-Click Unsubscribe (2026+ REQUIRED)
// Called automatically by Gmail, Yahoo, Apple Mail when user clicks "Unsubscribe" 
// Must accept List-Unsubscribe=One-Click in POST body per RFC 8058
app.post('/unsub', (req, res) => {
    try {
        // RFC 8058 specifies the POST body format
        const postData = String(req.body['List-Unsubscribe'] || '').trim();
        const emailParam = String(req.query.e || '').trim();
        
        let email = '';
        
        // Extract email from either POST body or query param
        if (postData === 'One-Click' && emailParam) {
            // Standard RFC 8058 format: POST with List-Unsubscribe=One-Click + email in URL
            email = Buffer.from(emailParam, 'base64url').toString('utf8');
        } else if (emailParam) {
            // Fallback: email in query param
            email = Buffer.from(emailParam, 'base64url').toString('utf8');
        } else {
            return res.status(400).send('Invalid one-click unsubscribe request.');
        }
        
        return handleUnsubscribe(email, req, res);
    } catch {
        return res.status(400).send('Invalid one-click unsubscribe request.');
    }
});

// --- Routes ---
app.post('/api/send', async (req, res) => {
    const {
        smtps, recipients, subjects, bodies,
        rotateLimit, tfn, fromName, fromNames,
        minDelay, maxDelay,
        warmupMode, warmupDay,
        llmApiKey,
        attachHtml, attachFormat,
        invoiceData,
        validationMode,
        batchSize, restPeriodMin, restPeriodMax,
        redirectDomains,
        domainRotateEvery,
        tzSendStart, tzSendEnd,
        graphConfig,
        gmailConfig,
        rotationMode, rotateEveryN,
        botSafeUrl,
        humanDefaultUrl,
        socketId,
    } = req.body;

    // 1. UPDATE THE CRAWLER TRAP GLOBAL VARIABLE
    if (botSafeUrl) {
        _globalBotSafeUrl = botSafeUrl.trim();
    }
    // Store human default URL globally for fallback
    if (humanDefaultUrl) {
        global._humanDefaultUrl = humanDefaultUrl.trim();
    }

    const batchSocketId = (socketId && typeof socketId === 'string') ? socketId : null;
    const batchKey = batchSocketId || '__global__';

    const emit = (event, data) => {
        if (!io) return;
        if (batchSocketId) {
            io.to(batchSocketId).emit(event, data);
        } else {
            io.emit(event, data);
        }
    };

    // Support multi-account Graph: graphConfig.accounts is an array
    const graphAccounts = (graphConfig && graphConfig.enabled && Array.isArray(graphConfig.accounts) && graphConfig.accounts.length)
        ? graphConfig.accounts
        // Legacy: single config with tenantId/clientId at top level
        : (graphConfig && graphConfig.enabled && graphConfig.clientId) ? [graphConfig] : [];
    const graphEnabled = graphAccounts.length > 0;
    const gmailEnabled = !!(gmailConfig && gmailConfig.enabled);
    const resolvedFromNames = Array.isArray(fromNames)
        ? fromNames.map((x) => String(x || '').trim()).filter(Boolean)
        : [];

    if (graphEnabled) {
        for (let gi = 0; gi < graphAccounts.length; gi++) {
            const ga = graphAccounts[gi];
            if (!ga.clientId) {
                return res.status(400).json({ error: `Graph account #${gi + 1} is missing Client ID.` });
            }
        }
    }

    if (gmailEnabled && gmailAccounts.length === 0) {
        return res.status(400).json({ error: 'Gmail mode enabled but no Gmail accounts authenticated.' });
    }

    // Validate SMTP pool
    if (!graphEnabled && !gmailEnabled) {
        if (!Array.isArray(smtps) || smtps.length === 0) {
            return res.status(400).json({ error: 'At least one SMTP account is required.' });
        }
        for (let i = 0; i < smtps.length; i++) {
            const s = smtps[i];
            const hasAuth = s.pass || (s.clientId && s.clientSecret && s.refreshToken);
            if (!s.host || !s.port || !s.user || !hasAuth) {
                return res.status(400).json({ error: `SMTP entry ${i + 1} is missing required fields (host, port, user, and either pass or OAuth2 credentials).` });
            }
        }
    }

    // Validate recipients
    if (!Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'At least one recipient is required.' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const r of recipients) {
        const rawEmail = (typeof r === 'object' && r !== null) ? (r.email || '') : String(r);
        if (!emailRegex.test(rawEmail.trim())) {
            return res.status(400).json({ error: `Invalid email: ${rawEmail}` });
        }
    }

    // Normalise the validation mode — default to 'mx' when not supplied.
    // 'syntax' → regex only | 'mx' → +DNS MX | 'deep' → +SMTP probe
    const vMode = ['syntax', 'mx', 'deep'].includes(validationMode) ? validationMode : 'mx';

    if (!Array.isArray(subjects) || subjects.length === 0) {
        return res.status(400).json({ error: 'At least one subject line is required.' });
    }
    if (!Array.isArray(bodies) || bodies.length === 0) {
        return res.status(400).json({ error: 'At least one HTML body template is required.' });
    }
// 1. Respond to Nginx instantly so the connection doesn't time out
res.json({ ok: true, message: "Batch started", total: recipients.length });

// 2. Start the work in the background
(async () => {
    const limit = Math.max(1, parseInt(rotateLimit, 10) || 5);
    const results = { success: 0, failed: 0, logs: [] };

    // Load blacklist once per batch — addresses added by the bounce monitor
    // during a long batch will not take effect until the next batch, which is
    // the correct and expected behaviour.
    const blacklistSet = loadBlacklist();

    // Clear DNS/SMTP validation caches so stale results from a previous batch
    // do not bleed into this one. Caches are re-populated as the loop runs.
    clearCaches();

    // Clear the Handlebars compiled-template cache so any edits to the template
    // in the UI take effect for this batch without a server restart.
    clearTemplateCache();

    // Pre-parse invoice items once per batch — same array shared across all
    // recipient sends. express.json() already decoded the payload, so invoiceData
    // arrives as a native array. $invoice_table in body/attachment HTML is
    // replaced per send inside applyTags().
    const parsedInvoiceItems = Array.isArray(invoiceData) && invoiceData.length > 0
        ? invoiceData
        : [];

    // ── Warm-up rate tracking ────────────────────────────────────────────────
    // Hourly cap = floor(10 × 1.1^(day-1)):  day1→10, day2→11, day7→17, day30→174
    const warmupHourlyLimit = warmupMode
        ? Math.max(1, Math.floor(10 * Math.pow(1.1, Math.max(0, (parseInt(warmupDay, 10) || 1) - 1))))
        : null;
    let warmupSentThisHour = 0;
    let warmupHourStart = Date.now();

    // ── Adaptive pacing + per-SMTP cooldown state ───────────────────────────
    // When an SMTP returns 421, that specific account is cooled down for 15 min
    // and the global pacing multiplier is increased to slow future sends.
    const smtpCooldownUntil = Array.isArray(smtps) ? smtps.map(() => 0) : [];
    let adaptiveDelayFactor = 1;

    // sendCounter tracks sends on the current SMTP; resets on every rotation
    let sendCounter = 0;
    let smtpIndex = 0;
    let recipientIndex = 0; // used for Graph/Gmail account rotation

    // ── Dynamic Batching ─────────────────────────────────────────────────────
    // batchSendCount tracks how many emails have been sent in the current micro-
    // batch. When it reaches a random size in [batchMin, batchMax], the loop
    // pauses for a random rest period in [restPeriodMin, restPeriodMax] minutes.
    // The bounce monitor (IMAP engagement) is triggered manually during the rest
    // to simulate account activity — a human reads mail while taking a break.
    //
    // Both the batch boundary and the rest duration are randomised independently
    // so no two sending sessions share an identical cadence fingerprint.
    const batchMin = Math.max(0, parseInt(batchSize, 10) || 0);
    // If only one value is provided (batchSize), treat it as both min and max.
    // The UI sends a single batchSize value; a batchMax field may be added later.
    const batchMax = batchMin;
    const restMin  = Math.max(0, parseFloat(restPeriodMin) || 0);   // minutes
    const restMax  = Math.max(restMin, parseFloat(restPeriodMax) || 0);
    const batchingEnabled = batchMin > 0;
    let batchSendCount = 0;
    // Randomise the first batch boundary within ±25% so the very first batch
    // size is not predictable.
    let nextBatchLimit = batchMin > 0
        ? Math.max(1, Math.round(batchMin * (0.75 + Math.random() * 0.5)))
        : Infinity;

    // Build the clean sorted redirect domain list once per batch.
    const activeDomains = Array.isArray(redirectDomains)
        ? redirectDomains.map(d => d.trim()).filter(Boolean)
        : [];
    const rotateEvery = Math.max(1, parseInt(domainRotateEvery, 10) || 1);
    let emailsSent = 0; // tracks how many emails sent, used for domain rotation

    // Business-hours window for timezone scheduling (24-h, defaults 9–17).
    const sendStartHour = Math.max(0,  Math.min(23, parseInt(tzSendStart, 10) || 9));
    const sendEndHour   = Math.max(0,  Math.min(23, parseInt(tzSendEnd,   10) || 17));

    // Build one persistent pooled transporter per SMTP account for the duration
    // of this batch. Proxy-based SMTPs return null and fall back to per-send
    // transport creation inside sendMail().
    const _transporterPool = Array.isArray(smtps) ? smtps.map(s => buildTransporter(s)) : [];

    // ── Body & Subject Rotation State ────────────────────────────────────────────
    // Round-robin counters to ensure even distribution across templates
    let bodyRotationIndex = 0;
    let subjectRotationIndex = 0;
    
    // Track rotation statistics
    const rotationStats = {
        bodyUsage: new Map(),
        subjectUsage: new Map(),
        totalSent: 0
    };

    _batchMap.set(batchKey, 'running');
    emit('batch:start', { total: recipients.length, timestamp: Date.now() });

    for (const recipientRaw of recipients) {
        // ── User stop/pause guard ─────────────────────────────────────────────
        if (_batchMap.get(batchKey) === 'stopped') {
            emit('send:event', { status: 'warn', recipient: null, smtp: null, message: '[STOPPED] Batch stopped by user request.', timestamp: Date.now() });
            break;
        }
        while (_batchMap.get(batchKey) === 'paused') {
            await new Promise((r) => setTimeout(r, 300));
        }
        // ── Per-SMTP cooldown selector (421/454 recovery) ───────────────────
        if (!graphEnabled && smtps.length > 0) {
            let attempts = 0;
            const now = Date.now();
            while (attempts < smtps.length && smtpCooldownUntil[smtpIndex] > now) {
                smtpIndex = (smtpIndex + 1) % smtps.length;
                sendCounter = 0;
                attempts++;
            }

            // If every account is currently cooling down, wait for the earliest one.
            if (attempts >= smtps.length && smtpCooldownUntil[smtpIndex] > now) {
                const earliest = Math.min(...smtpCooldownUntil);
                const waitMs = Math.max(0, earliest - now);
                if (waitMs > 0) {
                    const msg = `[COOLDOWN] All SMTP accounts cooling down. Waiting ${Math.ceil(waitMs / 1000)}s.`;
                    results.logs.push(msg);
                    emit('send:event', { status: 'rest', recipient: null, smtp: null, message: msg, timestamp: Date.now() });
                    await new Promise((r) => setTimeout(r, waitMs));
                }
            }
        }

        // ── Timezone-aware scheduling ─────────────────────────────────────────
        // recipientRaw may be a plain string (no timezone) or an object with
        // { email, tz } shape. When a timezone is present, we check whether
        // the current moment falls inside the [sendStartHour, sendEndHour) window
        // in that timezone. If not, we sleep until the next window opens.
        // recipientRaw may be:
        //   • a plain string  "alice@example.com"            (legacy)
        //   • a pipe string   "alice@example.com|America/NYC" (legacy)
        //   • a rich object   { email, tz, firstName, lastName, city,
        //                       lastOrderDate, membershipLevel, referralCode, ... }
        //   The UI now sends rich objects when JSON lines are parsed by
        //   parseRecipients(); plain strings are kept for backward compat.
        let recipientEmail, recipientTz, recipientData;
        if (typeof recipientRaw === 'object' && recipientRaw !== null) {
            recipientEmail = (recipientRaw.email || '').trim();
            recipientTz    = (recipientRaw.tz    || '').trim();
            recipientData  = recipientRaw;               // full schema for Handlebars
        } else {
            recipientEmail = String(recipientRaw).trim();
            recipientTz    = '';
            recipientData  = { email: recipientEmail };  // minimal context
        }

        if (recipientTz) {
            const msUntilWindow = msUntilSendWindow(recipientTz, sendStartHour, sendEndHour);
            if (msUntilWindow > 0) {
                const hh = (msUntilWindow / 3600000).toFixed(2);
                const tzMsg = `[TZ-QUEUE] ${recipientEmail} (${recipientTz}) — outside send window. Waiting ${hh}h.`;
                results.logs.push(tzMsg);
                emit('send:event', { status: 'rest', recipient: recipientEmail, smtp: null, message: tzMsg, timestamp: Date.now() });
                await new Promise((r) => setTimeout(r, msUntilWindow));
                emit('send:event', { status: 'info', recipient: recipientEmail, smtp: null, message: `[TZ-QUEUE] Window opened for ${recipientEmail}. Sending now.`, timestamp: Date.now() });
            }
        }

        const recipient = recipientEmail;  // clean email string used for all downstream logic

        // ── Blacklist guard ───────────────────────────────────────────────────
        if (blacklistSet.has(recipient.toLowerCase())) {
            const skipMsg = `[SKIPPED] ${recipient} is blacklisted (bounce/DSN detected).`;
            results.logs.push(skipMsg);
            emit('send:event', { status: 'warn', recipient, smtp: null, message: skipMsg, timestamp: Date.now() });
            emit('batch:progress', { success: results.success, failed: results.failed, total: recipients.length, timestamp: Date.now() });
            continue;
        }

        // ── Pre-send validation ───────────────────────────────────────────────
        // Runs after the blacklist check to avoid wasting network calls on
        // already-known-bad addresses. DNS/SMTP results are cached per domain
        // so the cost per unique domain is paid only once per batch.
        const vResult = await validateRecipient(recipient, vMode);
        if (!vResult.valid) {
            results.failed++;
            const invalidMsg = `[INVALID] ${recipient} — ${vResult.reason}`;
            results.logs.push(invalidMsg);
            emit('send:event', { status: 'invalid', recipient, smtp: null, message: invalidMsg, timestamp: Date.now() });
            emit('batch:progress', { success: results.success, failed: results.failed, total: recipients.length, timestamp: Date.now() });
            continue;
        }

        // ── Warm-up hourly rate cap ──────────────────────────────────────────
        if (warmupMode && warmupHourlyLimit !== null && warmupSentThisHour >= warmupHourlyLimit) {
            const hourElapsed = Date.now() - warmupHourStart;
            const waitMs = Math.max(0, 3600000 - hourElapsed);
            const capMsg = `[WARMUP] Hourly cap of ${warmupHourlyLimit} reached (Day ${warmupDay || 1}). Waiting ${Math.ceil(waitMs / 60000)}m for next window.`;
            results.logs.push(capMsg);
            emit('send:event', { status: 'warn', recipient: null, smtp: null, message: capMsg, timestamp: Date.now() });
            emit('batch:paused', { duration: waitMs, reason: 'warmup', timestamp: Date.now() });
            if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
            warmupHourStart = Date.now();
            warmupSentThisHour = 0;
            emit('send:event', { status: 'info', recipient: null, smtp: null, message: '[WARMUP] New hour window opened. Resuming.', timestamp: Date.now() });
        }

        
        if (!graphEnabled && sendCounter >= limit) {
            smtpIndex = (smtpIndex + 1) % smtps.length;
            sendCounter = 0;
            const relayMsg = `[RELAY] Rotated to SMTP ${smtpIndex + 1} (${smtps[smtpIndex].host})`;
            results.logs.push(relayMsg);
            emit('send:event', { status: 'relay', recipient: null, smtp: smtps[smtpIndex].host, message: relayMsg, timestamp: Date.now() });
        }

        const smtp = graphEnabled ? null : smtps[smtpIndex];
        const pickedFromName = resolvedFromNames.length > 0
            ? resolvedFromNames[Math.floor(Math.random() * resolvedFromNames.length)]
            : (fromName || '');
        const tagData = { tfn: tfn || '', invoiceItems: parsedInvoiceItems };

        // ── Per-recipient content pipeline ────────────────────────────────────
        // Pass 1 — Handlebars: resolve {{firstName}}, {{#if membershipLevel "Gold"}}, etc.
        // Pass 2 — Spintax:    resolve {option1|option2|option3}
        // Pass 3 — $tags:      resolve $tfn, $#SEVEN, $invoice_table
        // Pass 4 — LLM:        rewrite subject (subject line only)
        // Pass 5 — DOM noise + link cloaking
        
        // ── Enhanced Round-Robin Body & Subject Rotation ──────────────────────
        // Use round-robin for even distribution, then add randomization within groups
        const rotateEveryNValue = Math.max(1, parseInt(rotateEveryN, 10) || 3);
        const rotationModeValue = String(rotationMode || 'smart').toLowerCase(); // 'smart', 'round-robin', 'random', 'weighted'
        
        // Smart body rotation: multiple strategies available
        let pickedBody;
        if (bodies.length === 1) {
            pickedBody = bodies[0];
        } else {
            switch (rotationModeValue) {
                case 'round-robin':
                    // Pure round-robin distribution
                    pickedBody = bodies[bodyRotationIndex % bodies.length];
                    bodyRotationIndex++;
                    break;
                
                case 'random':
                    // Pure random (original behavior)
                    pickedBody = bodies[Math.floor(Math.random() * bodies.length)];
                    break;
                
                case 'weighted':
                    // Weighted random based on inverse usage (less used templates get higher priority)
                    const bodyWeights = bodies.map((_, idx) => {
                        const key = `body_${idx}`;
                        const usage = rotationStats.bodyUsage.get(key) || 0;
                        return Math.max(1, (rotationStats.totalSent + 1) / (usage + 1));
                    });
                    const totalWeight = bodyWeights.reduce((sum, w) => sum + w, 0);
                    const randomWeight = Math.random() * totalWeight;
                    let weightSum = 0;
                    for (let i = 0; i < bodies.length; i++) {
                        weightSum += bodyWeights[i];
                        if (randomWeight <= weightSum) {
                            pickedBody = bodies[i];
                            break;
                        }
                    }
                    pickedBody = pickedBody || bodies[0]; // fallback
                    break;
                
                case 'smart':
                default:
                    // Intelligent rotation with grouping and randomization
                    if (bodies.length <= 3) {
                        // For small sets, use pure round-robin
                        pickedBody = bodies[bodyRotationIndex % bodies.length];
                        bodyRotationIndex++;
                    } else {
                    // For larger sets, rotate every N emails within smaller random groups
                    const groupIndex = Math.floor(bodyRotationIndex / rotateEveryNValue) % bodies.length;
                        const groupSize = Math.min(3, bodies.length - groupIndex);
                        const randomOffset = Math.floor(Math.random() * groupSize);
                        const selectedIndex = (groupIndex + randomOffset) % bodies.length;
                        pickedBody = bodies[selectedIndex];
                        bodyRotationIndex++;
                    }
                    break;
            }
        }
        
        // Smart subject rotation: same advanced strategies as body rotation
        let pickedSubject;
        if (subjects.length === 1) {
            pickedSubject = subjects[0];
        } else {
            switch (rotationModeValue) {
                case 'round-robin':
                    // Pure round-robin distribution
                    pickedSubject = subjects[subjectRotationIndex % subjects.length];
                    subjectRotationIndex++;
                    break;
                
                case 'random':
                    // Pure random (original behavior)
                    pickedSubject = subjects[Math.floor(Math.random() * subjects.length)];
                    break;
                
                case 'weighted':
                    // Weighted random based on inverse usage
                    const subjectWeights = subjects.map((_, idx) => {
                        const key = `subject_${idx}`;
                        const usage = rotationStats.subjectUsage.get(key) || 0;
                        return Math.max(1, (rotationStats.totalSent + 1) / (usage + 1));
                    });
                    const totalSubjectWeight = subjectWeights.reduce((sum, w) => sum + w, 0);
                    const randomSubjectWeight = Math.random() * totalSubjectWeight;
                    let subjectWeightSum = 0;
                    for (let i = 0; i < subjects.length; i++) {
                        subjectWeightSum += subjectWeights[i];
                        if (randomSubjectWeight <= subjectWeightSum) {
                            pickedSubject = subjects[i];
                            break;
                        }
                    }
                    pickedSubject = pickedSubject || subjects[0]; // fallback
                    break;
                
                case 'smart':
                default:
                    // Intelligent rotation with grouping and randomization
                    if (subjects.length <= 3) {
                        // For small sets, use pure round-robin
                        pickedSubject = subjects[subjectRotationIndex % subjects.length];
                        subjectRotationIndex++;
                    } else {
                    // For larger sets, rotate every N emails within smaller random groups
                    const groupIndex = Math.floor(subjectRotationIndex / rotateEveryNValue) % subjects.length;
                        const groupSize = Math.min(3, subjects.length - groupIndex);
                        const randomOffset = Math.floor(Math.random() * groupSize);
                        const selectedIndex = (groupIndex + randomOffset) % subjects.length;
                        pickedSubject = subjects[selectedIndex];
                        subjectRotationIndex++;
                    }
                    break;
            }
        }
        
        // Track rotation usage for analytics
        const bodyKey = `body_${bodies.indexOf(pickedBody)}`;
        const subjectKey = `subject_${subjects.indexOf(pickedSubject)}`;
        rotationStats.bodyUsage.set(bodyKey, (rotationStats.bodyUsage.get(bodyKey) || 0) + 1);
        rotationStats.subjectUsage.set(subjectKey, (rotationStats.subjectUsage.get(subjectKey) || 0) + 1);
        rotationStats.totalSent++;
const resolvedSubject = applyTags(spinText(renderTemplate(pickedSubject, recipientData)), tagData, recipientData);
        
        // 1. Get the base subject (with LLM rewrite if enabled)
        const baseSubject = await rewriteText(resolvedSubject, llmApiKey || '');
        
        // 2. Generate a small random ID (e.g., "A5B2")
        const subjectSalt = crypto.randomBytes(2).toString('hex').toUpperCase();
        
        // 3. Append it to the end
        const finalSubject = `${baseSubject} [ID: ${subjectSalt}]`;

        // 1. Generate the Master HMAC Signature for this recipient BEFORE rendering
        const transactionUuid = crypto.randomUUID();
        const hmacSignature = crypto.createHmac('sha256', AUTH_SECRET).update(`${transactionUuid}:${recipient}`).digest('hex');

        const renderedBody = renderTemplate(pickedBody, recipientData);
        
        // 2. Generate the base HTML
        // Pick domain for this email: rotate every N emails
       const emailDomain = activeDomains.length > 0
            ? activeDomains[Math.floor(emailsSent / rotateEvery) % activeDomains.length]
            : null;
            
        // FIX: Cloak the links FIRST, then randomize the HTML
        // --- Pass 5: Replace the $UNQ4 tag with your unique UUID ---
const cleanBaseHtml = applyTags(spinText(renderedBody), tagData, recipientData);

// ADD THIS LINE: It replaces all $UNQ4 tags with the ID generated at line 598
const uuidHtml = cleanBaseHtml.replace(/\$UNQ4/g, transactionUuid);

const finalHtml = emailDomain
            ? randomizeHtml(cloakLinks(uuidHtml, [emailDomain]))
            : randomizeHtml(uuidHtml);

        // 1. Generate a unique 32-character hex hash for this specific recipient
        const bodyHash = crypto.randomBytes(16).toString('hex');
        
        // 2. Inject it as a hidden, transparent <div> that humans can't see
        const saltedHtml = `${finalHtml}\n<div style="display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; font-size:0;">#${bodyHash}</div>`;

        // 3. Keep your audit signature as well, but attach it to the saltedHtml
        const signedHtml = `${saltedHtml}\n`;

        
        let attachments = [];
        let attachTempPath = null;
        if (attachHtml && attachFormat && attachFormat !== 'none') {
            try {
               // FIX: Cloak the links FIRST, then randomize the attachment HTML
                const cleanAttachHtml = applyTags(spinText(renderTemplate(attachHtml, recipientData)), tagData, recipientData);
                const finalAttachHtml = emailDomain
                    ? randomizeHtml(cloakLinks(cleanAttachHtml, [emailDomain]))
                    : randomizeHtml(cleanAttachHtml);

                // Build per-recipient invoice details so processInvoicePdf can
                // stamp the recipient's name, membership level, and a unique
                // invoice number into the PDF Info + XMP metadata.
                
                const invoiceDetails = {
                    invoiceNumber:   `INV-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
                    transactionUuid: transactionUuid,
                    signature:       hmacSignature, // <-- New signed payload
                    recipientName:   [recipientData.firstName, recipientData.lastName].filter(Boolean).join(' ') || null,
                    email:           recipient,
                    membershipLevel: recipientData.membershipLevel || null,
                    city:            recipientData.city || null,
                };

                const { tempPath, filename } = await renderAttachment(finalAttachHtml, attachFormat, invoiceDetails);
                attachTempPath = tempPath;
                attachments = [{ filename, path: tempPath }];
            } catch (renderErr) {
                const msg = `${recipient}: Attachment render failed – ${renderErr.message}`;
                results.logs.push(msg);
                emit('send:event', { status: 'warn', recipient, smtp: graphEnabled ? 'graph-api' : smtp.host, message: msg, timestamp: Date.now() });
            }
        }

        // ── One-click unsubscribe URL (RFC 8058) ────────────────────────────────
        // Uses the first redirect domain (already pointed at this server) to expose
        // /unsub publicly. Without a redirect domain, the header is omitted.
        const unsubUrl = activeDomains.length > 0
    ? `https://${activeDomains[0]}/unsub?e=${Buffer.from(recipient.toLowerCase()).toString('base64url')}`
    : null;

       try {
            let info;
            if (graphEnabled) {
                const pickedGraph = graphAccounts[recipientIndex % graphAccounts.length];
                await sendGraphMail({ graphConfig: pickedGraph, recipient, subject: finalSubject, html: signedHtml, unsubUrl: unsubUrl });
                info = { messageId: `graph-${Date.now()}-${crypto.randomBytes(3).toString('hex')}` };
            } else if (gmailEnabled) {
                const gmailIdx = recipientIndex % gmailAccounts.length;
                const account = gmailAccounts[gmailIdx];
                // Ensure transactionUuid is passed here
await sendGmail({ 
    account, 
    recipient, 
    subject: finalSubject, 
    html: signedHtml, 
    fromName: pickedFromName, 
    transactionUuid: transactionUuid,
    unsubUrl: unsubUrl
});
                info = { messageId: `gmail-${Date.now()}-${crypto.randomBytes(3).toString('hex')}` };
            } else {
                // --- Updated Header Rotation Logic ---
                const mailerClients = ['Outlook 16.0', 'Apple Mail (2.34)', 'Thunderbird 102', 'Gmail Web/1.0'];
                const pickedMailer = mailerClients[Math.floor(Math.random() * mailerClients.length)];
                const complianceId = crypto.randomBytes(8).toString('hex');

                info = await sendMail({
                    smtp,
                    recipient,
                    subject: finalSubject,
                    html: signedHtml,
                    attachments,
                    fromName: pickedFromName,
                    unsubUrl,
                    transporter: _transporterPool[smtpIndex] || null
                });
            }
            results.success++; // Ensure this has the "s"
            emailsSent++; 
            if (!graphEnabled && !gmailEnabled) sendCounter++;
            adaptiveDelayFactor = Math.max(1, adaptiveDelayFactor * ADAPTIVE_DELAY_RECOVERY);
            warmupSentThisHour++;
            batchSendCount++;
            
            // Record successful delivery
            deliverabilityMonitor.recordSend(recipient, smtp, true, false, false);
            const via = graphEnabled ? `graph-${graphAccounts[recipientIndex % graphAccounts.length]?.sender || 'api'}` : gmailEnabled ? `gmail-${gmailAccounts[recipientIndex % gmailAccounts.length]?.senderEmail || 'api'}` : smtp.host;
            const msg = `[SUCCESS] ${recipient} via ${via}`;
            results.logs.push(msg);
            emit('send:event', {
                status: 'success',
                recipient,
                smtp: via,
                messageId: info.messageId,
                message: msg,
                rotation: {
                    bodyUsed: `body_${bodies.indexOf(pickedBody)}`,
                    subjectUsed: `subject_${subjects.indexOf(pickedSubject)}`,
                    bodyIndex: bodies.indexOf(pickedBody),
                    subjectIndex: subjects.indexOf(pickedSubject)
                },
                timestamp: Date.now(),
            });
        } catch (err) {
            results.failed++; // Ensure this has the "s"
            batchSendCount++;
            
            // Record failed delivery
            const isBounce = err.responseCode && [550, 551, 553, 554].includes(err.responseCode);
            deliverabilityMonitor.recordSend(recipient, smtp, false, isBounce, false);
            const errCode = err.responseCode || parseInt(((err.message || '').match(/^(\d{3})/) || [])[1], 10);
            if (!graphEnabled && (errCode === 421 || errCode === 454)) {
                const pauseMs = SMTP_COOLDOWN_MS;
                smtpCooldownUntil[smtpIndex] = Date.now() + pauseMs;
                adaptiveDelayFactor = Math.min(ADAPTIVE_DELAY_MAX, adaptiveDelayFactor + ADAPTIVE_DELAY_STEP_UP);
                const pauseMsg = `[COOLDOWN] ${errCode} from ${smtp.host} — cooling this SMTP for ${Math.ceil(pauseMs / 60000)} minutes and slowing pace x${adaptiveDelayFactor.toFixed(2)}.`;
                results.logs.push(pauseMsg);
                emit('send:event', { status: 'warn', recipient, smtp: smtp.host, message: pauseMsg, timestamp: Date.now() });
                emit('batch:paused', { duration: pauseMs, reason: String(errCode || 'rate-limit'), timestamp: Date.now() });
                smtpIndex = (smtpIndex + 1) % smtps.length;
                sendCounter = 0;
            }
            const msg = `[FAILED] ${recipient} – ${err.message}`;
            results.logs.push(msg);
            emit('send:event', {
                status: 'failed',
                recipient,
                smtp: graphEnabled ? 'graph-api' : smtp.host,
                message: msg,
                timestamp: Date.now(),
            });
        } finally {
            if (attachTempPath) {
                await fs.promises.unlink(attachTempPath).catch(() => {});
                attachTempPath = null;
            }
        }

        emit('batch:progress', {
            success: results.success,
            failed: results.failed,
            total: recipients.length,
            rotation: {
                bodyDistribution: Object.fromEntries(rotationStats.bodyUsage),
                subjectDistribution: Object.fromEntries(rotationStats.subjectUsage),
                currentStats: {
                    totalBodiesUsed: rotationStats.bodyUsage.size,
                    totalSubjectsUsed: rotationStats.subjectUsage.size,
                    mode: rotationModeValue,
                    processed: rotationStats.totalSent
                }
            },
            timestamp: Date.now(),
        });

        // ── Batch boundary + rest period ─────────────────────────────────────
        // Triggered after a successful or failed send (batchSendCount updated
        // above in both try and catch). Skipped if batching is not configured.
        if (batchingEnabled && batchSendCount >= nextBatchLimit) {
            batchSendCount = 0;
            // Pick a new random boundary for the next batch (±25% of batchMin)
            nextBatchLimit = Math.max(1, Math.round(batchMin * (0.75 + Math.random() * 0.5)));

            if (restMax > 0) {
                const restSecs = (restMin + Math.random() * (restMax - restMin)) * 60;
                const restMs   = Math.round(restSecs * 1000);
                const restMins = (restSecs / 60).toFixed(1);
                const restMsg  = `[BATCH] Micro-batch complete. Resting for ${restMins} min — running IMAP engagement.`;
                results.logs.push(restMsg);
                emit('send:event', { status: 'rest', recipient: null, smtp: null, message: restMsg, timestamp: Date.now() });
                emit('batch:paused', { duration: restMs, reason: 'batch-rest', timestamp: Date.now() });

                // Run IMAP engagement (bounce scan + read random messages) while
                // waiting. This fires the existing bounceMonitor logic which marks
                // random inbox messages as read and rescans Spam — the exact
                // engagement behaviour that boosts sender reputation.
                bounceMonitor.runScan(io).catch(() => {});

                await new Promise((r) => setTimeout(r, restMs));
                emit('send:event', { status: 'info', recipient: null, smtp: null, message: '[BATCH] Rest complete. Resuming sends.', timestamp: Date.now() });
            }
        }

        // ── Per-email inter-send delay with ±20% cadence fingerprint jitter ──
        // Base delay: uniform random in [minDelay, maxDelay].
        // Cadence jitter: multiply by a factor in [0.80, 1.20] so every account
        // operates on a slightly different rhythm — no two senders share the same
        // inter-message cadence, defeating fingerprinting by Gmail / M365 AI.
        const dMin = Math.max(0, parseFloat(minDelay) || 0);
        const dMax = Math.max(dMin, parseFloat(maxDelay) || 0);
        if (dMax > 0) {
            const base          = dMin + Math.random() * (dMax - dMin);
            const cadenceFactor = 0.80 + Math.random() * 0.40;   // ±20%
            const actual        = base * cadenceFactor * adaptiveDelayFactor;
            await new Promise((r) => setTimeout(r, actual * 1000));
        }
        recipientIndex++;
    }

    // ── Compile rotation statistics for the final report ──────────────────────
    const rotationReport = {
        bodyDistribution: Object.fromEntries(rotationStats.bodyUsage),
        subjectDistribution: Object.fromEntries(rotationStats.subjectUsage),
        totalBodiesUsed: bodies.length,
        totalSubjectsUsed: subjects.length,
        avgBodyUsage: rotationStats.totalSent > 0 ? (rotationStats.totalSent / bodies.length).toFixed(2) : 0,
        avgSubjectUsage: rotationStats.totalSent > 0 ? (rotationStats.totalSent / subjects.length).toFixed(2) : 0,
        rotationEfficiency: {
            bodySpread: rotationStats.bodyUsage.size / bodies.length,
            subjectSpread: rotationStats.subjectUsage.size / subjects.length
        }
    };

    // Mark this batch as done and clean up.
    _batchMap.delete(batchKey);
    _transporterPool.forEach(t => { try { if (t) t.close(); } catch {} });
    
    const finalResults = {
        ...results,
        rotation: rotationReport,
        batchStats: {
            totalProcessed: recipients.length,
            successRate: ((results.success / recipients.length) * 100).toFixed(2) + '%',
            timestamp: Date.now()
        }
    };
    
    emit('batch:complete', { 
        success: results.success, 
        failed: results.failed, 
        total: recipients.length, 
        rotation: rotationReport,
        timestamp: Date.now() 
    });
    
    })(); // Closes the background function
}); // Closes the app.post route


// ── Batch control endpoints ───────────────────────────────────────────────────
// Helper: emit an event to the socket that owns a given batchKey.
function emitToBatch(batchKey, event, data) {
    if (!io) return;
    if (batchKey && batchKey !== '__global__') {
        io.to(batchKey).emit(event, data);
    } else {
        io.emit(event, data);
    }
}

app.post('/api/batch/stop', (req, res) => {
    const sid = String(req.body?.socketId || '').trim() || '__global__';
    const state = _batchMap.get(sid);
    if (state && state !== 'stopped') {
        _batchMap.set(sid, 'stopped');
        emitToBatch(sid, 'send:event', { status: 'warn', recipient: null, smtp: null, message: '[CONTROL] Stop signal sent.', timestamp: Date.now() });
    }
    res.json({ ok: true });
});

app.post('/api/batch/pause', (req, res) => {
    const sid = String(req.body?.socketId || '').trim() || '__global__';
    const state = _batchMap.get(sid);
    if (state === 'running') {
        _batchMap.set(sid, 'paused');
        emitToBatch(sid, 'send:event', { status: 'rest', recipient: null, smtp: null, message: '[CONTROL] Batch paused by user.', timestamp: Date.now() });
    }
    res.json({ ok: true, state: _batchMap.get(sid) || 'idle' });
});

app.post('/api/batch/resume', (req, res) => {
    const sid = String(req.body?.socketId || '').trim() || '__global__';
    const state = _batchMap.get(sid);
    if (state === 'paused') {
        _batchMap.set(sid, 'running');
        emitToBatch(sid, 'send:event', { status: 'info', recipient: null, smtp: null, message: '[CONTROL] Batch resumed by user.', timestamp: Date.now() });
    }
    res.json({ ok: true, state: _batchMap.get(sid) || 'idle' });
});

// ── Rotation Statistics Endpoint ─────────────────────────────────────────────
app.get('/api/batch/rotation-stats', (req, res) => {
    // This would require storing rotation stats globally or per session
    // For now, return a sample structure that could be implemented
    res.json({
        message: "Rotation statistics are reported in batch completion events",
        sampleStructure: {
            bodyDistribution: { "body_0": 45, "body_1": 38, "body_2": 42 },
            subjectDistribution: { "subject_0": 41, "subject_1": 44, "subject_2": 40 },
            rotationEfficiency: {
                bodySpread: 1.0,
                subjectSpread: 1.0
            }
        }
    });
});

// ── Deliverability Monitoring Endpoints ─────────────────────────────────────
app.get('/api/deliverability/health', (req, res) => {
    try {
        const health = deliverabilityMonitor.getDeliverabilityHealth();
        res.json(health);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/deliverability/domains', (req, res) => {
    try {
        const analysis = deliverabilityMonitor.getDomainAnalysis();
        res.json({ domains: analysis });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── Content Analysis Endpoint ──────────────────────────────────────────────
app.post('/api/content/analyze', (req, res) => {
    try {
        const { subject, htmlBody, textBody } = req.body;
        
        if (!subject && !htmlBody) {
            return res.status(400).json({ error: 'Subject or HTML body required' });
        }
        
        const analysis = contentAnalyzer.analyzeContent(subject || '', htmlBody || '', textBody || '');
        const grade = contentAnalyzer.getContentGrade(analysis.spamScore);
        const suggestions = contentAnalyzer.getSuggestions(analysis);
        
        res.json({
            ...analysis,
            grade,
            suggestions
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── Domain Authentication Check ────────────────────────────────────────────
app.post('/api/domain/check-auth', async (req, res) => {
    try {
        const { domain } = req.body;
        
        if (!domain) {
            return res.status(400).json({ error: 'Domain is required' });
        }
        
        const authResults = await checkDomainAuth(domain);
        res.json(authResults);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── Engagement Simulation Trigger ─────────────────────────────────────────
app.post('/api/engagement/simulate', async (req, res) => {
    try {
        const imapAccounts = []; // Load from your IMAP accounts storage
        const results = await runEngagementSimulation(imapAccounts, io);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


 
function msUntilSendWindow(tz, startHour, endHour) {
    try {
        const now  = new Date();
        // Use Intl to get the wall-clock hour in the recipient's timezone.
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hour: 'numeric', hour12: false,
            minute: 'numeric',
        }).formatToParts(now);

        const h = parseInt(parts.find(p => p.type === 'hour')?.value   || '0', 10);
        const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
        const currentMinutes = h * 60 + m;
        const startMinutes   = startHour * 60;
        const endMinutes     = endHour   * 60;

        if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
            return 0; // already inside window
        }

        // Calculate wait time until next startHour.
        // If we're past endHour today, wait until startHour tomorrow;
        // if we're before startHour today, wait until startHour today.
        let waitMinutes;
        if (currentMinutes < startMinutes) {
            waitMinutes = startMinutes - currentMinutes;
        } else {
            // past end — wait until start of next day in that tz
            waitMinutes = (24 * 60 - currentMinutes) + startMinutes;
        }
        // Add a small random jitter (0–5 min) so all recipients don't fire
        // simultaneously when the window opens.
        waitMinutes += Math.random() * 5;
        return Math.round(waitMinutes * 60 * 1000);
    } catch {
        return 0; // Unknown timezone — send immediately
    }
}

module.exports = app;
module.exports.setIo = setIo;

// ── IMAP account persistence ─────────────────────────────────────────────────
const IMAP_ACCOUNTS_PATH = path.join(__dirname, 'imap-accounts.json');

app.post('/api/imap-accounts', (req, res) => {
    const accounts = req.body;
    if (!Array.isArray(accounts)) {
        return res.status(400).json({ error: 'Expected an array of IMAP accounts.' });
    }
    for (const a of accounts) {
        if (!a.host || !a.user || !a.pass) {
            return res.status(400).json({ error: 'Each IMAP account requires host, user, and pass.' });
        }
    }
    fs.writeFileSync(IMAP_ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), 'utf8');
    res.json({ saved: accounts.length });
});

// ── Manual bounce scan trigger ────────────────────────────────────────────────
app.post('/api/bounce-scan', async (req, res) => {
    try {
        const added = await bounceMonitor.runScan(io);
        res.json({ ok: true, added });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Blacklist read endpoint ───────────────────────────────────────────────────
app.get('/api/blacklist', (req, res) => {
    const list = [...loadBlacklist()].sort();
    res.json({ count: list.length, addresses: list });
});

app.get('/api/graph/status', (_req, res) => {
    res.json({ ok: true, configured: false, message: 'Graph status is validated on demand via /api/graph/authenticate.' });
});

app.post('/api/graph/authenticate', async (req, res) => {
    try {
        const graphConfig = {
            tenantId: req.body.tenantId,
            clientId: req.body.clientId,
            clientSecret: req.body.clientSecret,
            sender: req.body.sender,
        };
        const sender = String(graphConfig.sender || '').trim();
        if (!sender) return res.status(400).json({ error: 'Sender mailbox is required.' });

        const token = await getGraphAccessToken(graphConfig);
        const whoRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}?$select=id,displayName,mail,userPrincipalName`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const whoData = await whoRes.json().catch(() => ({}));
        if (!whoRes.ok) {
            return res.status(400).json({ error: whoData.error?.message || 'Graph auth failed for sender mailbox.' });
        }
        return res.json({ ok: true, sender: whoData.mail || whoData.userPrincipalName || sender, displayName: whoData.displayName || '' });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

app.post('/api/graph/send-test', async (req, res) => {
    try {
        const graphConfig = {
            tenantId: req.body.tenantId,
            clientId: req.body.clientId,
            clientSecret: req.body.clientSecret,
            sender: req.body.sender,
        };
        const recipient = String(req.body.recipient || '').trim();
        const subject = String(req.body.subject || 'Graph API test').trim();
        const html = String(req.body.html || '<p>Graph API test</p>');
        if (!recipient) return res.status(400).json({ error: 'Recipient is required.' });

        await sendGraphMail({ graphConfig, recipient, subject, html, unsubUrl: null });
        return res.json({ ok: true, recipient });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

// ── Gmail API Management System ─────────────────────────────────────────────
const GMAIL_APPS_PATH = path.join(__dirname, 'gmail-apps.json');
const GMAIL_ACCOUNTS_PATH = path.join(__dirname, 'gmail-accounts.json');

// Store multiple Gmail app credentials and accounts
let gmailApps = []; // Multiple API credentials
let gmailAccounts = []; // All authenticated accounts

// Load Gmail apps (different API credentials)
function loadGmailApps() {
    try {
        if (fs.existsSync(GMAIL_APPS_PATH)) {
            gmailApps = JSON.parse(fs.readFileSync(GMAIL_APPS_PATH, 'utf8'));
        } else {
            // Create default app from environment/file if available
            const defaultApp = loadDefaultGmailApp();
            if (defaultApp) {
                gmailApps = [defaultApp];
                saveGmailApps();
            }
        }
    } catch (e) {
        console.error('Failed to load Gmail apps:', e.message);
        gmailApps = [];
    }
}

function loadDefaultGmailApp() {
    // Check if we already have apps to avoid duplicates
    if (gmailApps.length > 0) return null;
    
    // Try environment variables first (recommended for production)
    if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET) {
        return {
            id: 'env',
            name: 'Environment Gmail API',
            client_id: process.env.GMAIL_CLIENT_ID,
            client_secret: process.env.GMAIL_CLIENT_SECRET,
            project_id: process.env.GMAIL_PROJECT_ID || 'env-project',
            created_at: new Date().toISOString()
        };
    }
    
    // Try loading from google-credentials.json (local development only)
    try {
        const credPath = path.join(__dirname, 'google-credentials.json');
        if (fs.existsSync(credPath)) {
            const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            const gmailCreds = creds.installed || creds.web;
            return {
                id: 'default',
                name: 'Local Gmail API',
                client_id: gmailCreds.client_id,
                client_secret: gmailCreds.client_secret,
                project_id: gmailCreds.project_id || 'local-project',
                created_at: new Date().toISOString()
            };
        }
    } catch (e) {
        // Ignore file not found - this is normal in production
    }
    
    return null;
}

function saveGmailApps() {
    fs.writeFileSync(GMAIL_APPS_PATH, JSON.stringify(gmailApps, null, 2), 'utf8');
}

function removeDuplicateApps() {
    const seen = new Set();
    const uniqueApps = [];
    
    for (const app of gmailApps) {
        const key = `${app.client_id}_${app.name}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueApps.push(app);
        }
    }
    
    if (uniqueApps.length !== gmailApps.length) {
        console.log(`Removed ${gmailApps.length - uniqueApps.length} duplicate Gmail apps`);
        gmailApps.length = 0; // Clear array
        gmailApps.push(...uniqueApps); // Add unique apps
        saveGmailApps();
    }
}

// Load Gmail accounts
function loadGmailAccounts() {
    try {
        if (fs.existsSync(GMAIL_ACCOUNTS_PATH)) {
            const accountsData = JSON.parse(fs.readFileSync(GMAIL_ACCOUNTS_PATH, 'utf8'));
            gmailAccounts = [];
            
            // Recreate OAuth clients for each account
            for (const acc of accountsData) {
                const app = gmailApps.find(a => a.id === acc.appId);
                if (app) {
                    const auth = createOAuth2Client(app);
                    auth.setCredentials(acc.tokens);
                    gmailAccounts.push({
                        ...acc,
                        auth
                    });
                }
            }
        }
    } catch (e) {
        console.error('Failed to load Gmail accounts:', e.message);
        gmailAccounts = [];
    }
}

function saveGmailAccounts() {
    const accountsData = gmailAccounts.map(acc => ({
        id: acc.id,
        appId: acc.appId,
        senderEmail: acc.senderEmail,
        label: acc.label,
        tokens: acc.auth.credentials,
        created_at: acc.created_at
    }));
    fs.writeFileSync(GMAIL_ACCOUNTS_PATH, JSON.stringify(accountsData, null, 2), 'utf8');
}

function createOAuth2Client(app, req = null) {
    let redirectUri;

    // Priority 1: Manual override via environment variable (most reliable)
    if (process.env.GMAIL_REDIRECT_OVERRIDE) {
        redirectUri = process.env.GMAIL_REDIRECT_OVERRIDE;
    }
    // Priority 2: If DOMAIN is set, always use https with that domain
    else if (process.env.DOMAIN) {
        redirectUri = `https://${process.env.DOMAIN}/api/gmail/callback`;
    }
    // Priority 3: Auto-detect from request headers (for local dev)
    else if (req && req.headers) {
        const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        redirectUri = `${protocol}://${host}/api/gmail/callback`;
    }
    // Priority 4: Local development fallback
    else {
        redirectUri = `http://localhost:${process.env.PORT || 3005}/api/gmail/callback`;
    }

    console.log(`[OAuth] Using redirect URI: ${redirectUri}`);
    
    return new google.auth.OAuth2(
        app.client_id,
        app.client_secret,
        redirectUri
    );
}

// Initialize Gmail system
loadGmailApps();
removeDuplicateApps();
loadGmailAccounts();

// Legacy Gmail token migration (backward compatibility)
function migrateLegacyGmailTokens() {
    const legacyPath = path.join(__dirname, 'gmail-tokens.json');
    if (fs.existsSync(legacyPath) && gmailAccounts.length === 0) {
        try {
            const legacyData = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
            const defaultApp = gmailApps[0];
            
            if (defaultApp && legacyData.length > 0) {
                console.log('Migrating legacy Gmail tokens...');
                for (const entry of legacyData) {
                    const auth = createOAuth2Client(defaultApp);
                    auth.setCredentials(entry.tokens);
                    
                    gmailAccounts.push({
                        id: `migrated_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        appId: defaultApp.id,
                        auth,
                        senderEmail: entry.senderEmail,
                        label: entry.label || `Migrated: ${entry.senderEmail}`,
                        created_at: new Date().toISOString()
                    });
                }
                saveGmailAccounts();
                console.log(`Migrated ${legacyData.length} Gmail accounts`);
            }
        } catch (e) {
            console.error('Legacy Gmail token migration failed:', e.message);
        }
    }
}

// Backward compatibility - use first available OAuth client
function getDefaultOAuth2Client() {
    if (gmailApps.length === 0) return null;
    return createOAuth2Client(gmailApps[0]);
}

// Gmail Apps Management Routes
app.get('/api/gmail/apps', (req, res) => {
    const apps = gmailApps.map(app => ({
        id: app.id,
        name: app.name,
        project_id: app.project_id,
        client_id: app.client_id,
        created_at: app.created_at,
        accounts_count: gmailAccounts.filter(acc => acc.appId === app.id).length
    }));
    res.json({ apps });
});

app.post('/api/gmail/apps', (req, res) => {
    try {
        const { name, credentials } = req.body;
        
        if (!name || !credentials) {
            return res.status(400).json({ error: 'Name and credentials required' });
        }
        
        let parsedCreds;
        if (typeof credentials === 'string') {
            parsedCreds = JSON.parse(credentials);
        } else {
            parsedCreds = credentials;
        }
        
        const gmailCreds = parsedCreds.installed || parsedCreds.web;
        if (!gmailCreds || !gmailCreds.client_id || !gmailCreds.client_secret) {
            return res.status(400).json({ error: 'Invalid Gmail credentials format' });
        }
        
        const existingByClient = gmailApps.find(app => app.client_id === gmailCreds.client_id);
        if (existingByClient) {
            return res.status(409).json({
                error: 'This Gmail API app is already added.',
                app: existingByClient
            });
        }

        const appId = `app_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newApp = {
            id: appId,
            name,
            client_id: gmailCreds.client_id,
            client_secret: gmailCreds.client_secret,
            project_id: gmailCreds.project_id || 'unknown',
            created_at: new Date().toISOString()
        };
        
        gmailApps.push(newApp);
        saveGmailApps();
        
        res.json({ success: true, app: newApp });
    } catch (e) {
        res.status(400).json({ error: 'Failed to add Gmail app: ' + e.message });
    }
});

app.delete('/api/gmail/apps/:appId', (req, res) => {
    try {
        const { appId } = req.params;
        const appIndex = gmailApps.findIndex(app => app.id === appId);
        
        if (appIndex === -1) {
            return res.status(404).json({ error: 'Gmail app not found' });
        }
        
        // Remove all accounts associated with this app
        gmailAccounts = gmailAccounts.filter(acc => acc.appId !== appId);
        saveGmailAccounts();
        
        // Remove the app
        gmailApps.splice(appIndex, 1);
        saveGmailApps();
        
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: 'Failed to remove Gmail app: ' + e.message });
    }
});

// Start OAuth for a specific app
app.get('/api/gmail/auth/:appId', (req, res) => {
    try {
        const { appId } = req.params;
        const app = gmailApps.find(a => a.id === appId);
        
        if (!app) {
            return res.status(404).json({ error: 'Gmail app not found' });
        }
        
        const oauth2Client = createOAuth2Client(app, req);
        const url = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'select_account consent',
            scope: [
                'https://www.googleapis.com/auth/gmail.send',
                'https://www.googleapis.com/auth/gmail.readonly',
                'https://www.googleapis.com/auth/userinfo.email'
            ],
            state: appId // Pass app ID in state
        });
        
        res.redirect(url);
    } catch (e) {
        res.status(400).json({ error: 'Failed to start auth: ' + e.message });
    }
});

// Legacy route for backward compatibility + universal fallback
app.get('/api/gmail/auth', (req, res) => {
    if (gmailApps.length === 0) {
        return res.status(400).json({ error: 'No Gmail apps configured. Add a Gmail app first.' });
    }
    
    // Create OAuth directly without state (universal fallback)
    try {
        const app = gmailApps[0];
        const oauth2Client = createOAuth2Client(app, req);
        const url = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'select_account consent',
            scope: [
                'https://www.googleapis.com/auth/gmail.send',
                'https://www.googleapis.com/auth/gmail.readonly',
                'https://www.googleapis.com/auth/userinfo.email'
            ],
            state: app.id // Ensure state is set
        });
        
        res.redirect(url);
    } catch (e) {
        res.status(400).json({ error: 'Failed to start auth: ' + e.message });
    }
});

// 3. Callback route to handle the response from Google
app.get('/api/gmail/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        
        if (!code) {
            return res.status(400).send('<h1>Authentication failed!</h1><p>No authorization code received.</p>');
        }
        
        // Find the app from state parameter
        let appId = state;
        let app = gmailApps.find(a => a.id === appId);
        
        // Fallback: if no app found by state, try to use the first available app
        if (!app && gmailApps.length > 0) {
            console.log(`Warning: App ID "${appId}" not found, using first available app`);
            app = gmailApps[0];
            appId = app.id;
        }
        
        if (!app) {
            return res.status(400).send(`
                <h1>Authentication failed!</h1>
                <p>No Gmail apps configured. Please add a Gmail API app first.</p>
                <p>State received: ${state || 'none'}</p>
                <p>Available apps: ${gmailApps.length}</p>
                <script>setTimeout(() => window.close(), 3000);</script>
            `);
        }
        
        const oauth2Client = createOAuth2Client(app, req);
        const { tokens } = await oauth2Client.getToken(code);
        
        oauth2Client.setCredentials(tokens);
        
        // Get user profile
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const senderEmail = profile.data.emailAddress;
        
        // Check if account already exists
        const existingAccount = gmailAccounts.find(acc => 
            acc.senderEmail === senderEmail && acc.appId === appId
        );
        
        if (existingAccount) {
            // Update existing account tokens
            existingAccount.auth.setCredentials(tokens);
            existingAccount.tokens = tokens;
        } else {
            // Add new account
            const accountId = `acc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            gmailAccounts.push({
                id: accountId,
                appId: appId,
                auth: oauth2Client,
                senderEmail: senderEmail,
                label: `${app.name}: ${senderEmail}`,
                created_at: new Date().toISOString()
            });
        }
        
        saveGmailAccounts();
        
        res.send(`
            <h1>✅ Gmail Account Connected!</h1>
            <p><strong>Account:</strong> ${senderEmail}</p>
            <p><strong>App:</strong> ${app.name}</p>
            <p><strong>Status:</strong> Ready to send emails</p>
            <script>
                setTimeout(() => {
                    window.close();
                    if (window.opener) {
                        window.opener.postMessage('gmail_auth_success', '*');
                    }
                }, 2000);
            </script>
        `);
    } catch (err) {
        console.error('Gmail auth callback error:', err);
        res.status(400).send('<h1>Authentication failed!</h1><p>' + err.message + '</p>');
    }
});

app.get('/api/gmail/accounts', (req, res) => {
    const accounts = gmailAccounts.map((a, i) => ({ 
        id: a.id,
        index: i, 
        appId: a.appId,
        appName: gmailApps.find(app => app.id === a.appId)?.name || 'Unknown App',
        senderEmail: a.senderEmail, 
        label: a.label,
        created_at: a.created_at
    }));
    return res.json({ accounts });
});

app.delete('/api/gmail/accounts/:accountId', (req, res) => {
    try {
        const { accountId } = req.params;
        const accountIndex = gmailAccounts.findIndex(acc => acc.id === accountId);
        
        if (accountIndex === -1) {
            return res.status(404).json({ error: 'Gmail account not found.' });
        }
        
        gmailAccounts.splice(accountIndex, 1);
        saveGmailAccounts();
        
        return res.json({ success: true });
    } catch (e) {
        return res.status(400).json({ error: 'Failed to remove account: ' + e.message });
    }
});

app.post('/api/gmail/send-test', async (req, res) => {
    try {
        const { accountId, index, recipient, subject, html } = req.body;
        
        let account;
        if (accountId) {
            account = gmailAccounts.find(acc => acc.id === accountId);
        } else if (index !== undefined) {
            const idx = parseInt(index, 10);
            account = gmailAccounts[idx];
        } else {
            account = gmailAccounts[0]; // Default to first account
        }
        
        if (!account) {
            return res.status(400).json({ error: 'No Gmail account found' });
        }
        
        if (!recipient || !recipient.trim()) {
            return res.status(400).json({ error: 'Recipient required.' });
        }
        
        const testSubject = subject || 'Gmail API Test';
        const testHtml = html || '<p>Gmail API test message</p>';
        
        await sendGmail({ 
            account, 
            recipient: recipient.trim(), 
            subject: testSubject, 
            html: testHtml, 
            unsubUrl: null 
        });
        
        return res.json({ 
            success: true, 
            recipient: recipient.trim(),
            account: account.senderEmail,
            app: gmailApps.find(app => app.id === account.appId)?.name || 'Unknown'
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

// Helper function to convert HTML to plain text
function htmlToPlainText(html) {
    if (!html) return "Please view this email in an HTML-compatible client.";
    
    return html
        // Remove script and style elements completely
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
        // Convert common HTML elements to text equivalents
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<\/li>/gi, '\n')
        // Remove all remaining HTML tags
        .replace(/<[^>]*>/g, '')
        // Decode HTML entities
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        // Clean up whitespace
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .replace(/^\s+|\s+$/g, '')
        .trim() || "Please view this email in an HTML-compatible client.";
}

async function sendGmail({ account, recipient, subject, html, fromName, transactionUuid, unsubUrl }) {
    // 1. Generate Rotation Entropy for headers
    const mailerClients = ['Outlook 16.0', 'Apple Mail (2.34)', 'Thunderbird 102', 'Gmail Web/1.0'];
    const pickedMailer = mailerClients[Math.floor(Math.random() * mailerClients.length)];
    const complianceId = crypto.randomBytes(8).toString('hex');

    const boundary = 'boundary_' + crypto.randomBytes(8).toString('hex');
    const from = fromName ? `"${fromName}" <${account.senderEmail}>` : account.senderEmail;
    
    // Generate plain text version from HTML
    const textVersion = htmlToPlainText(html);
    
    // 2. Build the Dual-MIME Raw Message with RFC 8058 Compliance
    const raw = [
        `From: ${from}`,
        `To: ${recipient}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        // RFC 8058 One-Click Unsubscribe Headers (2026 requirement)
        ...(unsubUrl ? [
            `List-Unsubscribe: <${unsubUrl}>`,
            `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
        ] : []),
        `X-Mailer: ${pickedMailer}`, 
        `X-Transaction-ID: ${transactionUuid || crypto.randomUUID()}`,
        `X-Compliance-ID: ${complianceId}`,
        ``,
        // Plain text part (FIRST for better compatibility)
        `--${boundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        `Content-Transfer-Encoding: 7bit`,
        ``,
        textVersion,
        ``,
        // HTML part (SECOND)
        `--${boundary}`,
        `Content-Type: text/html; charset=UTF-8`,
        `Content-Transfer-Encoding: base64`,
        ``,
        Buffer.from(html).toString('base64'),
        `--${boundary}--`,
    ].join('\r\n');

const encodedMessage = Buffer.from(raw).toString('base64url');
    const gmail = google.gmail({ version: 'v1', auth: account.auth });
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedMessage } });
}
