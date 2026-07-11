import { Transform } from 'node:stream';

// Jeden nahrávaný dokument může mít nejvýše 100 MB; chrání disk i RAM před neomezenými uploady.
export const UPLOAD_FILE_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;

// ZIP náhled je jen informativní. Nad 50 MB archiv vůbec nenačítáme do paměti.
export const ZIP_PEEK_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;

export function exceedsUploadLimit(contentLength: string | null): boolean {
  if (!contentLength) return false;
  const bytes = Number(contentLength);
  return Number.isFinite(bytes) && bytes > UPLOAD_FILE_SIZE_LIMIT_BYTES;
}

/** Proudový limit pro odpovědi bez důvěryhodného Content-Length (např. chunked). */
export function createUploadSizeLimiter(maxBytes = UPLOAD_FILE_SIZE_LIMIT_BYTES): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new Error(`Soubor překročil limit ${Math.round(maxBytes / 1024 / 1024)} MB.`));
        return;
      }
      callback(null, chunk);
    },
  });
}
