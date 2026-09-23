const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Max contacts accepted in one /bulk request, and how many Vumber calls run at once.
const MAX_CONTACTS = parseInt(process.env.SMS_MAX_CONTACTS, 10) || 500;
const CONCURRENCY = parseInt(process.env.SMS_CONCURRENCY, 10) || 5;

const app = express();
app.use(express.json({ limit: '10mb' }));

// Allow the standalone upload tool (opened from any origin) to call this API.
app.use((req, res, next) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
	if (req.method === 'OPTIONS') {
		res.status(200).end();
		return;
	}
	next();
});

// Rejects requests whose key doesn't match SMS_API_KEY. The key is read from the JSON
// body's apiKey (what the upload page sends, so no extra CORS header is needed) or an
// X-API-Key header. Fails closed if SMS_API_KEY isn't configured.
function requireApiKey(req, res, next) {
	const expected = process.env.SMS_API_KEY;
	if (!expected) {
		res.status(500).send({ success: false, error: 'SMS_API_KEY is not configured on the server' });
		return;
	}
	const given = String((req.body && req.body.apiKey) || req.get('X-API-Key') || '');
	const a = crypto.createHash('sha256').update(given).digest();
	const b = crypto.createHash('sha256').update(expected).digest();
	if (!crypto.timingSafeEqual(a, b)) {
		res.status(401).send({ success: false, error: 'Invalid or missing API key' });
		return;
	}
	next();
}

function applyMergeFields(template, contact) {
	// Handles {field_name} or {field_name|fallback text} merge-tag syntax.
	// Looks up field_name case-insensitively against whatever keys the contact object has
	// (CSV/Excel column headers).
	return template.replace(/\{([A-Za-z_]+)(?:\|([^}]*))?\}/g, (match, fieldName, fallback = '') => {
		const normalized = fieldName.toLowerCase().replace(/_/g, '');
		const key = Object.keys(contact).find(k => k.toLowerCase().replace(/[_\s]/g, '') === normalized);
		const value = key ? contact[key] : undefined;
		return (value && String(value).trim()) ? String(value).trim() : fallback;
	});
}

async function sendVumberSms(publicNumber, customerPhoneNumber, content) {
	const url = `https://api.vumber.com/api/v1/a/${process.env.VUMBER_ACCOUNT_NO}/text-messages`;
	const resp = await fetch(url, {
		method: 'POST',
		headers: {
			'X-API-Key': process.env.VUMBER_API_KEY,
			'Content-Type': 'application/json',
			accept: '*/*'
		},
		body: JSON.stringify({ publicNumber, customerPhoneNumber, content })
	});
	const text = await resp.text();
	let data;
	try { data = JSON.parse(text); } catch { data = { raw: text }; }
	if (!resp.ok) throw new Error(`Vumber ${resp.status}: ${JSON.stringify(data)}`);
	return data;
}

function findPhone(contact) {
	const key = Object.keys(contact).find(k => {
		const norm = k.toLowerCase().replace(/[_\s]/g, '');
		return norm === 'phone' || norm === 'mobile' || norm === 'mobilenumber' || norm === 'phonenumber';
	});
	return key ? String(contact[key]).trim() : null;
}

// Strips spaces, dashes, dots and brackets; keeps a leading +. Returns null unless the
// result is 7-15 digits (E.164 length). No country code is added.
function normalizePhone(raw) {
	const trimmed = String(raw).trim();
	const plus = trimmed.startsWith('+') ? '+' : '';
	const digits = trimmed.replace(/[\s\-().]/g, '').replace(/^\+/, '');
	if (!/^\d{7,15}$/.test(digits)) return null;
	return plus + digits;
}

// Runs worker(item) over items with at most `limit` in flight, preserving order.
async function mapWithConcurrency(items, limit, worker) {
	const results = new Array(items.length);
	let next = 0;
	async function run() {
		while (next < items.length) {
			const i = next++;
			results[i] = await worker(items[i]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
	return results;
}

async function sendBatch(contacts, messageTemplate) {
	const seen = new Set();

	return mapWithConcurrency(contacts, CONCURRENCY, async (contact) => {
		const rawPhone = findPhone(contact);
		if (!rawPhone) return { phone: null, skipped: true, reason: 'no phone/mobile field found' };

		const phone = normalizePhone(rawPhone);
		if (!phone) return { phone: rawPhone, skipped: true, reason: 'invalid phone number' };
		if (seen.has(phone)) return { phone, skipped: true, reason: 'duplicate phone number' };
		seen.add(phone);

		const content = applyMergeFields(messageTemplate, contact);
		const sentAt = new Date().toISOString();

		try {
			const smsData = await sendVumberSms(process.env.VUMBER_PUBLIC_NUMBER, phone, content);
			// Vumber's /text-messages endpoint only confirms the message was accepted for
			// sending — it has no delivery-receipt field and no GET-by-id status endpoint,
			// so "success" here means "submitted OK", not "confirmed delivered by carrier".
			return { phone, message: content, sentAt, success: smsData.success, messageId: smsData.messageId };
		} catch (e) {
			return { phone, message: content, sentAt, success: false, error: e.message };
		}
	});
}

async function handleBulkRequest(req, res) {
	try {
		const { contacts, message } = req.body || {};

		if (!Array.isArray(contacts) || contacts.length === 0) {
			res.status(400).send({ success: false, error: 'contacts array is required and must not be empty' });
			return;
		}
		if (contacts.length > MAX_CONTACTS) {
			res.status(400).send({ success: false, error: `Too many contacts (${contacts.length}); the limit per send is ${MAX_CONTACTS}` });
			return;
		}
		if (!message || typeof message !== 'string') {
			res.status(400).send({ success: false, error: 'message (string) is required' });
			return;
		}

		const results = await sendBatch(contacts, message);
		const sentOk = results.filter(r => r.success).length;
		const skipped = results.filter(r => r.skipped).length;
		const failed = results.length - sentOk - skipped;

		res.status(200).send({ success: true, total: results.length, sent: sentOk, skipped, failed, results });

	} catch (err) {
		res.status(500).send({ success: false, error: err.message });
	}
}

// Serves the upload page from the function itself, so the page and /bulk share one
// origin (no CORS, no separate web hosting). index.html is copied in by bundle.sh.
const pagePath = path.join(__dirname, 'index.html');
app.get(['/', '/index.html'], (req, res) => {
	if (!fs.existsSync(pagePath)) {
		res.status(404).send('index.html is not bundled with this function; build the zip with bundle.sh');
		return;
	}
	res.sendFile(pagePath);
});

app.post('/bulk', requireApiKey, handleBulkRequest);
app.options('/bulk', (req, res) => res.status(200).end());

module.exports = app;
