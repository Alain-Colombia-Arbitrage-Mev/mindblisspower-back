import assert from "node:assert/strict";
import test from "node:test";

import { buildSafeSesEvent, emailFingerprint } from "./index.mjs";

const key = "test-only-key";

test("fingerprints are stable and do not expose the email", () => {
  const first = emailFingerprint(" Member@Example.com ", key);
  const second = emailFingerprint("member@example.com", key);

  assert.equal(first, second);
  assert.equal(first.length, 24);
  assert.equal(first.includes("member"), false);
});

test("SES events retain operational data without recipient PII", () => {
  const safe = buildSafeSesEvent(
    {
      eventType: "Bounce",
      mail: {
        timestamp: "2026-09-06T12:00:00Z",
        messageId: "message-id",
        destination: ["Member@Example.com"],
        commonHeaders: { subject: "Private subject" },
      },
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [
          { emailAddress: "member@example.com", diagnosticCode: "mailbox for member@example.com missing" },
        ],
      },
    },
    key,
  );
  const serialized = JSON.stringify(safe);

  assert.equal(safe.recipientCount, 1);
  assert.deepEqual(safe.recipientDomains, ["example.com"]);
  assert.equal(safe.recipientHashes.length, 1);
  assert.deepEqual(safe.bounce, { type: "Permanent", subType: "General" });
  assert.equal(serialized.includes("member@example.com"), false);
  assert.equal(serialized.includes("Private subject"), false);
  assert.equal(serialized.includes("mailbox for"), false);
});

test("missing hash key fails privacy-safe", () => {
  const safe = buildSafeSesEvent(
    { eventType: "Delivery", mail: { destination: ["member@example.com"] }, delivery: {} },
    "",
  );

  assert.equal(safe.hashConfigured, false);
  assert.deepEqual(safe.recipientHashes, []);
  assert.equal(JSON.stringify(safe).includes("member@example.com"), false);
});
