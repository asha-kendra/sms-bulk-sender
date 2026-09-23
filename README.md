# SMS Bulk Sender

A small full-stack app for sending a merge-tagged SMS blast to a list of contacts uploaded as CSV/Excel, via a Zoho Catalyst function backed by the Vumber SMS API.

## Structure

```
sms-bulk-sender/
├── client/
│   └── index.html        # Static frontend — upload a contact list, write a message, send
└── functions/
    └── send_sms/          # Zoho Catalyst "advancedio" Node function (Express app)
        ├── index.js
        ├── package.json
        ├── package-lock.json
        └── catalyst-config.json
```

## How it works

1. **Frontend** (`client/index.html`) — a single static page. You drop in a CSV/XLSX file (parsed client-side with SheetJS), the file must have a `phone` or `mobile` column. You write a message using merge tags like `{first_name}` or `{first_name|there}` (case/space/underscore-insensitive match against your file's column headers, optionally falling back to given text if the column is empty/missing — blank if no fallback given). Clicking **Send** POSTs `{ contacts, message }` as JSON to the backend URL configured at the top of the page, with the API key from the page as `apiKey` in the same JSON body.

2. **Backend** (`functions/send_sms/index.js`) — an Express app deployed as a Catalyst function with one route: `POST /bulk`. Rejects the request with `401` unless the body's `apiKey` (or an `X-API-Key` header) matches `SMS_API_KEY`. Takes `{ contacts: [...], message: "..." }` (at most `SMS_MAX_CONTACTS`), normalizes each phone number (strips spaces, dashes, dots and brackets; keeps a leading `+`; must be 7–15 digits), skips invalid and duplicate numbers, applies the merge tags per-contact, and sends each via the Vumber API with at most `SMS_CONCURRENCY` requests in flight. Returns per-contact results: `phone`, `success`/`skipped`, `sentAt` (ISO timestamp), `message` (the resolved text actually sent to that contact), and `messageId` or an `error`/`reason`.

3. **Results table** — after a send, the frontend shows a per-contact table (status, sent time, resolved message, and the Vumber message ID or error) plus sent/failed/skipped counts. Note: "Sent" means Vumber accepted the message for sending — their `/text-messages` API has no delivery-receipt field and no GET-by-id status endpoint, so true carrier delivery confirmation isn't available through this API.

## Required environment variables (set in the Catalyst console, or via the Catalyst MCP `Update_Environment_Variable` tool)

| Variable | Used for |
|---|---|
| `VUMBER_API_KEY` | Auth for the Vumber SMS API |
| `VUMBER_ACCOUNT_NO` | Vumber account the messages are sent from |
| `VUMBER_PUBLIC_NUMBER` | The sending number |
| `SMS_API_KEY` | Shared secret callers must send as `apiKey` in the body (or an `X-API-Key` header). **Required** — if unset, `/bulk` refuses every request |
| `SMS_MAX_CONTACTS` | Optional, default `500`. Max contacts per request |
| `SMS_CONCURRENCY` | Optional, default `5`. Parallel Vumber calls |

## Running locally

Frontend: it's a static file, just open `client/index.html` in a browser, or serve the folder:

```bash
npx serve client
```

Backend: Catalyst functions aren't meant to run as a plain Node server locally in this exported form (no local dev harness is included in the export) — install deps and deploy instead:

```bash
cd functions/send_sms
npm install
```

## Deploying

This is a standard Catalyst function export (`catalyst-config.json` names it `send_sms`, stack `node24`, type `advancedio`). If you have the Catalyst CLI set up and linked to your project:

```bash
catalyst deploy --only functions/send_sms
```

### Hosting the page on Catalyst

Opening `index.html` straight from disk (`file://`) makes the browser send an origin Catalyst won't accept, so sends fail with "Failed to fetch". Host it in the same Catalyst project instead: zip `client/index.html` and `client/client-package.json` (both at the zip root) and upload the zip under Web Client Hosting, or run `catalyst deploy --only client` from a linked project. The page is then served from the project's own domain, so no CORS setup is needed.

Then point `client/index.html`'s "Catalyst function URL" field at the deployed `/bulk` route for that function (an API Gateway route pointing at it — the original page shipped with `.../server/sms_campaign/bulk`, which may be a differently-named gateway route mapped to this same function).

## Notes

- Phone numbers are not given a country code. Numbers without a leading `+` are sent to Vumber as-is (digits only), so use full international format in your file if Vumber needs it.
- A whole send runs inside one function call. With the defaults (500 contacts, 5 at a time) a slow Vumber API could approach the function's execution timeout; split very large lists into several uploads.
- "Sent" means Vumber accepted the message; there is no carrier delivery confirmation (see above).
