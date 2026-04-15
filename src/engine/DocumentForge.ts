import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

export class DocumentForge {
  async sanitizeAndDiversify(input: Buffer): Promise<Buffer> {
    const pdf = await PDFDocument.load(input, { updateMetadata: false });

    pdf.setTitle('');
    pdf.setAuthor('');
    pdf.setSubject('');
    pdf.setKeywords([]);
    pdf.setCreator('');
    pdf.setProducer('');

    // Embed a deterministic custom marker into PDF metadata fields so
    // each generated file differs at the binary level.
    const uid = crypto.randomUUID();
    pdf.setTitle(`trace:${uid}`);

    const bytes = await pdf.save();
    return Buffer.from(bytes);
  }
}