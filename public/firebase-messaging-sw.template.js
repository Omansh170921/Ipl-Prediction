/* eslint-disable */
// Auto-generated from template - config injected from .env at build time
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: '__VITE_FIREBASE_API_KEY__',
  authDomain: '__VITE_FIREBASE_AUTH_DOMAIN__',
  projectId: '__VITE_FIREBASE_PROJECT_ID__',
  storageBucket: '__VITE_FIREBASE_STORAGE_BUCKET__',
  messagingSenderId: '__VITE_FIREBASE_MESSAGING_SENDER_ID__',
  appId: '__VITE_FIREBASE_APP_ID__',
});

const messaging = firebase.messaging();

/** Same asset as src/notification.js — play in SW so background pushes use IPL tone, not the OS default. */
const IPL_SOUND_URL = '/sounds/ipl-notification.wav';

function tryPlayIplSound() {
  const AudioCtx = self.AudioContext || self.webkitAudioContext;
  if (!AudioCtx) return Promise.resolve(false);
  const ctx = new AudioCtx();
  return ctx
    .resume()
    .then(() => fetch(IPL_SOUND_URL))
    .then((r) => {
      if (!r.ok) throw new Error('sound fetch');
      return r.arrayBuffer();
    })
    .then((buf) => ctx.decodeAudioData(buf.slice(0)))
    .then((audioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(ctx.destination);
      src.start(0);
      return true;
    })
    .catch(() => false);
}

/**
 * Show notification: play IPL chime when possible and set silent=true to avoid double beep with OS default.
 */
function showNotificationWithIplSound(title, body, baseOptions) {
  const t = title || 'IPL Prediction';
  return tryPlayIplSound().then((played) =>
    self.registration.showNotification(t, {
      ...baseOptions,
      silent: !!played,
    })
  );
}

messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const n = payload.notification || {};
  // Prefer data.title/body (data-only FCM avoids duplicate notifications with SW showNotification).
  const title = data.title || n.title || 'IPL Prediction';
  const body = data.body || n.body || '';
  const url = (data.url || '/dashboard').startsWith('/') ? (data.url || '/dashboard') : '/dashboard';
  const tag = ['fcm', data.type || '', data.matchId || ''].filter(Boolean).join('-') || 'ipl-fcm';
  const options = {
    body: body || '',
    icon: '/favicon.png',
    badge: '/favicon.png',
    vibrate: [180, 100, 180],
    tag,
    renotify: true,
    data: { url },
  };
  return showNotificationWithIplSound(title, body, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || '/dashboard';
  const fullUrl = urlToOpen.startsWith('http') ? urlToOpen : new URL(urlToOpen, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.navigate(fullUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(fullUrl);
    })
  );
});
