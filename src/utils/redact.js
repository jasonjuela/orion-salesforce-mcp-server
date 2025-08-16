const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /\b\+?\d[\d\s().-]{7,}\b/g;

export function redactPII(text) {
  return String(text || '')
    .replace(EMAIL, '<redacted_email>')
    .replace(PHONE, '<redacted_phone>');
}


