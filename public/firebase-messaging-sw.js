/* eslint-disable */
// Auto-generated - do not edit. Config from .env
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCnevLfquFHcDVQwSDY-nPmMs7UqdZWSvU',
  authDomain: 'ipl-prediction-29bd1.firebaseapp.com',
  projectId: 'ipl-prediction-29bd1',
  storageBucket: 'ipl-prediction-29bd1.firebasestorage.app',
  messagingSenderId: '968719753773',
  appId: '1:968719753773:web:f0580ae8ba17814a2b0ea4',
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  const options = { body: body || '', icon: '/vite.svg' };
  self.registration.showNotification(title || 'IPL Prediction', options);
});
