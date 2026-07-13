declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    [key: string]: unknown;
  }

  export default function pdfParse(dataBuffer: Uint8Array): Promise<PdfParseResult>;
}
