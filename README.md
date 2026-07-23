# Discord Username Checker — Vercel Edition

A static HTML/CSS/JavaScript dashboard with two Python Vercel Functions:

- `api/check.py` checks one Discord username per request.
- `api/webhook.py` tests a Discord webhook or sends a newly available username.

## Deploy from GitHub to Vercel

1. Extract this ZIP.
2. Upload **all files and folders** to the root of a GitHub repository.
3. In Vercel, choose **Add New → Project** and import that repository.
4. Leave the Framework Preset as **Other**.
5. Leave Build Command and Output Directory empty.
6. Press **Deploy**.

No environment variables, Discord token, `discord.py`, or external Python modules are required.

## Website usage

1. Open the deployed Vercel URL.
2. Paste a Discord webhook URL, then press **Save / update** or **Test webhook**.
3. Paste usernames or upload a `.txt` file with one name per line.
4. Press **Start checking**.

The browser checks at most 25 usernames per run with a five-second delay. Available names are:

- shown on the webpage;
- saved in that browser's local storage;
- sent to the configured webhook when enabled; and
- exported as `available_usernames.txt` when the run finishes, when auto-export is enabled.

Some mobile browsers may block the automatic file download. In that case, press **Download available_usernames.txt** on the page.

## Important Vercel behavior

Vercel Functions do not provide a permanent writable project filesystem. The generated available list and the webhook setting are therefore stored in the user's browser, not written back into GitHub or the Vercel deployment.

The webhook URL is sent only to the project's webhook function when testing or notifying. The function validates that it is an official Discord webhook URL and does not accept arbitrary message content.

## Notes

- This project does not include proxies or automatic claiming.
- Availability can change between checking a name and trying to use it.
- Discord or Vercel may rate-limit or block the undocumented unauthenticated availability endpoint.
