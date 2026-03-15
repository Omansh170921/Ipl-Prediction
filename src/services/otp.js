import { doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import { sendOTPEmail } from './emailjs';

const OTP_EXPIRY_MINUTES = 10;
const STEP_TIMEOUT_MS = 12000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out. Check if ${label === 'Database' ? 'Firestore is created in Firebase Console' : 'EmailJS service/template IDs are correct'}.`)), STEP_TIMEOUT_MS)
    ),
  ]);
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getOtpDocId(email) {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

export async function createAndSendOTP(email) {
  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  try {
    await withTimeout(
      setDoc(doc(db, 'otps', getOtpDocId(email)), {
        email: email.toLowerCase(),
        otp,
        expiresAt,
      }),
      'Database'
    );
  } catch (err) {
    const msg = err?.message || String(err);
    const code = err?.code || '';
    if (msg.includes('timed out')) throw new Error(msg);
    if (code === 'failed-precondition' || msg.includes('NOT_FOUND')) {
      throw new Error('Firestore not created. Go to console.firebase.google.com → your project → Firestore Database → Create database.');
    }
    if (code === 'permission-denied' || msg.includes('permission')) {
      throw new Error('Firestore rules blocking. In Firebase Console → Firestore → Rules, ensure /otps allows read, write. Then Publish.');
    }
    throw new Error(`Database error: ${msg}`);
  }

  try {
    await withTimeout(sendOTPEmail(email, otp), 'Email');
  } catch (err) {
    const msg = err?.message || err?.text || String(err);
    throw new Error(msg.includes('timed out') ? msg : msg.includes('Invalid') || msg.includes('configuration') ? 'Email service misconfigured. Check EmailJS template has {{to_email}} and {{otp}}.' : `Email failed: ${msg}`);
  }
  return { success: true };
}

export async function verifyOTP(email, enteredOtp) {
  const otpDoc = await getDoc(doc(db, 'otps', getOtpDocId(email)));

  if (!otpDoc.exists()) {
    return { valid: false, error: 'OTP expired or not found' };
  }

  const { otp, expiresAt } = otpDoc.data();

  if (new Date(expiresAt) < new Date()) {
    await deleteDoc(doc(db, 'otps', getOtpDocId(email)));
    return { valid: false, error: 'OTP has expired' };
  }

  if (otp !== enteredOtp) {
    return { valid: false, error: 'Invalid OTP' };
  }

  await deleteDoc(doc(db, 'otps', getOtpDocId(email)));
  return { valid: true };
}

export async function resendOTP(email) {
  return createAndSendOTP(email);
}
