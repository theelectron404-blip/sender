'use strict';

/**
 * Handlebars Template Engine
 *
 * Compiles and renders deeply-personalised email HTML / subjects per recipient.
 * Called as the FIRST pass in the send pipeline, before spintax and $tag
 * replacement, so that Handlebars variables are resolved with live recipient
 * data before any further transformations are applied.
 *
 * Recipient Schema
 * ─────────────────
 * Every recipient object may carry any of the following fields.
 * All are optional — missing fields render as an empty string by default.
 *
 *   email           {string}  REQUIRED  — target address
 *   tz              {string}            — IANA timezone, e.g. "America/New_York"
 *   firstName       {string}            — e.g. "Alice"
 *   lastName        {string}            — e.g. "Johnson"
 *   city            {string}            — e.g. "Chicago"
 *   lastOrderDate   {string}            — ISO or human date, e.g. "2026-03-22"
 *   membershipLevel {string}            — "Gold" | "Silver" | "New" (or any string)
 *   referralCode    {string}            — e.g. "GOLD2026"
 *
 * Any additional fields added to the JSON object are also available inside
 * templates as {{fieldName}}.
 *
 * Template Syntax
 * ───────────────
 * Standard Handlebars syntax is fully supported:
 *
 *   {{firstName}}                         — variable interpolation
 *   {{fullName}}                          — helper: "Alice Johnson"
 *   {{formatDate lastOrderDate}}          — helper: "March 22, 2026"
 *   {{upper membershipLevel}}             — helper: "GOLD"
 *   {{lower email}}                       — helper: "alice@example.com"
 *   {{#if (eq membershipLevel "Gold")}}   — conditional block helper
 *   {{#if (neq membershipLevel "New")}}   — negative conditional
 *   {{#ifAny membershipLevel "Gold" "Silver"}} — multi-value OR conditional
 *   {{#unless firstName}}Anonymous{{/unless}}  — falsy conditional
 *   {{default firstName "Valued Customer"}}    — helper: fallback if blank
 *
 * All Handlebars output is HTML-escaped by default.
 * Use triple-staches {{{varName}}} only for trusted HTML fragments.
 */

const Handlebars = require('handlebars');

// ── Register helpers ──────────────────────────────────────────────────────────

/**
 * {{eq a b}} — strict equality. Used inside {{#if (eq ...)}} blocks.
 * Example: {{#if (eq membershipLevel "Gold")}} … {{/if}}
 */
Handlebars.registerHelper('eq', (a, b) => a === b);

/**
 * {{neq a b}} — strict inequality.
 * Example: {{#if (neq membershipLevel "New")}} … {{/if}}
 */
Handlebars.registerHelper('neq', (a, b) => a !== b);

/**
 * {{#ifAny value "A" "B" "C"}} … {{/ifAny}}
 * Renders the block if `value` equals ANY of the listed strings.
 * Example: {{#ifAny membershipLevel "Gold" "Silver"}}VIP content{{/ifAny}}
 */
Handlebars.registerHelper('ifAny', function (value, ...args) {
    // Last argument is the Handlebars options object — remove it
    const options  = args.pop();
    const matches  = args.includes(value);
    return matches ? options.fn(this) : options.inverse(this);
});

/**
 * {{default value "Fallback"}}
 * Returns `value` if truthy, otherwise `fallback`.
 * Example: {{default firstName "Valued Customer"}}
 */
Handlebars.registerHelper('default', (value, fallback) =>
    (value !== null && value !== undefined && value !== '') ? value : fallback
);

/**
 * {{upper value}} — converts to UPPERCASE.
 */
Handlebars.registerHelper('upper', (value) =>
    typeof value === 'string' ? value.toUpperCase() : ''
);

/**
 * {{lower value}} — converts to lowercase.
 */
Handlebars.registerHelper('lower', (value) =>
    typeof value === 'string' ? value.toLowerCase() : ''
);

/**
 * {{fullName}} — combines firstName + lastName (both from context).
 * Example: {{fullName}} → "Alice Johnson"
 */
Handlebars.registerHelper('fullName', function () {
    const parts = [this.firstName, this.lastName].filter(Boolean);
    return parts.length ? parts.join(' ') : '';
});

/**
 * {{initials}} — first letter of firstName + first letter of lastName.
 * Example: {{initials}} → "AJ"
 */
Handlebars.registerHelper('initials', function () {
    const f = (this.firstName || '').trim()[0] || '';
    const l = (this.lastName  || '').trim()[0] || '';
    return (f + l).toUpperCase();
});

/**
 * {{formatDate dateString}}
 * Converts an ISO date string (or any parseable date) to a long human date.
 * Example: "2026-03-22" → "March 22, 2026"
 * Falls back to the original string if unparseable.
 */
Handlebars.registerHelper('formatDate', (dateString) => {
    if (!dateString) return '';
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return String(dateString);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
});

/**
 * {{daysAgo dateString}}
 * Returns how many days ago the date was.
 * Example: "How long since last order: {{daysAgo lastOrderDate}} days"
 */
Handlebars.registerHelper('daysAgo', (dateString) => {
    if (!dateString) return '';
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return '';
    const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
    return diff;
});

/**
 * {{greeting}} — time-aware greeting based on the current UTC hour.
 * Returns "Good morning" / "Good afternoon" / "Good evening".
 */
Handlebars.registerHelper('greeting', () => {
    const h = new Date().getUTCHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
});

// ── Template compiler ─────────────────────────────────────────────────────────

// Per-process cache: templateSource → compiled Handlebars template function.
// Avoids recompiling the same template string for every recipient in a batch.
const _templateCache = new Map();

/**
 * Compile and cache a Handlebars template string.
 * @param {string} source - Raw Handlebars template source.
 * @returns {Function}    - Compiled Handlebars template function.
 */
function getCompiledTemplate(source) {
    if (_templateCache.has(source)) return _templateCache.get(source);
    const fn = Handlebars.compile(source, { noEscape: false, strict: false });
    _templateCache.set(source, fn);
    return fn;
}

/**
 * Render a Handlebars template with a recipient's data context.
 *
 * @param {string} templateSource  - Raw Handlebars template (subject or body).
 * @param {Object} recipientData   - Recipient object from the parsed list.
 *   Shape: { email, tz?, firstName?, lastName?, city?, lastOrderDate?,
 *            membershipLevel?, referralCode?, ...any extra fields }
 * @returns {string} Rendered string with all Handlebars expressions resolved.
 *
 * Errors during rendering (e.g. malformed template) fall back to the original
 * source so a single bad template never silently kills the whole batch.
 */
function renderTemplate(templateSource, recipientData) {
    if (!templateSource || !templateSource.includes('{{')) return templateSource || '';
    try {
        const fn = getCompiledTemplate(templateSource);
        return fn(recipientData || {});
    } catch (err) {
        // Non-fatal: return raw source so the send can still proceed.
        return templateSource;
    }
}

/**
 * Parse a single line from the recipient textarea into a full recipient object.
 *
 * Accepted formats (all backward-compatible):
 *
 *   Plain email (legacy):
 *     alice@example.com
 *
 *   Email with timezone (legacy):
 *     alice@example.com|America/New_York
 *
 *   Full JSON object (new):
 *     {"email":"alice@example.com","firstName":"Alice","lastName":"Johnson",
 *      "city":"Chicago","lastOrderDate":"2026-03-22",
 *      "membershipLevel":"Gold","referralCode":"GOLD2026","tz":"America/Chicago"}
 *
 * Returns null for blank lines or lines that produce no email address.
 *
 * @param {string} line - A single line from the recipient textarea.
 * @returns {Object|null} Normalised recipient object or null.
 */
function parseRecipientLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // JSON object format
    if (trimmed.startsWith('{')) {
        try {
            const obj = JSON.parse(trimmed);
            if (!obj.email || !obj.email.includes('@')) return null;
            obj.email = obj.email.trim().toLowerCase();
            return obj;
        } catch {
            return null; // malformed JSON → skip
        }
    }

    // Legacy pipe-delimited: email[|tz]
    const parts = trimmed.split('|');
    const email  = (parts[0] || '').trim();
    const tz     = (parts[1] || '').trim();
    if (!email || !email.includes('@')) return null;
    return { email, tz: tz || undefined };
}

/**
 * Clear the compiled-template cache.
 * Call before each batch so template edits take effect without restarting.
 */
function clearTemplateCache() {
    _templateCache.clear();
}

module.exports = { renderTemplate, parseRecipientLine, clearTemplateCache };
