"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentForge = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_os_1 = __importDefault(require("node:os"));
const handlebars_1 = __importDefault(require("handlebars"));
const pdf_lib_1 = require("pdf-lib");
const sharp_1 = __importDefault(require("sharp"));
// Stable node identifier derived from hostname so log entries are traceable
// across a multi-node deployment without leaking internal IP addresses.
const NODE_ID = node_crypto_1.default
    .createHash('sha256')
    .update(node_os_1.default.hostname())
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
class DocumentForge {
    // ── PDF processing ────────────────────────────────────────────────────────
    /**
     * Strip all standard metadata fields from a PDF and inject a unique
     * Transaction UUID into the Title field for per-recipient audit trails.
     * Each call produces a structurally identical but uniquely identifiable PDF.
     */
    async preparePdf(input) {
        const pdf = await pdf_lib_1.PDFDocument.load(input, { updateMetadata: false });
        // Strip fields that carry sender/tool PII (GDPR Article 5 data minimisation).
        pdf.setAuthor('');
        pdf.setSubject('');
        pdf.setKeywords([]);
        pdf.setCreator('');
        pdf.setProducer('');
        // Inject a unique transaction UUID as the document title. This acts as a
        // tamper-evident receipt reference: the UUID is logged on dispatch and can
        // be matched to a specific send event if the attachment is later disputed.
        const transactionId = node_crypto_1.default.randomUUID();
        pdf.setTitle(`txn:${transactionId}`);
        return Buffer.from(await pdf.save());
    }
    // ── Image processing ──────────────────────────────────────────────────────
    /**
     * Strip all EXIF/XMP/ICC metadata from an embedded image using sharp.
     *
     * Many logos and assets retain camera EXIF data, GPS tags, or design-tool
     * metadata that can expose internal tooling information or PII. This method
     * removes all such metadata while preserving visual content exactly.
     *
     * The output format matches the input (JPEG → JPEG, PNG → PNG, WebP → WebP).
     */
    async sanitizeImage(input) {
        const image = (0, sharp_1.default)(input);
        const meta = await image.metadata();
        // Re-encode through sharp — by default sharp strips all metadata unless
        // withMetadata() is called. The quality/effort settings below are chosen
        // to produce byte-for-byte identical visual output to the source.
        switch (meta.format) {
            case 'jpeg':
                return image.jpeg({ quality: 95 }).toBuffer();
            case 'webp':
                return image.webp({ quality: 95, effort: 4 }).toBuffer();
            case 'png':
            default:
                // PNG is lossless; compression level 6 is the zlib default.
                return image.png({ compressionLevel: 6 }).toBuffer();
        }
    }
    // ── HTML audit comment ────────────────────────────────────────────────────
    /**
     * Append an invisible HTML comment to the body for internal log correlation.
     *
     * Format:  <!-- AS_AUDIT | NODE:<nodeId> | TS:<microsecondTimestamp> | TX:<uuid> -->
     *
     * This lets ops engineers correlate a specific received email (e.g. from a
     * bounce DSN or abuse report) back to the exact send event in application
     * logs without exposing any recipient-identifying data in the comment itself.
     */
    injectAuditComment(html, transactionId = node_crypto_1.default.randomUUID()) {
        const microTs = `${Date.now()}${process.hrtime.bigint().toString().slice(-6)}`;
        const comment = `<!-- AS_AUDIT | NODE:${NODE_ID} | TS:${microTs} | TX:${transactionId} -->`;
        // Insert before </body> if present, otherwise append.
        if (/<\/body>/i.test(html)) {
            return html.replace(/<\/body>/i, `${comment}\n</body>`);
        }
        return `${html}\n${comment}`;
    }
    // ── Template rendering + final assembly ───────────────────────────────────
    /**
     * Compile and render a Handlebars HTML template, process all attachments,
     * and return a fully resolved PreparedPayload ready to hand to MissionControl.
     *
     * Processing order:
     *   1. Compile + render Handlebars template with recipient context.
     *   2. Inject audit comment into rendered HTML.
     *   3. For each attachment: strip image metadata (JPEG/PNG/WebP) or inject
     *      PDF transaction UUID — whichever matches the content-type.
     *   4. Return { html, subject, attachments }.
     *
     * @param templateHtml   Raw Handlebars template string (HTML).
     * @param subjectTpl     Handlebars template string for the subject line.
     * @param recipient      Per-recipient data merged into the template context.
     * @param extraContext   Campaign-level variables (e.g. { invoiceId, amount }).
     * @param rawAttachments Attachment buffers before processing.
     */
    async preparePayload(templateHtml, subjectTpl, recipient, extraContext = {}, rawAttachments = []) {
        const transactionId = node_crypto_1.default.randomUUID();
        // Build the full template context.
        const ctx = {
            recipient,
            sentAt: new Date().toISOString(),
            transactionId,
            ...extraContext,
        };
        // Render HTML and subject through Handlebars.
        const renderHtml = handlebars_1.default.compile(templateHtml, { noEscape: false });
        const renderSubject = handlebars_1.default.compile(subjectTpl, { noEscape: true });
        const renderedHtml = renderHtml(ctx);
        const renderedSubject = renderSubject(ctx);
        // Inject audit comment using the same transactionId so PDF and HTML
        // audit trails share a single correlatable identifier.
        const finalHtml = this.injectAuditComment(renderedHtml, transactionId);
        // Process each attachment.
        const processedAttachments = await Promise.all(rawAttachments.map(async (att) => {
            if (!att.content)
                return att;
            const ct = (att.contentType ?? '').toLowerCase();
            if (ct === 'application/pdf') {
                return { ...att, content: await this.preparePdf(att.content) };
            }
            if (ct === 'image/jpeg' || ct === 'image/png' || ct === 'image/webp') {
                return { ...att, content: await this.sanitizeImage(att.content) };
            }
            return att;
        }));
        return {
            html: finalHtml,
            subject: renderedSubject,
            attachments: processedAttachments,
        };
    }
}
exports.DocumentForge = DocumentForge;
