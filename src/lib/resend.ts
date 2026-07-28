import type { Env } from "./types";

// Password reset emails via Resend's REST API — same call-a-secret pattern
// as src/lib/openrouter.ts. The sending address is finalized once a
// verified domain exists (see Phase 7 / RESEND_FROM_ADDRESS below).

const FROM_ADDRESS = "Yardline <noreply@neulab.xyz>";

export async function sendPasswordResetEmail(
  env: Env,
  toEmail: string,
  resetUrl: string,
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: "Reset your Yardline password",
      html: `
        <p>Someone requested a password reset for this Yardline account.</p>
        <p><a href="${resetUrl}">Reset your password</a> — this link expires in 24 hours.</p>
        <p>If you didn't request this, you can ignore this email.</p>
      `,
      text: `Reset your Yardline password: ${resetUrl}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore this email.`,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend send failed (${response.status}): ${body}`);
  }
}
