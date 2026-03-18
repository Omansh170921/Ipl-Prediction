import { messaging } from "./firebase/config";
import { getToken } from "firebase/messaging";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "./firebase/config";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

export const requestNotificationPermission = async () => {
  try {
    const permission = await Notification.requestPermission();

    if (permission === "granted") {
      const token = await getToken(messaging, {
        vapidKey: VAPID_PUBLIC_KEY
      });

      if (token) {
        return token;
      }
    }
  } catch (error) {
    console.log("Error getting token", error);
  }
  return null;
};

/**
 * Save FCM token to user's Firestore document for scheduled push notifications.
 * Call this when user is logged in and has granted notification permission.
 */
export const saveFCMTokenToUser = async (userId, token) => {
  if (!userId || !token) return false;
  try {
    await updateDoc(doc(db, 'users', userId), {
      fcmToken: token,
      fcmTokenUpdatedAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.log("Error saving FCM token", error);
    return false;
  }
};