# GitHub Actions – Deploy Firebase Functions

This guide walks you through setting up **automatic deployment** of Firebase functions when you push to GitHub. The schedule (`SCHEDULE_INTERVAL`) is configurable via a GitHub secret.

---

## Step 1: Get Firebase CI Token

Run this in **Command Prompt** (not PowerShell) on your machine:

```
cd c:\Users\omans\ipl-prediction-portal
npx firebase login:ci
```

1. A browser opens – sign in with your Google account.
2. Copy the **long token** from the terminal (e.g. `1//0abcdef123...`).
3. Keep it safe – you will add it as a GitHub secret.

---

## Step 2: Add GitHub Secrets

1. Open your repo on GitHub.
2. Go to **Settings** → **Secrets and variables** → **Actions**.
3. Click **New repository secret** and add these:

| Secret name        | Value                              | Required |
|--------------------|------------------------------------|----------|
| `FIREBASE_TOKEN`   | Token from Step 1                  | Yes      |
| `SCHEDULE_INTERVAL`| e.g. `every 10 minutes`            | No (default: every 10 minutes) |
| `SCHEDULE_TIMEZONE`| e.g. `Asia/Kolkata`                | No (default: Asia/Kolkata) |

**Example values for `SCHEDULE_INTERVAL`:**

- `every 5 minutes`
- `every 10 minutes`
- `every 15 minutes`
- `every 30 minutes`
- `every 1 hours`
- `*/5 * * * *` (cron – every 5 minutes)

---

## Step 3: Push the Workflow

Commit and push the workflow file:

```
git add .github/workflows/deploy-functions.yml
git commit -m "Add GitHub Actions deploy for Firebase functions"
git push origin main
```

If your default branch is different (e.g. `master`), change the workflow’s `branches` accordingly.

---

## Step 4: How It Runs

| Trigger | When it runs |
|---------|--------------|
| **Automatic** | On push to `main` when `functions/` or the workflow file changes |
| **Manual** | From GitHub → **Actions** → **Deploy Firebase Functions** → **Run workflow** |

---

## Step 5: Change the Schedule Later

1. Go to **Settings** → **Secrets and variables** → **Actions**.
2. Edit `SCHEDULE_INTERVAL` (e.g. change to `every 5 minutes`).
3. Go to **Actions** → **Deploy Firebase Functions** → **Run workflow** to deploy.
4. Or push any change under `functions/` to trigger an automatic deploy.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `FIREBASE_TOKEN` invalid | Run `npx firebase login:ci` again and update the secret |
| `Permission denied` | Check that your Google account has Firebase admin access to the project |
| Workflow not triggering | Confirm the branch in `branches: [main]` matches your default branch |
