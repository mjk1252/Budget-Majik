# Quick expense entry on iPhone

Budget Majik's website can open straight into **Log expense**. The link uses the same website and sync connection you already use; it does not need bank transaction downloads.

1. Open the website on your iPhone and tap **+ Log expense**.
2. Tap **Copy iPhone shortcut link**.
3. In Apple's **Shortcuts** app, create a shortcut with a **URL** action containing that link, followed by **Open URLs**.
4. Name it **Log expense**. Add the shortcut to your Home Screen or a Shortcuts widget. On iPhones that support Lock Screen shortcut controls, you can also place it there.

Opening the shortcut takes you directly to the quick entry form. Enter the amount, tap a frequent category, and save. The normal website also has a **Repeat** button beside each expense to prefill a new entry for today.

The direct link has `?quick=1` at the end. If you change the website address later, copy a new link. It contains no Google Sheets sync URL or token.

# Weekly balance check

Tap **Balance check** and enter the balance displayed for the same bank account each time. The first check of each month sets a starting point. Subsequent checks compare the actual balance with the change in Budget Majik's **Expected in bank** figure since that starting point. A difference is shown for you to investigate; the check does not create an expense or change a budget.

The estimate assumes this month's income has reached your bank and uses the expenses, loans, and cash adjustments currently recorded in the app. If you use several accounts or an income payment has not arrived yet, the difference may include those amounts. Start with a new bank balance each month.
