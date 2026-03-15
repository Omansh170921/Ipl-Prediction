import emailjs from '@emailjs/browser';

const SERVICE_ID = import.meta.env.VITE_EMAILJS_SERVICE_ID || '';
const TEMPLATE_ID = import.meta.env.VITE_EMAILJS_TEMPLATE_ID || '';
const PUBLIC_KEY = import.meta.env.VITE_EMAILJS_PUBLIC_KEY || '';

export async function sendOTPEmail(toEmail, otp) {
  if (!SERVICE_ID || !TEMPLATE_ID || !PUBLIC_KEY) {
    throw new Error('EmailJS is not configured. Add VITE_EMAILJS_* to your .env file.');
  }

  const templateParams = {
    to_email: toEmail,
    email: toEmail,
    user_email: toEmail,
    otp,
    otp_code: otp,
    code: otp,
    verification_code: otp,
    message: `Your OTP is: ${otp}`,
  };

  await emailjs.send(SERVICE_ID, TEMPLATE_ID, templateParams, {
    publicKey: PUBLIC_KEY,
  });
}
