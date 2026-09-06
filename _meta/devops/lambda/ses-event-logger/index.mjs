import { createHmac } from "node:crypto";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function emailFingerprint(value, key = process.env.EMAIL_HASH_KEY) {
  const email = normalizeEmail(value);
  if (!email || !key) return "";
  return createHmac("sha256", key).update(email).digest("hex").slice(0, 24);
}

function emailDomain(value) {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf("@");
  return at > 0 && at < email.length - 1 ? email.slice(at + 1) : "invalid";
}

function uniqueRecipients(message) {
  const recipients = [
    ...(message.mail?.destination || []),
    ...((message.bounce?.bouncedRecipients || []).map((item) => item.emailAddress)),
    ...((message.complaint?.complainedRecipients || []).map((item) => item.emailAddress)),
    ...(message.delivery?.recipients || []),
  ];
  return [...new Set(recipients.map(normalizeEmail).filter(Boolean))];
}

export function buildSafeSesEvent(message, key = process.env.EMAIL_HASH_KEY) {
  const recipients = uniqueRecipients(message);
  const hashes = recipients.map((email) => emailFingerprint(email, key)).filter(Boolean);
  const domains = [...new Set(recipients.map(emailDomain))].sort();

  return {
    schemaVersion: 2,
    eventType: message.eventType || message.notificationType || "Unknown",
    timestamp: message.mail?.timestamp || null,
    messageId: message.mail?.messageId || null,
    recipientCount: recipients.length,
    recipientHashes: hashes,
    recipientDomains: domains,
    hashConfigured: Boolean(key),
    bounce: message.bounce
      ? {
          type: message.bounce.bounceType || null,
          subType: message.bounce.bounceSubType || null,
        }
      : undefined,
    complaint: message.complaint
      ? { feedbackType: message.complaint.complaintFeedbackType || null }
      : undefined,
    delivery: message.delivery
      ? { processingTimeMillis: message.delivery.processingTimeMillis ?? null }
      : undefined,
    delay: message.deliveryDelay
      ? { delayType: message.deliveryDelay.delayType || null }
      : undefined,
  };
}

// SNS entrega los eventos de SES. No se registran direcciones, asunto,
// respuestas SMTP ni diagnósticos porque pueden contener datos personales.
export const handler = async (event) => {
  for (const record of event.Records || []) {
    try {
      const message = JSON.parse(record.Sns?.Message || "{}");
      console.log(JSON.stringify(buildSafeSesEvent(message)));
    } catch {
      console.warn(JSON.stringify({ schemaVersion: 2, eventType: "InvalidEvent" }));
    }
  }
  return { ok: true };
};
