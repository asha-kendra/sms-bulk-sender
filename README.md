# SMS Bulk Sender

Upload a CSV/Excel contact list, write a message with merge tags, and send it as individual SMS via the Vumber API. One small Node/Express server serves the upload page and sends the texts.

## Structure

```
sms-bulk-sender/
├── server.js          # Express server: serves public/ and handles POST /bulk
├── public/
│   └── index.html     # Upload page
├── package.json
├── .env.example       # Settings template (copy to .env)
└── render.yaml        # Optional one-click deploy to Render
```

## How it works

1. **Page** (`public/index.html`): drop in a CSV/XLSX file (parsed in the browser with SheetJS). It needs a `phone` or `mobile` column. Write a message using merge tags like `{first_name}` or `{first_name|there}` (matches your column headers ignoring case, spaces and underscores, and falls back to the text after `|` when the cell is empty). Enter the API key and press **Send**.
2. **Server** (`server.js`): `POST /bulk` takes `{ contacts, message, apiKey }`. It:
   - rejects the request with `401` unless `apiKey` (or an `X-API-Key` header) matches `SMS_API_KEY`, and refuses every request if `SMS_API_KEY` isn't set;
   - accepts at most `SMS_MAX_CONTACTS` contacts;
   - cleans each phone number (removes spaces, dashes, dots and brackets, keeps a leading `+`, requires 7–15 digits) and skips invalid and duplicate numbers;
   - fills in the merge tags and sends each text via Vumber, `SMS_CONCURRENCY` at a time.
3. **Results**: the page shows each contact's status, time, the exact text sent, and the Vumber message ID or error, plus sent/failed/skipped counts. "Sent" means Vumber accepted the message; their API gives no carrier delivery confirmation.

## Settings

| Variable | Required | Used for |
|---|---|---|
| `VUMBER_API_KEY` | yes | Vumber API auth |
| `VUMBER_ACCOUNT_NO` | yes | Vumber account to send from |
| `VUMBER_PUBLIC_NUMBER` | yes | Sending number |
| `SMS_API_KEY` | yes | Password typed into the upload page |
| `PORT` | no (3000) | Port the server listens on |
| `SMS_MAX_CONTACTS` | no (500) | Max contacts per send |
| `SMS_CONCURRENCY` | no (5) | Parallel Vumber calls |

## Run on your computer

Needs [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/asha-kendra/sms-bulk-sender
cd sms-bulk-sender
npm install
cp .env.example .env     # then fill in the values
npm start
```

Open http://localhost:3000.

## Deploy online (Render, free plan)

1. Sign in at https://render.com with GitHub.
2. **New → Blueprint**, pick this repository. Render reads `render.yaml`.
3. Enter the four required settings when asked, then deploy.
4. Open the `https://…onrender.com` address Render gives you.

Free Render services go to sleep when unused, so the first page load after a while can take up to a minute.

## Notes

- Keep `SMS_API_KEY` private. Anyone with it and the page address can send texts from your Vumber account.
- Numbers are not given a country code. Store them in full international format (e.g. `+91…`) if Vumber needs it.
- A send runs as one request. For very large lists, split the file into several uploads.
