"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentForge = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const pdf_lib_1 = require("pdf-lib");
class DocumentForge {
    async sanitizeAndDiversify(input) {
        const pdf = await pdf_lib_1.PDFDocument.load(input, { updateMetadata: false });
        pdf.setTitle('');
        pdf.setAuthor('');
        pdf.setSubject('');
        pdf.setKeywords([]);
        pdf.setCreator('');
        pdf.setProducer('');
        // Embed a deterministic custom marker into PDF metadata fields so
        // each generated file differs at the binary level.
        const uid = node_crypto_1.default.randomUUID();
        pdf.setTitle(`trace:${uid}`);
        const bytes = await pdf.save();
        return Buffer.from(bytes);
    }
}
exports.DocumentForge = DocumentForge;
