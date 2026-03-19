const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const functions = require('firebase-functions');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();

/**
 * Scheduled push notification. Runs every 5 minutes; actual check interval read from programConfig.scheduleIntervalMinutes.
 * Only TODAY's open matches where prediction cutoff is in ~15 minutes.
 * Only sends to users who have NOT yet predicted for that match.
 * Requires Firebase Blaze plan for scheduled functions.
 */
exports.scheduledPredictionReminder = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: process.env.SCHEDULE_TIMEZONE || 'Asia/Kolkata',
}, async () => {
    const db = admin.firestore();
    const messaging = admin.messaging();
    const now = new Date();

    // Read interval from programConfig; skip if not enough time since last run
    const progSnap = await db.doc('settings/programConfig').get();
    const scheduleSnap = await db.doc('settings/notificationSchedule').get();
    const intervalMin = Math.max(1, Math.min(60, parseInt(progSnap.data()?.scheduleIntervalMinutes, 10) || 10));
    const lastRun = scheduleSnap.exists ? scheduleSnap.data()?.lastRunAt?.toDate?.() : null;
    if (lastRun && (now - lastRun) < intervalMin * 60 * 1000) {
      return null;
    }
    const reminderWindowMs = 15 * 60 * 1000; // 15 min before cutoff
    const bufferMs = 5 * 60 * 1000; // 5 min window

    // Today's date in IST (Asia/Kolkata)
    const istDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const todayStr = istDate.getFullYear() + '-' +
      String(istDate.getMonth() + 1).padStart(2, '0') + '-' +
      String(istDate.getDate()).padStart(2, '0');

    const matchesSnap = await db.collection('matches')
      .where('status', '==', 'open')
      .get();

    const matchesToNotify = [];
    for (const docSnap of matchesSnap.docs) {
      const m = docSnap.data();
      const matchId = docSnap.id;
      if (m.predictionReminderSentAt) continue;

      const dateStr = (m.date || '').toString().trim();
      if (!dateStr || dateStr !== todayStr) continue; // Only today's matches

      const threshold = (m.thresholdTime || m.time || '23:59').trim();
      const [th, tm] = threshold.split(':').map((x) => parseInt(x || 0, 10));
      const hh = String(th || 23).padStart(2, '0');
      const mm = String(tm || 59).padStart(2, '0');
      const cutoff = new Date(dateStr + 'T' + hh + ':' + mm + ':00+05:30');
      if (isNaN(cutoff.getTime())) continue;

      const reminderTime = new Date(cutoff.getTime() - reminderWindowMs);
      const windowStart = new Date(reminderTime.getTime() - bufferMs);
      const windowEnd = new Date(reminderTime.getTime() + bufferMs);

      if (now >= windowStart && now <= windowEnd && now < cutoff) {
        matchesToNotify.push({ id: matchId, ...m, cutoff });
      }
    }

    if (matchesToNotify.length === 0) {
      await db.doc('settings/notificationSchedule').set({
        lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return null;
    }

    // Users with FCM tokens (non-admin)
    const usersSnap = await db.collection('users').get();
    const usersWithToken = [];
    for (const u of usersSnap.docs) {
      const data = u.data();
      const token = (data.fcmToken || '').trim();
      if (token && !data.isAdmin && data.isAdmin !== 'true') {
        usersWithToken.push({ id: u.id, token });
      }
    }

    const BATCH_SIZE = 500;
    for (const match of matchesToNotify) {
      // Who has already predicted for this match?
      const predsSnap = await db.collection('predictions')
        .where('matchId', '==', match.id)
        .get();
      const userIdsWhoPredicted = new Set(predsSnap.docs.map((d) => d.data().userId));

      // Only users who have NOT predicted yet
      const tokensToNotify = usersWithToken
        .filter((u) => !userIdsWhoPredicted.has(u.id))
        .map((u) => u.token);

      if (tokensToNotify.length === 0) continue;

      const team1 = (match.team1 || '').toString().trim().toUpperCase();
      const team2 = (match.team2 || '').toString().trim().toUpperCase();
      const title = 'IPL Prediction Reminder';
      const body = `Match #${match.matchNumber || match.id}: ${team1} vs ${team2}. Predict before ${(match.thresholdTime || match.time || '')}. 15 minutes left!`;

      const payload = {
        notification: { title, body },
        data: { matchId: match.id, type: 'prediction_reminder' },
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      };

      for (let i = 0; i < tokensToNotify.length; i += BATCH_SIZE) {
        const batch = tokensToNotify.slice(i, i + BATCH_SIZE);
        try {
          await messaging.sendEachForMulticast({ ...payload, tokens: batch });
        } catch (err) {
          console.error('FCM send error for match', match.id, err);
        }
      }

      await db.collection('matches').doc(match.id).update({
        predictionReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await db.doc('settings/notificationSchedule').set({
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return null;
  });

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
