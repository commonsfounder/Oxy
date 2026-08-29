const axios = require('axios');

async function sendEmail({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(JSON.stringify({ severity: 'INFO', event: 'email.dev_mode', to, subject, text: text?.substring(0, 200) }));
    return { ok: true, dev: true };
  }
  const res = await axios.post('https://api.resend.com/emails', {
    from: process.env.EMAIL_FROM || 'Adam <noreply@oxy.app>',
    to, subject, html, text
  }, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }
  });
  return res.data;
}

async function sendPasswordResetEmail(email, resetUrl) {
  return sendEmail({
    to: email,
    subject: 'Reset your Adam password',
    html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a">Reset your password</h2>
      <p>Click the button below to reset your Adam password. This link expires in 1 hour.</p>
      <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;margin:16px 0">Reset Password</a>
      <p style="color:#666;font-size:14px">If you didn't request this, you can safely ignore this email.</p>
      <p style="color:#666;font-size:12px">Adam · <a href="https://oxy.app/privacy">Privacy Policy</a></p>
    </div>`,
    text: `Reset your Adam password by visiting: ${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, you can safely ignore this email.`
  });
}

async function sendWelcomeEmail(email, userId) {
  return sendEmail({
    to: email,
    subject: 'Welcome to Adam',
    html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a">Welcome to Adam, ${userId}</h2>
      <p>Your AI assistant is ready. Here are a few things to try:</p>
      <ul>
        <li>Connect Google to let Adam read and send emails</li>
        <li>Connect Telegram to message your contacts</li>
        <li>Ask Adam to find train times or book an Uber</li>
        <li>Just talk — Adam remembers what matters</li>
      </ul>
      <p style="color:#666;font-size:12px">Adam · <a href="https://oxy.app/privacy">Privacy Policy</a> · <a href="https://oxy.app/terms">Terms</a></p>
    </div>`,
    text: `Welcome to Adam, ${userId}!\n\nYour AI assistant is ready. Connect your services to get started.\n\nAdam`
  });
}

async function sendVerificationEmail(email, verifyUrl) {
  return sendEmail({
    to: email,
    subject: 'Verify your Adam email address',
    html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2>Verify your email</h2>
      <p>Click below to verify your email address for Adam.</p>
      <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;margin:16px 0">Verify Email</a>
    </div>`,
    text: `Verify your Adam email: ${verifyUrl}`
  });
}

module.exports = { sendEmail, sendPasswordResetEmail, sendWelcomeEmail, sendVerificationEmail };
