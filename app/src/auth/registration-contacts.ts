import { z } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

/** Canonical international contact value. Formatting is a UI responsibility. */
export function validContactPhone(value: string) {
  if (!/^\+[1-9][0-9]{1,14}$/.test(value)) return false;
  const parsed = parsePhoneNumberFromString(value, { extract: false });
  return Boolean(parsed && parsed.isPossible() && !parsed.ext && parsed.number === value);
}
export const contactPhoneInput = z.string().refine(validContactPhone, 'Use an international phone number with country code');
const optionalContactPhoneInput = z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  contactPhoneInput.optional());
export const registrationContacts = z.object({ contactPhone: optionalContactPhoneInput, contactWhatsapp: optionalContactPhoneInput });

export function contactPhoneField() {
  return { type: 'string' as const, required: false, input: true, returned: false,
    unique: false, validator: { input: optionalContactPhoneInput } };
}
