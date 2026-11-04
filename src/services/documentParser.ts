import mammoth from "mammoth";

export class DocumentProcessingError extends Error {
  constructor(message: string, public readonly statusCode: number = 400) {
    super(message);
    this.name = "DocumentProcessingError";
  }
}

export type SupportedFileType = "pdf" | "docx" | "txt";

export interface ParsedRequirementDocument {
  filename: string;
  fileType: SupportedFileType;
  fileSize: number;
  text: string;
  wordCount: number;
  characterCount: number;
}

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Robust PDF parsing supporting both pdf-parse v1 and v2 architectures.
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfModule: any = require("pdf-parse");

  // Handle pdf-parse v1: function(buffer)
  if (typeof pdfModule === "function") {
    const res = await pdfModule(buffer);
    return res?.text ?? "";
  }

  // Handle pdf-parse v2: class PDFParse({ data })
  const PDFParseClass = pdfModule.PDFParse || pdfModule.default?.PDFParse;
  if (typeof PDFParseClass === "function") {
    const parser = new PDFParseClass({ data: buffer });
    try {
      const result = await parser.getText();
      return result?.text ?? "";
    } finally {
      if (typeof parser.destroy === "function") {
        await parser.destroy().catch(() => {});
      }
    }
  }

  throw new Error("PDF parser module does not export a recognized parsing function or class");
}

/**
 * Detect file type based on file extension and/or MIME type.
 */
export function detectFileType(filename: string, mimeType?: string): SupportedFileType {
  const lowerName = filename.toLowerCase();
  const lowerMime = mimeType?.toLowerCase() ?? "";

  if (
    lowerName.endsWith(".pdf") ||
    lowerMime === "application/pdf"
  ) {
    return "pdf";
  }

  if (
    lowerName.endsWith(".docx") ||
    lowerMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerMime === "application/msword"
  ) {
    return "docx";
  }

  if (
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".text") ||
    lowerMime.startsWith("text/")
  ) {
    return "txt";
  }

  throw new DocumentProcessingError(
    `Unsupported file format for "${filename}". Allowed formats are: PDF (.pdf), Word (.docx), and Plain Text (.txt).`,
    400,
  );
}

/**
 * Clean and normalize extracted document text.
 */
export function sanitizeDocumentText(rawText: string): string {
  // Strip null bytes and unprintable control characters (except newline, tab, carriage return)
  let cleaned = rawText.replace(/\0/g, "").replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Normalize Windows line endings
  cleaned = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Collapse excessive consecutive blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

/**
 * Extract clean textual content from PDF, DOCX, or TXT file buffer.
 */
export async function extractTextFromDocument(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
): Promise<ParsedRequirementDocument> {
  if (!buffer || buffer.length === 0) {
    throw new DocumentProcessingError("The uploaded file is empty.", 400);
  }

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new DocumentProcessingError(
      `File size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed limit of 10 MB.`,
      400,
    );
  }

  const fileType = detectFileType(filename, mimeType);
  let extractedText = "";

  try {
    switch (fileType) {
      case "pdf": {
        extractedText = await parsePdfBuffer(buffer);
        break;
      }
      case "docx": {
        const parsed = await mammoth.extractRawText({ buffer });
        extractedText = parsed.value ?? "";
        break;
      }
      case "txt": {
        extractedText = buffer.toString("utf8");
        break;
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new DocumentProcessingError(
      `Failed to parse ${fileType.toUpperCase()} document "${filename}": ${errorMsg}`,
      400,
    );
  }

  const sanitized = sanitizeDocumentText(extractedText);

  if (sanitized.length < 20) {
    throw new DocumentProcessingError(
      `Insufficient text extracted from "${filename}" (${sanitized.length} characters). Please provide a requirements document with meaningful text content.`,
      400,
    );
  }

  const words = sanitized.split(/\s+/).filter(Boolean);

  return {
    filename,
    fileType,
    fileSize: buffer.length,
    text: sanitized,
    wordCount: words.length,
    characterCount: sanitized.length,
  };
}
