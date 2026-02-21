import { readFile } from 'fs/promises';
import { basename } from 'path';

const GOTENBERG_URL = process.env.GOTENBERG_URL || '';

/**
 * Convert a DOCX file to PDF using Gotenberg's LibreOffice route.
 * Returns null if GOTENBERG_URL is not configured (graceful skip).
 */
export async function convertToPdf(docxPath: string): Promise<Buffer | null> {
  if (!GOTENBERG_URL) return null;

  const filename = basename(docxPath);
  const fileBuffer = await readFile(docxPath);

  const formData = new FormData();
  formData.append('files', new Blob([fileBuffer]), filename);

  const url = `${GOTENBERG_URL.replace(/\/$/, '')}/forms/libreoffice/convert`;

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Gotenberg conversion failed for ${filename}: ${res.status} ${text}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Check if Gotenberg is available.
 */
export function isGotenbergConfigured(): boolean {
  return !!GOTENBERG_URL;
}
