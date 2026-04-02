import { onMessage } from "firebase/messaging";
import { messaging } from "./firebase/config";
import { getToken } from "firebase/messaging";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "./firebase/config";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

/** Served from /public/sounds — replace ipl-notification.wav with your own IPL clip if you prefer. */
export const IPL_NOTIFICATION_SOUND_URL = "/sounds/ipl-notification.wav";

export function playIplNotificationSound() {
  try {
    const audio = new Audio(IPL_NOTIFICATION_SOUND_URL);
    audio.volume = 0.85;
    void audio.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

/**
 * When the app is in the foreground, FCM delivers messages here — play the IPL chime.
 * (Background: firebase-messaging-sw.js plays /sounds/ipl-notification.wav and sets silent on the
 * system notification so the default beep is not doubled.)
 */
export function registerIplNotificationSoundHandlers() {
  if (typeof window === "undefined") return () => {};

  let unsub = null;
  try {
    unsub = onMessage(messaging, () => {
      playIplNotificationSound();
    });
  } catch {
    /* FCM not supported */
  }

  return () => {
    if (typeof unsub === "function") unsub();
  };
}

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
    await updateDoc(doc(db, "users", userId), {
      fcmToken: token,
      fcmTokenUpdatedAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.log("Error saving FCM token", error);
    return false;
  }
};
