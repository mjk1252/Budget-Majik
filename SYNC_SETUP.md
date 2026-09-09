# Google Sheets Sync — One-Time Setup (~5 minutes)

Do this once. Afterwards, every PC just needs the URL pasted into the app.

## 1. Create the sheet

1. Go to [sheets.new](https://sheets.new) (signed in as mjk.visser@gmail.com).
2. Name it something like **Budget Majik**.

## 2. Add the script

1. In the sheet, open **Extensions → Apps Script**.
2. Delete any code in the editor.
3. Open `google-apps-script.gs` (in this folder), copy **all** of it, and paste it into the editor.
4. Click the 💾 save icon.

## 3. Deploy as a web app

1. Click **Deploy → New deployment**.
2. Click the ⚙️ gear next to "Select type" → choose **Web app**.
3. Set:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone` *(the URL is an unguessable secret — only someone with the exact link can reach it)*
4. Click **Deploy**, approve the permissions prompt (it will warn the app is unverified — click *Advanced → Go to … (unsafe)* → *Allow*; it's your own script).
5. Copy the **Web app URL** (ends in `/exec`).

## 4. Connect Budget Majik

1. In Budget Majik, click the **Sync** button (top right).
2. Paste the URL, click **Save & sync**.
3. The dot turns green when connected. Repeat this step on your other PCs with the same URL.

## How it works

- Every change you make is pushed to the sheet automatically. When the app opens, an existing sheet is always treated as the source of truth and replaces the browser's cached copy; cached browser data is uploaded only when connecting to a genuinely empty sheet. Each later upload also carries the revision last read from the sheet, so a stale page cannot silently replace changes made elsewhere; it reports a sync conflict instead.
- The **Overview** and **Expenses** tabs in the sheet are a readable view of your data, regenerated on each sync. **Edits made directly in the sheet are not synced back** — the app is the source of truth. (The raw data lives in a hidden `_data` tab; don't edit that.)

## Updating the script later

If the script ever changes, paste the new version and use **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy**. This keeps the same URL. (A brand-new deployment gets a new URL and you'd have to re-paste it in the app.) This is required when updating the app's sync safeguards too.
