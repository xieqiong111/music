const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/u;
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_FILENAME_CODE_POINTS = 180;
// 255-byte component limit minus `_YYYY-MM-DD.json` (16 ASCII bytes).
const MAX_FILENAME_BYTES = 239;

/** Produces a portable filename while retaining Unicode characters. */
export function sanitizeFilename(name: string): string {
  let sanitized = String(name)
    .replace(INVALID_FILENAME_CHARACTERS, '_')
    .replace(TRAILING_DOTS_AND_SPACES, '');

  if (RESERVED_DEVICE_NAME.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  const encoder = new TextEncoder();
  let bytes = 0;
  sanitized = Array.from(sanitized).slice(0, MAX_FILENAME_CODE_POINTS).filter((character) => {
    bytes += encoder.encode(character).length;
    return bytes <= MAX_FILENAME_BYTES;
  }).join('');
  sanitized = sanitized.replace(TRAILING_DOTS_AND_SPACES, '');

  return sanitized.length > 0 && sanitized !== '.' && sanitized !== '..'
    ? sanitized
    : '未命名';
}
