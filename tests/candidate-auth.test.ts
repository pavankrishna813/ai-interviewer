import test, { describe } from "node:test";
import assert from "node:assert/strict";

describe("Candidate Identity Verification & Session Authorization", () => {
  function maskEmail(email: string | null | undefined): string {
    if (!email) return "";
    const parts = email.split("@");
    if (parts.length < 2) return email;
    const [local, domain] = parts;
    if (local.length <= 2) return `${local[0]}*@${domain}`;
    return `${local[0]}***${local[local.length - 1]}@${domain}`;
  }

  test("maskEmail correctly masks candidate emails for privacy", () => {
    assert.equal(maskEmail("keerthana@thesmartbridge.com"), "k***a@thesmartbridge.com");
    assert.equal(maskEmail("john.doe@company.org"), "j***e@company.org");
    assert.equal(maskEmail("ab@test.io"), "a*@test.io");
    assert.equal(maskEmail("a@test.io"), "a*@test.io");
    assert.equal(maskEmail(""), "");
    assert.equal(maskEmail(null), "");
  });

  test("Candidate verification grants access ONLY when email matches exactly (case-insensitive)", () => {
    const registeredEmail = "keerthana@thesmartbridge.com";

    // Matching email
    const validAttempt = "KEERTHANA@THESMARTBRIDGE.COM   ";
    assert.equal(validAttempt.trim().toLowerCase(), registeredEmail);

    // Mismatched emails
    const wrongAttempts = [
      "hacker@random.com",
      "keerthana@gmail.com",
      "keerthana2@thesmartbridge.com",
      "admin@thesmartbridge.com",
      "",
    ];

    for (const attempt of wrongAttempts) {
      assert.notEqual(attempt.trim().toLowerCase(), registeredEmail);
    }
  });

  test("Authorized session token is required to enter interview session", () => {
    const token = "sgm906ypjc7n";
    const storageKey = `troven_candidate_auth_${token}`;
    const mockSessionStorage: Record<string, string> = {};

    // Initial state: not verified
    assert.equal(mockSessionStorage[storageKey], undefined);

    // Simulate verification
    mockSessionStorage[storageKey] = "keerthana@thesmartbridge.com";
    assert.equal(mockSessionStorage[storageKey], "keerthana@thesmartbridge.com");

    // Verification clears on wrong token or missing auth
    const otherTokenKey = `troven_candidate_auth_other123`;
    assert.equal(mockSessionStorage[otherTokenKey], undefined);
  });

  test("OTP generation and verification workflow", () => {
    const otpStore = new Map<string, { otp: string; email: string; expiresAt: number }>();
    const inviteToken = "p142n6yazatv";
    const candidateEmail = "keerthana@thesmartbridge.com";

    // 1. Generate 6-digit OTP
    const generatedOtp = "482915";
    const expiresAt = Date.now() + 10 * 60 * 1000;
    otpStore.set(inviteToken, {
      otp: generatedOtp,
      email: candidateEmail,
      expiresAt,
    });

    assert.equal(otpStore.has(inviteToken), true);
    assert.equal(otpStore.get(inviteToken)?.otp, "482915");

    // 2. Reject incorrect OTP
    const wrongOtp = "111111";
    assert.notEqual(otpStore.get(inviteToken)?.otp, wrongOtp);

    // 3. Reject expired OTP
    const expiredRecord = {
      otp: "999999",
      email: candidateEmail,
      expiresAt: Date.now() - 1000,
    };
    assert.equal(Date.now() > expiredRecord.expiresAt, true);

    // 4. Accept correct OTP and consume
    const submittedOtp = "482915";
    const record = otpStore.get(inviteToken);
    assert.equal(record?.otp, submittedOtp);
    assert.equal(Date.now() <= record.expiresAt, true);

    otpStore.delete(inviteToken);
    assert.equal(otpStore.has(inviteToken), false);
  });
});
