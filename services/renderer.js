const puppeteer = require('puppeteer');
const { PDFDocument, PDFName } = require('pdf-lib');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOFTWARE_CREATORS = [
    'Microsoft Word 365',
    'Adobe Acrobat Pro',
    'QuickBooks Online',
    'Stripe Billing',
    'Excel 2024',
];

function pickRandomSoftwareCreator() {
    return SOFTWARE_CREATORS[Math.floor(Math.random() * SOFTWARE_CREATORS.length)];
}

/**
 * Generate a 7-character uppercase alphanumeric string.
 */
function randomSeven() {
    return crypto.randomBytes(6).toString('base64url').substring(0, 7).toUpperCase();
}

/**
 * Inject a 1×1px invisible watermark in a randomly chosen corner of the HTML.
 * The watermark contains the unique render ID, making every generated file
 * produce a distinct binary hash even if the visible content is identical.
 */
function injectWatermark(html, id) {
    const corners = ['top:0;left:0', 'top:0;right:0', 'bottom:0;left:0', 'bottom:0;right:0'];
    const corner = corners[Math.floor(Math.random() * corners.length)];
    const mark = `<div style="position:fixed;${corner};width:1px;height:1px;` +
        `overflow:hidden;opacity:0;pointer-events:none;font-size:1px;` +
        `color:transparent;background:transparent" aria-hidden="true" ` +
        `data-wmid="${id}">${id}</div>`;
    return html.includes('</body>') ? html.replace('</body>', mark + '</body>') : html + mark;
}

/**
 * Escape a string for safe embedding inside XML / XMP content.
 */
function escXml(s) {
    return String(s || '')
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g,  '&apos;');
}

/**
 * Build a complete Adobe XMP metadata XML packet.
 *
 * Namespaces used:
 *   dc      — Dublin Core (title, creator, description)
 *   xmp     — XMP base (dates, creator tool)
 *   xmpMM   — XMP Media Management (document UUID, instance UUID)
 *   pdf     — PDF extension (Producer)
 *   pdfx    — PDF custom extension (private invoice/hash fields)
 *
 * The packet is wrapped in the standard <?xpacket ...?> processing
 * instructions so conforming XMP readers can locate it by byte scan.
 *
 * @param {Object} fields
 * @returns {string} UTF-8 XMP XML packet.
 */
function buildXmpMetadata(fields) {
    const {
        title, subject, author, producer, creatorTool,
        creationDate, modifyDate,
        documentId, instanceId,
        privateSeed, invoiceNumber, transactionUuid,
    } = fields;

    // Format a JS Date / ISO string into XMP date format: YYYY-MM-DDThh:mm:ss.mss+00:00
    const fmtDate = (d) => {
        const dt  = d instanceof Date ? d : new Date(d);
        const pad = (n, len = 2) => String(n).padStart(len, '0');
        return [
            `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
            `T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`,
            `.${pad(dt.getUTCMilliseconds(), 3)}+00:00`,
        ].join('');
    };

    return [
        '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
        '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 6.0-c002">',
        '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
        '    <rdf:Description rdf:about=""',
        '      xmlns:dc="http://purl.org/dc/elements/1.1/"',
        '      xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
        '      xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"',
        '      xmlns:pdf="http://ns.adobe.com/pdf/1.3/"',
        '      xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/">',
        `      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escXml(title)}</rdf:li></rdf:Alt></dc:title>`,
        `      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escXml(subject)}</rdf:li></rdf:Alt></dc:description>`,
        `      <dc:creator><rdf:Seq><rdf:li>${escXml(author)}</rdf:li></rdf:Seq></dc:creator>`,
        `      <xmp:CreateDate>${fmtDate(creationDate)}</xmp:CreateDate>`,
        `      <xmp:ModifyDate>${fmtDate(modifyDate)}</xmp:ModifyDate>`,
        `      <xmp:MetadataDate>${fmtDate(creationDate)}</xmp:MetadataDate>`,
        `      <xmp:CreatorTool>${escXml(creatorTool)}</xmp:CreatorTool>`,
        `      <xmpMM:DocumentID>${escXml(documentId)}</xmpMM:DocumentID>`,
        `      <xmpMM:InstanceID>${escXml(instanceId)}</xmpMM:InstanceID>`,
        `      <pdf:Producer>${escXml(producer)}</pdf:Producer>`,
        // Custom private fields — not shown in normal PDF viewers but readable
        // by XMP-aware tools. pdfx:PrivateSeed guarantees a unique binary hash
        // for every recipient even when body content is identical.
        `      <pdfx:InvoiceNumber>${escXml(invoiceNumber)}</pdfx:InvoiceNumber>`,
        `      <pdfx:TransactionUUID>${escXml(transactionUuid)}</pdfx:TransactionUUID>`,
        `      <pdfx:PrivateSeed>${escXml(privateSeed)}</pdfx:PrivateSeed>`,
        '    </rdf:Description>',
        '  </rdf:RDF>',
        '</x:xmpmeta>',
        '<?xpacket end="w"?>',
    ].join('\n');
}

/**
 * Process a Puppeteer-rendered PDF Buffer:
 *   1. Wipe all Chromium / HeadlessChrome / Puppeteer artefacts from the
 *      Info dictionary.
 *   2. Stamp professional custom metadata (Author, Producer, Title …).
 *   3. Inject a full Adobe XMP metadata stream onto the PDF catalog,
 *      including a 32-character hex PrivateSeed that guarantees every
 *      recipient's file has a completely different SHA-256 binary hash.
 *
 * @param {Buffer} buffer
 *   Raw PDF bytes — typically the direct output of Puppeteer's page.pdf().
 *
 * @param {Object} [invoiceDetails={}]
 *   Optional invoice-specific fields:
 *     invoiceNumber  {string}  — e.g. "INV-2026-0042"  (generated if absent)
 *     recipientName  {string}  — full name for the Subject field
 *     email          {string}  — recipient address (used in Subject)
 *     membershipLevel{string}  — e.g. "Gold" — appended to Subject
 *     [any extra key] — merged into metadata as-is (ignored if unknown)
 *
 * @returns {Promise<Buffer>} Modified PDF buffer ready to attach to Nodemailer.
 */
async function processInvoicePdf(buffer, invoiceDetails = {}) {
    // ── Unique identifiers ────────────────────────────────────────────────
    // 32-char hex seed — injected into the XMP PrivateSeed field.
    // Even a 1-bit delta in this field changes every compressed object in the
    // final deflate stream, producing a completely distinct SHA-256 binary hash.
   const privateSeed = invoiceDetails.signature || crypto.randomBytes(16).toString('hex');;

    // RFC-4122 v4 UUIDs for xmpMM:DocumentID and xmpMM:InstanceID
    const makeUUID = (hex) => [
        hex.slice(0, 8),
        hex.slice(8, 12),
        '4' + hex.slice(13, 16),
        ((parseInt(hex[16], 16) & 3) | 8).toString(16) + hex.slice(17, 20),
        hex.slice(20, 32),
    ].join('-');
    const docUuid      = `uuid:${makeUUID(privateSeed)}`;
    const instanceUuid = `uuid:${makeUUID(crypto.randomBytes(16).toString('hex'))}`;

    // ── Invoice fields ────────────────────────────────────────────────────
    const invoiceNumber = invoiceDetails.invoiceNumber
        || `INV-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const transactionUuid = invoiceDetails.transactionUuid || crypto.randomUUID();

    const recipientLabel = invoiceDetails.recipientName
        ? `for ${invoiceDetails.recipientName}`
        : (invoiceDetails.email ? `for ${invoiceDetails.email}` : '');

    const title    = `Invoice - ${invoiceNumber}`;
    const subject  = `Invoice Document ${recipientLabel}`.trim();

    // Capture one exact generation timestamp (millisecond precision) so this
    // attachment's CreationDate aligns with its transaction-specific build.
    const generatedAtMs = Date.now();
    const creationDate = new Date(generatedAtMs);
    const modifyDate   = new Date(generatedAtMs);
    const metadataSoftware = pickRandomSoftwareCreator();

    // ── Load & rewrite Info dictionary ───────────────────────────────────
    // updateMetadata: false suppresses pdf-lib's own XMP injection so there
    // is no secondary 'pdf-lib' Producer string contaminating the output.
    const pdfDoc = await PDFDocument.load(buffer, { updateMetadata: false });

    // Standard Info dictionary entries — overwrites every field Puppeteer set.
    pdfDoc.setTitle(title);
    pdfDoc.setAuthor('BlackBoxAnimated Billing');
    pdfDoc.setSubject(subject);
    pdfDoc.setProducer(metadataSoftware);
    pdfDoc.setCreator(metadataSoftware);
    pdfDoc.setKeywords([]);
    pdfDoc.setCreationDate(creationDate);
    pdfDoc.setModificationDate(modifyDate);

    // ── Inject XMP metadata stream onto the PDF catalog ───────────────────
    // Completely replaces any existing Metadata stream Puppeteer may have
    // written. The stream lives on the document catalog (not the Info dict)
    // and is the authoritative metadata source for XMP-aware readers.
    const xmpXml   = buildXmpMetadata({
        title, subject,
        author:      'BlackBoxAnimated Billing',
        producer:    metadataSoftware,
        creatorTool: metadataSoftware,
        creationDate,
        modifyDate,
        documentId:  docUuid,
        instanceId:  instanceUuid,
        privateSeed,
        invoiceNumber,
        transactionUuid,
    });

    const xmpBytes  = Buffer.from(xmpXml, 'utf8');
    const xmpStream = pdfDoc.context.stream(xmpBytes, {
        Type:    'Metadata',
        Subtype: 'XML',
        Length:  xmpBytes.length,
    });
    pdfDoc.catalog.set(
        PDFName.of('Metadata'),
        pdfDoc.context.register(xmpStream),
    );

    // ── Serialise ─────────────────────────────────────────────────────────
    // useObjectStreams: false keeps a readable cross-reference table format
    // that is more compatible with email security scanners than object streams.
    const bytes = await pdfDoc.save({ useObjectStreams: false });
    return Buffer.from(bytes);
}

/**
 * Rewrite PDF Info dictionary metadata (legacy thin wrapper).
 * Delegates to processInvoicePdf so both PDF render paths share one engine.
 *
 * @param {Buffer} rawBuffer - Raw PDF bytes.
 * @param {string} title     - Document title (replaces Puppeteer default).
 * @returns {Promise<Buffer>}
 */
async function sanitizePdfMeta(rawBuffer, title) {
    return processInvoicePdf(rawBuffer, { invoiceNumber: title });
}

/**
 * Inject imperceptible micro-variations into the HTML so that every rendered
 * file produces a unique binary hash, even when two recipients receive visually
 * identical content.
 *
 * Technique 1 — Font-size drift:
 *   A <style> block is prepended that sets `body { font-size: N.Mpx }` where N
 *   is 11 or 12 and M is a 1-decimal fraction (e.g. 11.3px, 12.0px).  The
 *   fractional sub-pixel value changes the glyph rasterization path used by
 *   Chromium's Skia renderer, altering the compressed byte stream of every
 *   JPEG, PNG, and PDF content-stream object even though the difference is
 *   invisible at normal reading distances.
 *
 * Technique 2 — Foreground color micro-shift:
 *   The body color is set to a near-black hex value where the blue channel
 *   varies between 0x00 and 0x04 (e.g. #000000 → #000004).  The ∆E color
 *   difference is < 0.02 — completely undetectable by the human eye — but it
 *   changes the RGB triplet that Chromium embeds in every rendered glyph.
 *
 * Technique 3 — Hidden entropy comment:
 *   A <!-- entropy:XXXX --> HTML comment with 4 random hex bytes is inserted
 *   just before </body>.  Chromium includes comment nodes in the document
 *   model, which subtly shifts layout measurements and, as a consequence,
 *   changes the exact byte offsets inside the output stream.
 *
 * None of these changes are visible in the rendered document.
 */
function injectHashNoise(html) {
    // Technique 1 & 2: random font-size (11.0–12.9px) + near-black color (#00000{0-4})
    const fontSize  = (11 + Math.floor(Math.random() * 2)) +
                      '.' + Math.floor(Math.random() * 10) + 'px';
    const blueDrift = Math.floor(Math.random() * 5); // 0–4
    const color     = `#00000${blueDrift.toString(16)}`;  // #000000 – #000004

    const noiseStyle = `<style>body{font-size:${fontSize};color:${color}}</style>`;

    // Technique 3: entropy comment before </body>
    const entropyHex = crypto.randomBytes(4).toString('hex');
    const entropyComment = `<!-- entropy:${entropyHex} -->`;

    // Inject the style tag into <head> so it is never rendered as visible body text.
    // Priority order: existing </head> → existing <head> → create a <head> block.
    // Prepending a bare <style> to the document caused it to appear as raw text
    // in Puppeteer when the HTML had no explicit <head> element.
    let result;
    if (/<\/head>/i.test(html)) {
        result = html.replace(/<\/head>/i, noiseStyle + '</head>');
    } else if (/<head[^>]*>/i.test(html)) {
        result = html.replace(/(<head[^>]*>)/i, `$1${noiseStyle}`);
    } else if (/<html[^>]*>/i.test(html)) {
        result = html.replace(/(<html[^>]*>)/i, `$1<head>${noiseStyle}</head>`);
    } else {
        // Fallback: wrap in a proper document
        result = `<!DOCTYPE html><html><head>${noiseStyle}</head><body>${html}</body></html>`;
    }

    result = result.includes('</body>')
        ? result.replace('</body>', entropyComment + '</body>')
        : result + entropyComment;

    return result;
}

/**
 * Render an HTML string into an attachment file written to the OS temp directory.
 *
 * Hash-noise micro-variations (font-size drift, near-black color shift, entropy
 * comment) are injected first so every rendered file has a unique binary hash.
 * A unique 1×1px invisible watermark containing the render ID is then appended.
 *
 * @param {string} html   - Full HTML content to render.
 * @param {string} format - One of: 'pdf' | 'png' | 'jpeg' | 'jpeg-pdf'
 * @returns {{ tempPath: string, filename: string }}
 *
 * The caller is responsible for deleting tempPath after the file has been
 * handed off to the SMTP server.
 */
async function renderAttachment(html, format, invoiceDetails = {}) {
    const tag = randomSeven();
    const htmlWithNoise     = injectHashNoise(html);
    const htmlWithWatermark = injectWatermark(htmlWithNoise, tag);

    const launchOptions = {
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
        ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    let browser;
    try {
        browser = await puppeteer.launch(launchOptions);
    } catch (err) {
        const hint = [
            'Puppeteer launch failed in this runtime.',
            'Set PUPPETEER_EXECUTABLE_PATH if Chromium is custom-installed.',
            'On Railway, keep NODE_ENV=production and ensure Puppeteer browser download is not disabled.',
        ].join(' ');
        throw new Error(`${hint} Original error: ${err.message}`);
    }
    try {
        const page = await browser.newPage();

        // High-resolution viewport (2× DPR for crisp JPEG/PNG output)
        await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 2 });
        // Keep rendering deterministic and prevent dark-mode media queries
        // from forcing dark backgrounds in screenshots.
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
        await page.setContent(htmlWithWatermark, { waitUntil: 'networkidle0' });

        // Some HTML templates have fully transparent page backgrounds.
        // In PNG viewers this can appear black; apply a white fallback only
        // when both html/body backgrounds are transparent.
        await page.evaluate(() => {
            const isTransparent = (v) => !v || v === 'transparent' || v === 'rgba(0, 0, 0, 0)';
            const htmlEl = document.documentElement;
            const bodyEl = document.body;
            const htmlBg = getComputedStyle(htmlEl).backgroundColor;
            const bodyBg = getComputedStyle(bodyEl).backgroundColor;
            if (isTransparent(htmlBg) && isTransparent(bodyBg)) {
                htmlEl.style.backgroundColor = '#ffffff';
                bodyEl.style.backgroundColor = '#ffffff';
            }
        });

        let rawBuffer, ext;

        if (format === 'pdf') {
            const puppeteerPdf = await page.pdf({ format: 'A4', printBackground: true });
            // Full metadata sanitization + XMP injection + binary hash randomization.
            rawBuffer = await processInvoicePdf(
                Buffer.from(puppeteerPdf),
                { ...invoiceDetails, invoiceNumber: invoiceDetails.invoiceNumber || `INV-${tag}` },
            );
            ext = 'pdf';

        } else if (format === 'jpeg') {
            rawBuffer = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });
            ext = 'jpg';

        } else if (format === 'png') {
            rawBuffer = await page.screenshot({ type: 'png', fullPage: true });
            ext = 'png';

        } else if (format === 'jpeg-pdf') {
            // Step 1: Capture a high-res JPEG screenshot
            const jpegBuffer = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });

            // Step 2: Embed the JPEG into a new blank PDF page
            const pdfDoc   = await PDFDocument.create();
            const jpgImage = await pdfDoc.embedJpg(jpegBuffer);
            const { width, height } = jpgImage.scale(1);
            const pdfPage  = pdfDoc.addPage([width, height]);
            pdfPage.drawImage(jpgImage, { x: 0, y: 0, width, height });

            // Step 3: Process metadata + XMP via the unified function.
            // Save first, then reload so processInvoicePdf can rewrite the
            // Info dict that was created by pdf-lib's own setXxx() methods.
            const rawPdf  = Buffer.from(await pdfDoc.save({ updateMetadata: false }));
            rawBuffer = await processInvoicePdf(
                rawPdf,
                { ...invoiceDetails, invoiceNumber: invoiceDetails.invoiceNumber || `INV-${tag}` },
            );
            ext = 'pdf';

        } else {
            throw new Error(`Unknown attachment format: ${format}`);
        }

        const shouldEncryptPdf = !!invoiceDetails.pdfPasswordEnabled && ext === 'pdf';
        if (shouldEncryptPdf) {
            const resolvedPassword = String(invoiceDetails.pdfPassword || '').trim();
            if (!resolvedPassword) {
                throw new Error('PDF password protection enabled, but resolved password is empty.');
            }
            // pdf-encrypt-decrypt: encryptPDF(buffer, userPw, ownerPw?, permissions?)
            // Do not pass an options object as arg 3 — Koffi expects char* for owner password.
            let encryptPDF = null;
            try {
                const pdfEncryptDecrypt = require('pdf-encrypt-decrypt');
                encryptPDF =
                    typeof pdfEncryptDecrypt?.encryptPDF === 'function'
                        ? pdfEncryptDecrypt.encryptPDF
                        : typeof pdfEncryptDecrypt?.default?.encryptPDF === 'function'
                            ? pdfEncryptDecrypt.default.encryptPDF
                            : null;
            } catch (err) {
                throw new Error(`Unable to initialize PDF encryption: ${err.message}`);
            }

            if (typeof encryptPDF !== 'function') {
                throw new Error('pdf-encrypt-decrypt does not expose encryptPDF.');
            }

            try {
                const encrypted = encryptPDF(
                    Buffer.from(rawBuffer),
                    resolvedPassword,
                    resolvedPassword,
                );
                rawBuffer = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
                if (!rawBuffer || rawBuffer.length < 8 || rawBuffer.slice(0, 4).toString() !== '%PDF') {
                    throw new Error('Encrypted output is not a valid PDF buffer.');
                }
            } catch (err) {
                throw new Error(`PDF password encryption failed: ${err.message}`);
            }
        }

        const prefixes = ['Document', 'File', 'Statement', 'Attachment', 'Report'];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const filename = `${prefix}_${tag}.${ext}`;
        const tempPath = path.join(os.tmpdir(), filename);
        await fs.promises.writeFile(tempPath, rawBuffer);

        return { tempPath, filename };
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { renderAttachment, processInvoicePdf, randomSeven };
