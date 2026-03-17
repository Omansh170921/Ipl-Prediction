import { messaging } from "./firebase/config";
import { getToken } from "firebase/messaging";
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

export const requestNotificationPermission = async () => {
  try {
    const permission = await Notification.requestPermission();

    if (permission === "granted") {

      const token = await getToken(messaging, {
        vapidKey: VAPID_PUBLIC_KEY
      });

      console.log("FCM Token:", token);

      return token;
    }
  } catch (error) {
    console.log("Error getting token", error);
  }
};