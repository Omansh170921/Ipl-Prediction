import { initializeApp } from 'firebase/app';
import { getAuth, browserLocalPersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getMessaging } from "firebase/messaging";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "your-api-key",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "your-project.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "your-project-id",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "your-project.appspot.com",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "123456789",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "your-app-id",
};



const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
auth.setPersistence(browserLocalPersistence);
export const db = getFirestore(app);

let _functions = null;
function getFunctionsSafe() {
  if (!_functions) {
    try {
      _functions = getFunctions(app);
    } catch (err) {
      console.warn('Firebase Functions not available:', err);
      return null;
    }
  }
  return _functions;
}
export const callFunction = (name, data) => {
  const functions = getFunctionsSafe();
  if (!functions) return Promise.reject(new Error('Firebase Functions not available'));
  return httpsCallable(functions, name)(data);
};
export default app;

export const messaging = getMessaging(app);