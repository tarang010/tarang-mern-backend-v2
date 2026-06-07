// Tarang 2.3.2 — utils/mailer.js
// Place at: backend/utils/mailer.js
//
// v2.3.2 change: switched transport from Resend → Brevo (formerly Sendinblue).
//   Brevo allows sending from a plain Gmail address without owning a domain —
//   it verifies sender identity via a confirmation email to that address,
//   not via DNS records. Free tier: 300 emails/day, 9000/month.
//
//   Setup (one-time):
//     1. npm install @getbrevo/brevo
//     2. Sign up at https://app.brevo.com
//     3. Go to Senders & IPs → Senders → Add a Sender
//        → enter "Tarang" + tarang.termoid@gmail.com → confirm the email Brevo sends you
//     4. Go to SMTP & API → API Keys → Generate a new API key
//     5. Add BREVO_API_KEY to your Render environment variables
//
//   All function signatures and HTML templates are identical to v2.3.0.

const SibApiV3Sdk = require("@getbrevo/brevo");

// ── Brevo client setup ────────────────────────────────────────────────────────
const apiClient = SibApiV3Sdk.ApiClient.instance;
apiClient.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;

const transactionalApi = new SibApiV3Sdk.TransactionalEmailsApi();

const SENDER = {
  name:  "Tarang",
  email: process.env.MAIL_USER || "tarang.termoid@gmail.com",
};

console.log(`✅ Mailer ready (Brevo HTTP) — sending as ${SENDER.name} <${SENDER.email}>`);

// ── Shared HTML shell ─────────────────────────────────────────────────────────
const _shell = (accentColor, body) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:32px 16px;background:#080d1a;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:480px;margin:auto;background:#0f172a;border-radius:16px;
              border:1px solid #1e293b;overflow:hidden;">
    <!-- Header bar -->
    <div style="height:4px;background:${accentColor};"></div>
    <!-- Logo row -->
    <div style="padding:28px 32px 0;display:flex;align-items:center;gap:10px;">
      <span style="font-size:20px;font-weight:700;letter-spacing:-0.5px;color:#ffffff;">
        Tarang
      </span>
      <span style="font-size:11px;color:#475569;letter-spacing:0.12em;text-transform:uppercase;
                   padding-top:2px;">
        Neuro-Acoustic Learning
      </span>
    </div>
    <!-- Body -->
    <div style="padding:24px 32px 32px;">
      ${body}
    </div>
    <!-- Footer -->
    <div style="padding:16px 32px;border-top:1px solid #1e293b;">
      <p style="margin:0;font-size:11px;color:#334155;text-align:center;">
        You're receiving this because you have a Tarang account.
        If you didn't make this request, you can safely ignore this email.
      </p>
    </div>
  </div>
</body>
</html>
`;

// ── OTP display block (shared by all OTP emails) ──────────────────────────────
const _otpBlock = (otp) => `
  <div style="margin:24px 0;text-align:center;">
    <div style="display:inline-block;font-size:38px;font-weight:700;
                letter-spacing:14px;padding:20px 32px;
                background:#1e293b;border-radius:12px;
                color:#ffffff;border:1px solid #334155;">
      ${otp}
    </div>
  </div>
`;

// ── Internal send helper ──────────────────────────────────────────────────────
const _send = async ({ to, subject, html }) => {
  try {
    const result = await transactionalApi.sendTransacEmail({
      sender:      SENDER,
      to:          [{ email: to }],
      subject,
      htmlContent: html,
    });
    return result;
  } catch (err) {
    // Brevo wraps errors in err.response.text — surface it clearly
    const detail = err?.response?.text || err?.message || String(err);
    console.error("❌ Brevo mailer error:", detail);
    throw new Error(`Mailer failed: ${detail}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. FORGOT PASSWORD — password reset OTP
// ─────────────────────────────────────────────────────────────────────────────
const sendOtpEmail = async (to, otp) => {
  const body = `
    <h2 style="margin:0 0 8px;font-size:20px;color:#818cf8;">Reset your password</h2>
    <p style="margin:0 0 4px;color:#94a3b8;font-size:14px;line-height:1.6;">
      We received a request to reset the password for your Tarang account.
      Use the OTP below — it expires in <strong style="color:#e2e8f0;">10 minutes</strong>.
    </p>
    ${_otpBlock(otp)}
    <p style="margin:0;color:#475569;font-size:13px;line-height:1.6;">
      Didn't request a password reset?
      <strong style="color:#94a3b8;">Your password remains unchanged</strong> — 
      just ignore this email.
    </p>
  `;
  return _send({
    to,
    subject: "Tarang — Your Password Reset OTP",
    html:    _shell("#818cf8", body),
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. SIGNUP EMAIL VERIFICATION — confirm new account
// ─────────────────────────────────────────────────────────────────────────────
const sendSignupOtpEmail = async (to, otp, name = "there") => {
  const firstName = name.trim().split(" ")[0] || "there";
  const body = `
    <h2 style="margin:0 0 8px;font-size:20px;color:#34d399;">Confirm your email</h2>
    <p style="margin:0 0 4px;color:#94a3b8;font-size:14px;line-height:1.6;">
      Welcome to Tarang, <strong style="color:#e2e8f0;">${firstName}</strong>! 🎉<br>
      Enter the OTP below to verify your email and activate your account.
      It expires in <strong style="color:#e2e8f0;">10 minutes</strong>.
    </p>
    ${_otpBlock(otp)}
    <p style="margin:0;color:#475569;font-size:13px;line-height:1.6;">
      Once verified, you'll be taken to your dashboard where you can upload your
      first document and start your neuro-acoustic learning journey.
    </p>
  `;
  return _send({
    to,
    subject: "Tarang — Verify your email to get started",
    html:    _shell("#34d399", body),
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. LOGIN OTP — 2FA on every sign-in
// ─────────────────────────────────────────────────────────────────────────────
const sendLoginOtpEmail = async (to, otp, name = "there") => {
  const firstName = name.trim().split(" ")[0] || "there";
  const body = `
    <h2 style="margin:0 0 8px;font-size:20px;color:#38bdf8;">Sign-in verification</h2>
    <p style="margin:0 0 4px;color:#94a3b8;font-size:14px;line-height:1.6;">
      Hi <strong style="color:#e2e8f0;">${firstName}</strong>, someone just signed in to
      your Tarang account. Use the OTP below to complete sign-in.
      It expires in <strong style="color:#e2e8f0;">10 minutes</strong>.
    </p>
    ${_otpBlock(otp)}
    <p style="margin:0;color:#475569;font-size:13px;line-height:1.6;">
      If this wasn't you, your password may be compromised.
      <strong style="color:#f87171;">Change it immediately</strong> using
      "Forgot Password" on the sign-in page.
    </p>
  `;
  return _send({
    to,
    subject: "Tarang — Your sign-in OTP",
    html:    _shell("#38bdf8", body),
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. AUDIO READY — document processing complete
// ─────────────────────────────────────────────────────────────────────────────
const sendAudioReadyEmail = async (to, name = "there", docTitle = "Your document", listenUrl = "") => {
  const firstName = name.trim().split(" ")[0] || "there";
  const body = `
    <h2 style="margin:0 0 8px;font-size:20px;color:#fb923c;">Your audio is ready 🎧</h2>
    <p style="margin:0 0 16px;color:#94a3b8;font-size:14px;line-height:1.6;">
      Hi <strong style="color:#e2e8f0;">${firstName}</strong>, your neuro-acoustic
      audio for <strong style="color:#e2e8f0;">${docTitle}</strong> has been
      fully generated and is ready to listen to.
    </p>
    <!-- Document card -->
    <div style="background:#1e293b;border-radius:12px;padding:20px 24px;
                border:1px solid #334155;margin-bottom:24px;">
      <p style="margin:0 0 4px;font-size:12px;color:#475569;
                text-transform:uppercase;letter-spacing:0.1em;">Document ready</p>
      <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#f1f5f9;">
        ${docTitle}
      </p>
      ${listenUrl ? `
      <a href="${listenUrl}"
         style="display:inline-block;padding:12px 28px;background:#fb923c;
                color:#ffffff;text-decoration:none;border-radius:8px;
                font-size:14px;font-weight:600;letter-spacing:0.02em;">
        Listen now →
      </a>` : ""}
    </div>
    <p style="margin:0;color:#475569;font-size:13px;line-height:1.6;">
      Your active recall sessions will unlock progressively as you listen.
      Head to your dashboard to track progress and view analytics.
    </p>
  `;
  return _send({
    to,
    subject: `Tarang — "${docTitle}" is ready to listen`,
    html:    _shell("#fb923c", body),
  });
};

module.exports = {
  sendOtpEmail,
  sendSignupOtpEmail,
  sendLoginOtpEmail,
  sendAudioReadyEmail,
};