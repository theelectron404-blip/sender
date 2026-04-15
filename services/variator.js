/**
 * Dynamic Content Variator — LLM-powered subject rewriter.
 *
 * Calls the OpenAI Chat Completions API to rewrite a given text string in a
 * slightly different professional tone while preserving its exact meaning.
 *
 * Results are cached in-memory (Map) for the lifetime of the server process.
 * The same input always returns the same output from cache, eliminating
 * redundant API calls for repeated template strings while maintaining maximum
 * diversity across different per-recipient resolved strings (spintax + tags
 * are applied before calling rewriteText, so cache hits are naturally rare).
 *
 * On any API error the original text is returned transparently — a failed
 * rewrite never blocks a send.
 */

// In-memory cache: Map<originalText, rewrittenText>
const _cache = new Map();

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const SYSTEM_PROMPT =
    'You are a professional copywriter. Rewrite the given text in a slightly ' +
    'different professional tone while keeping the exact same meaning. ' +
    'Return only the rewritten text — no explanations, no quotes, no preamble.';

/**
 * Rewrite text via the OpenAI API. Returns the cached result if the same
 * string was already rewritten in this session.
 *
 * @param {string} text   - Plain-text string to rewrite (subject line, intro).
 * @param {string} apiKey - OpenAI API key (sk-...).
 * @returns {Promise<string>} Rewritten text, or original on any failure.
 */
async function rewriteText(text, apiKey) {
    if (!apiKey || !text || !text.trim()) return text;
    if (_cache.has(text)) return _cache.get(text);

    try {
        const res = await fetch(OPENAI_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user',   content: text },
                ],
                max_tokens: 300,
                temperature: 0.75,
            }),
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`OpenAI ${res.status}: ${detail}`);
        }

        const data = await res.json();
        const rewritten = data.choices?.[0]?.message?.content?.trim() || text;
        _cache.set(text, rewritten);
        return rewritten;
    } catch {
        // Silently fall back to original text — never block a send on API errors.
        return text;
    }
}

module.exports = { rewriteText };
