// Tarang 2.2.0 — utils/mailer.js
// Place at: backend/utils/mailer.js

const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER, // your Gmail address
    pass: process.env.MAIL_PASS, // your Gmail App Password (16 chars)
  },
});

/**
 * Send a 6-digit OTP to the given email.
 * @param {string} to  - recipient email
 * @param {string} otp - 6-digit code
 */
const sendOtpEmail = async (to, otp) => {
  await transporter.sendMail({
    from: `"Tarang" <${process.env.MAIL_USER}>`,
    to,
    subject: "Your Tarang Password Reset OTP",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;
                  background:#0f172a;color:#e2e8f0;border-radius:12px;">
        <h2 style="color:#818cf8;margin-bottom:8px;">Password Reset</h2>
        <p style="color:#94a3b8;margin-bottom:24px;">
          Use the OTP below to reset your Tarang password.
          It expires in <strong>10 minutes</strong>.
        </p>
        <div style="font-size:36px;font-weight:700;letter-spacing:12px;
                    text-align:center;padding:20px;background:#1e293b;
                    border-radius:8px;color:#ffffff;">
          ${otp}
        </div>
        <p style="color:#64748b;font-size:12px;margin-top:24px;">
          If you didn't request this, ignore this email. Your password won't change.
        </p>
      </div>
    `,
  });
};

module.exports = { sendOtpEmail };
