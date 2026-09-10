/** Wire compatibility with ML ticketAiAttachmentContext.ts: filenames in the
 * prompt are redacted, while the authenticated source retains the original name.
 * Accept only that exact transformation; IDs, size, MIME and source hashes remain
 * independently checked. Keep this transform aligned with the ML producer.
 */
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/gi;
const POLISH_NRB = /(?<!\d)(?:\d[ -]?){25}\d(?!\d)/g;
const PHONE = /(?<!\w)(?:\+|00)\d{1,3}[ .()-]?(?:\d[ .()-]?){7,13}(?!\w)/g;
const POLISH_LOCAL_PHONE = /(?<!\d)(?:\d[ .()-]?){8}\d(?!\d)/g;
const CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasUnsafeControl(value: string, allowTextWhitespace = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 127) return true;
    if (code < 32 && (!allowTextWhitespace || (character !== '\n' && character !== '\t'))) {
      return true;
    }
  }
  return false;
}

/** Redakcja jest ostatnią bramką przed providerem, nie substytutem retencji/RBAC. */
function redactTicketAiAttachmentText(value: string): string {
  return value
    .replace(EMAIL, '[EMAIL]')
    .replace(IBAN, '[IBAN]')
    .replace(POLISH_NRB, '[IBAN]')
    .replace(PHONE, '[PHONE]')
    .replace(POLISH_LOCAL_PHONE, '[PHONE]')
    .replace(CARD_CANDIDATE, (candidate) => (luhn(candidate) ? '[CARD]' : candidate));
}


export function masterlinkPromptFileName(value: string): string {
  const normalized = value.normalize('NFC').trim();
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    hasUnsafeControl(normalized) || normalized.includes('/') || normalized.includes('\\')
  ) return 'załącznik';
  const suffix = /^(.*)(\.[A-Za-z0-9]{1,10})$/.exec(normalized);
  return suffix
    ? `${redactTicketAiAttachmentText(suffix[1]!)}${suffix[2]}`.slice(0, 500)
    : redactTicketAiAttachmentText(normalized).slice(0, 500);
}
