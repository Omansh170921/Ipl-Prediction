# Scheduled Push Notifications - Setup Guide

This guide walks you through setting up **scheduled push notifications** that send reminders to all registered users **15 minutes before** each match's prediction cutoff time.

**Requirements:**
- Firebase Blaze (pay-as-you-go) plan ✅
- Firebase Cloud Messaging (FCM) already configured in your project

---

## What Gets Deployed & Where

| What | Where |
|------|-------|
| **Cloud Functions** | Your Firebase project (`ipl-prediction-29bd1`) |
| **Deploy from** | Project root folder: `c:\Users\omans\ipl-prediction-portal` |
| **Source code** | `functions/` folder (index.js, package.json) |

**Functions deployed:**
1. `scheduledPredictionReminder` – runs every 10 min (IST), sends push 15 min before prediction cutoff (only to users who haven’t predicted yet)
2. `resetPasswordWithOTP` – existing function (unchanged)

---

## Step-by-Step Deployment Process

### Step 1: Enable APIs (Firebase / Google Cloud)

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Select project: **ipl-prediction-29bd1** (top dropdown)
3. Go to **APIs & Services** → **Library**
4. Search and enable:
   - **Cloud Scheduler API** → Enable
   - **Cloud Pub/Sub API** → Enable

---

### Step 2: Set VAPID Key (for push notifications)

1. Open [Firebase Console](https://console.firebase.google.com/) → **ipl-prediction-29bd1**
2. Click **Project settings** (gear) → **Cloud Messaging** tab
3. Under **Web Push certificates**, copy the **Key pair** (or create one)
4. Add to your `.env` file in the project root:

```
VITE_VAPID_PUBLIC_KEY=your-copied-vapid-key-here
```

**Schedule (optional):** Add to `.env` to change when the reminder runs:
- `SCHEDULE_INTERVAL` – e.g. `every 5 minutes`, `every 10 minutes`, `every 15 minutes`
- `SCHEDULE_TIMEZONE` – e.g. `Asia/Kolkata` (default)

**Deploy via GitHub Actions:** See [.github/GITHUB_DEPLOY_SETUP.md](.github/GITHUB_DEPLOY_SETUP.md) to deploy automatically and control the schedule via GitHub secrets.

---

### Step 3: Log in to Firebase (one-time)

1. Open **PowerShell** or **Command Prompt**
2. Run:

```
cd c:\Users\omans\ipl-prediction-portal
npx firebase login
```

3. A browser window opens → sign in with your Google account
4. When you see “Success! Logged in as …”, you’re done

---

### Step 4: Install Dependencies in `functions/`

```
cd c:\Users\omans\ipl-prediction-portal\functions
npm install
cd ..
```

---

### Step 5: Deploy Only Functions

From the **project root** folder:

**Command Prompt:**
```
cd c:\Users\omans\ipl-prediction-portal
set FUNCTIONS_DISCOVERY_TIMEOUT=30000
npx firebase deploy --only functions
```

**PowerShell:**
```
cd c:\Users\omans\ipl-prediction-portal
$env:FUNCTIONS_DISCOVERY_TIMEOUT=30000; npx firebase deploy --only functions
```

*(The timeout variable helps avoid "Cannot determine backend specification" on slower systems.)*

**Expected output:**
```
✔  functions: Finished running predeploy script.
i  functions: preparing functions directory for uploading...
✔  functions: functions folder uploaded successfully
i  functions: updating Node.js 18 function scheduledPredictionReminder...
i  functions: updating Node.js 18 function resetPasswordWithOTP...
✔  functions[scheduledPredictionReminder]: Successful update operation.
✔  functions[resetPasswordWithOTP]: Successful update operation.
✔  Deploy complete!
```

---

### Step 6: Verify Deployment

1. Go to [Firebase Console](https://console.firebase.google.com/) → **ipl-prediction-29bd1**
2. Click **Functions** in the left sidebar
3. You should see:
   - `scheduledPredictionReminder` (trigger: Cloud Scheduler)
   - `resetPasswordWithOTP` (trigger: HTTPS callable)

---

## Troubleshooting: "Waiting for Deployment" in Firebase Console

If the Functions page only shows **"Waiting for deployment"**, do the following:

### 1. Check billing plan (required for Cloud Functions)

Cloud Functions **require the Blaze (pay-as-you-go) plan**.

1. Firebase Console → ⚙️ **Project settings** → **Usage and billing**
2. If you see **"Upgrade"** or **"Spark plan"**, click **Upgrade to Blaze**
3. Add a billing account (you get free monthly usage; you’re not charged unless you exceed it)

### 2. Deploy from your terminal

"Waiting for deployment" usually means no successful deploy has happened yet.

1. Open **PowerShell** or **Command Prompt**
2. Run:

```
cd c:\Users\omans\ipl-prediction-portal
npx firebase login
npx firebase deploy --only functions
```

3. Watch for errors. Deployment succeeds only if you see something like:

```
✔  functions[scheduledPredictionReminder]: Successful update operation.
✔  functions[resetPasswordWithOTP]: Successful update operation.
✔  Deploy complete!
```

### 3. If deployment fails

- **"Billing account" error** → Upgrade to Blaze plan (Step 1)
- **"Permission denied"** → Run `npx firebase login` again
- **"Cloud Scheduler" or "Pub/Sub"** → Enable those APIs in [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Library

### 4. After successful deploy

Refresh the Firebase Console → **Functions** page. The functions should appear within 1–2 minutes.

---

## How It Works

| Component | Behavior |
|-----------|----------|
| **Frontend** | When a logged-in user grants notification permission, the FCM token is saved to `users/{userId}.fcmToken` |
| **Scheduled Function** | Runs every 10 minutes (IST). For each **today's** open match where the prediction cutoff is in ~15 minutes, it sends a push only to users who have **not yet predicted** for that match (and have an `fcmToken`) |
| **Tracking** | After sending, it sets `matches/{matchId}.predictionReminderSentAt` so the same match is not reminded again |

---

## Match Time Format

Matches use **IST (Asia/Kolkata)**. Ensure your matches have:

- `date`: `"YYYY-MM-DD"` (e.g. `"2025-03-20"`)
- `thresholdTime`: `"HH:MM"` (e.g. `"18:00"` for 6 PM cutoff)

The reminder is sent at **thresholdTime minus 15 minutes**.

---

## Test (Optional)

1. **Manual test:** Create a match with `date` = today and `thresholdTime` = ~20 minutes from now.
2. Wait for the next scheduled run (within 10 minutes).
3. Ensure you're logged in, have granted notifications, and have an `fcmToken` in your user doc.

Or invoke the function manually from Firebase Console → Functions → `scheduledPredictionReminder` → Logs.

---

## Blaze Plan Costs (Approximate)

- **Cloud Scheduler:** 3 free jobs per month; beyond that, ~$0.10/job/month
- **Cloud Functions:** 2M invocations/month free; runs ~4,320 times/month (every 10 min)
- **FCM:** Free for standard usage

Staying within free tiers is typical for small–medium apps.
