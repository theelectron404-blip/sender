import type { AttachmentPayload, PreparedPayload, Recipient } from './types.js';
export declare class DocumentForge {
    /**
     * Strip all standard metadata fields from a PDF and inject a unique
     * Transaction UUID into the Title field for per-recipient audit trails.
     * Each call produces a structurally identical but uniquely identifiable PDF.
     */
    preparePdf(input: Buffer): Promise<Buffer>;
    /**
     * Strip all EXIF/XMP/ICC metadata from an embedded image using sharp.
     *
     * Many logos and assets retain camera EXIF data, GPS tags, or design-tool
     * metadata that can expose internal tooling information or PII. This method
     * removes all such metadata while preserving visual content exactly.
     *
     * The output format matches the input (JPEG → JPEG, PNG → PNG, WebP → WebP).
     */
    sanitizeImage(input: Buffer): Promise<Buffer>;
    /**
     * Append an invisible HTML comment to the body for internal log correlation.
     *
     * Format:  <!-- AS_AUDIT | NODE:<nodeId> | TS:<microsecondTimestamp> | TX:<uuid> -->
     *
     * This lets ops engineers correlate a specific received email (e.g. from a
     * bounce DSN or abuse report) back to the exact send event in application
     * logs without exposing any recipient-identifying data in the comment itself.
     */
    injectAuditComment(html: string, transactionId?: `${string}-${string}-${string}-${string}-${string}`): string;
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
    preparePayload(templateHtml: string, subjectTpl: string, recipient: Recipient, extraContext?: Record<string, unknown>, rawAttachments?: AttachmentPayload[]): Promise<PreparedPayload>;
}
