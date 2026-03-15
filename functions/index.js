const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

function getOtpDocId(email) {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

exports.resetPasswordWithOTP = functions.https.onCall(async (data, context) => {
  const { email, otp, newPassword } = data || {};
  if (!email || typeof email !== 'string' || !otp || typeof otp !== 'string' || !newPassword || typeof newPassword !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Email, OTP, and new password are required.');
  }
  const trimmedEmail = email.trim().toLowerCase();
  const trimmedOtp = otp.trim();
  const trimmedPassword = newPassword.trim();
  if (trimmedPassword.length < 6) {
    throw new functions.https.HttpsError('invalid-argument', 'Password must be at least 6 characters.');
  }

  const db = admin.firestore();

  const otpDoc = await db.collection('otps').doc(getOtpDocId(trimmedEmail)).get();
  if (!otpDoc.exists) {
    throw new functions.https.HttpsError('failed-precondition', 'OTP expired or not found.');
  }
  const { otp: storedOtp, expiresAt } = otpDoc.data();
  if (new Date(expiresAt) < new Date()) {
    await db.collection('otps').doc(getOtpDocId(trimmedEmail)).delete();
    throw new functions.https.HttpsError('failed-precondition', 'OTP has expired.');
  }
  if (storedOtp !== trimmedOtp) {
    throw new functions.https.HttpsError('failed-precondition', 'Invalid OTP.');
  }

  const usersSnap = await db.collection('users').where('email', '==', trimmedEmail).limit(1).get();
  if (usersSnap.empty) {
    throw new functions.https.HttpsError('not-found', 'User not found.');
  }
  const userId = usersSnap.docs[0].id;

  const policySnap = await db.doc('settings/passwordPolicy').get();
  const limit = policySnap.exists ? (policySnap.data().maxPasswordChanges ?? 2) : 2;
  const userDoc = await db.doc(`users/${userId}`).get();
  const count = userDoc.exists ? (userDoc.data().passwordChangeCount ?? 0) : 0;
  if (count >= limit) {
    throw new functions.https.HttpsError('resource-exhausted', `Password reset limit reached (max ${limit} per user). Contact admin.`);
  }

  const auth = admin.auth();
  const userRecord = await auth.getUserByEmail(trimmedEmail);
  await auth.updateUser(userRecord.uid, { password: trimmedPassword });

  await db.collection('otps').doc(getOtpDocId(trimmedEmail)).delete();
  await db.doc(`users/${userId}`).update({
    passwordChangeCount: count + 1,
    passwordChangedAt: new Date().toISOString(),
  });

  return { success: true };
});
