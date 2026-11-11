# Google Sheets Sync — One-Time Setup (~5 minutes)

Do this once. Afterwards, each device just needs the URL pasted into the website.

## 1. Create the sheet

1. Go to [sheets.new](https://sheets.new) (signed in as mjk.visser@gmail.com).
2. Name it something like **Budget Majik**.

## 2. Add the script

1. In the sheet, open **Extensions → Apps Script**.
2. Delete any code in the editor.
3. Open `google-apps-script.gs` (in this folder), copy **all** of it, and paste it into the editor.
4. Click the 💾 save icon.
5. Select **setupStorage** in the function dropdown and click **Run**. Authorize your own script when prompted. This records the spreadsheet ID so web requests open the correct file without relying on an active spreadsheet. This does not change your budget data.

## 3. Deploy as a web app

1. Click **Deploy → New deployment**.
2. Click the ⚙️ gear next to "Select type" → choose **Web app**.
3. Set:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone` *(anyone who obtains this URL can read or update the budget; keep it private)*
4. Click **Deploy**, approve the permissions prompt (it will warn the app is unverified — click *Advanced → Go to … (unsafe)* → *Allow*; it's your own script).
5. Copy the **Web app URL** (ends in `/exec`).

## 4. Connect Budget Majik

1. In Budget Majik, click the **Sync** button (top right).
2. Paste the URL, click **Save & sync**.
3. The dot turns green when connected. Repeat this step on your other devices with the same URL.

## How it works

- Changes save immediately in this browser. After a 700 ms pause, the website uploads the latest changes together. Requests run one at a time; edits made during an upload are sent afterward.
- The browser keeps the last acknowledged server copy alongside pending local changes. On reopening the page, those changes are merged with the latest server data, including independent edits from other devices. A browser cache with no recorded sync baseline is initially refreshed from an existing server budget rather than treated as newer just because of its timestamp.
- Failed requests retry with increasing delays, up to one minute between attempts. Requests time out after 45 seconds. Returning to the page or regaining connectivity also refreshes sync. **Saved locally · pending sync** and **Saved locally · retrying sync** mean changes still need uploading; **Synced** means they have been acknowledged.
- Each upload carries the server revision last observed. The script locks reads/writes and rejects stale uploads. Conflicts trigger a fresh read and merge before retrying. If two devices change the same field, the uploading device's local edit wins.
- Only raw JSON in **_data** is updated. **Overview** and **Expenses** from older versions are left untouched and will no longer reflect new changes. Don't edit **_data** manually. The script does not format, rebuild, delete, or hide tabs during sync.
- Website connection settings and its local sync baseline are not uploaded. iPhone Shortcut category lookup and expense entry remain supported, including duplicate-transaction protection.

## Updating the script later

For this update:

1. Export a JSON backup using **Sync → Export backup**.
2. Replace the Apps Script editor contents with all of `google-apps-script.gs`, then save.
3. Run **setupStorage** once from that editor. Keep the existing spreadsheet and Shortcut token; there is no need to run `createShortcutToken` again.
4. Use **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy**. This keeps your existing `/exec` URL.
5. Publish the updated website files (`mobile/` and `renderer/`) and refresh the website on every device. The website needs the new script's acknowledged server revision, so update both together.

The automated tests simulate rapid edits, offline reloads, stale clients, lost responses, Shortcut duplicates, and multi-cell JSON storage. They do not connect to your deployed Google script. After deployment, make several small edits, wait for **Synced**, and open a second device to verify the changes.
