# IPL Winner Prediction Portal

A React + Firebase web application for predicting IPL cricket match winners. Users register, verify their email, and predict daily match outcomes.

## Features

- **User Registration**: Email, username, and password. OTP sent via EmailJS; user enters 6-digit code to verify
- **User Login**: Username OR email + password (after OTP verification)
- **Admin Panel**: Create teams, add rules, schedule matches
- **Match Predictions**: Users predict winners for today's matches; data stored in Firebase

## Setup

### 1. Firebase Project

1. Create a project at [Firebase Console](https://console.firebase.google.com)
2. Enable **Authentication** → Email/Password
3. Create a **Firestore Database**
4. Copy your config from Project Settings

### 2. EmailJS (OTP Emails)

1. Create account at [EmailJS](https://www.emailjs.com/)
2. Add an **Email Service** (e.g. Gmail)
3. Create an **Email Template** with these variables:
   - `{{otp}}` – the 6-digit OTP code
   - `{{to_email}}` or `{{email}}` – recipient email
4. Copy Service ID, Template ID, and Public Key

### 3. Environment Variables

Create `.env` in the project root:

```
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=your-app-id

VITE_EMAILJS_SERVICE_ID=your-service-id
VITE_EMAILJS_TEMPLATE_ID=your-template-id
VITE_EMAILJS_PUBLIC_KEY=your-public-key
```

### 4. Firestore Rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /teams/{docId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.isAdmin == true;
    }
    match /rules/{docId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.isAdmin == true;
    }
    match /matches/{docId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.isAdmin == true;
    }
    match /predictions/{docId} {
      allow read: if request.auth != null;
      allow create, update: if request.auth != null && request.resource.data.userId == request.auth.uid;
    }
  }
}
```

### 5. Create First Admin

After registering a user, go to Firestore → `users` collection → your user document → add field `isAdmin: true`.

### 6. Run

```bash
npm install
npm run dev
```

## Data Structure

- **users**: `{ email, username, isAdmin, createdAt }`
- **teams**: `{ name, createdBy, createdAt }`
- **rules**: `{ content, createdBy, createdAt }`
- **matches**: `{ team1, team2, date (YYYY-MM-DD), slot, status, createdAt }`
- **predictions**: `{ userId, matchId, predictedWinner, username, createdAt }`
