const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Allow the standalone upload tool (opened from any origin) to call this API.
app.use((req, res, next) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') {
		res.status(200).end();
		return;
	}
	next();
});

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
	const data = await resp.json();
	if (!resp.ok) throw new Error(JSON.stringify(data));
	return data;
}

function findPhone(contact) {
	const key = Object.keys(contact).find(k => {
		const norm = k.toLowerCase().replace(/[_\s]/g, '');
		return norm === 'phone' || norm === 'mobile' || norm === 'mobilenumber' || norm === 'phonenumber';
	});
	return key ? String(contact[key]).trim() : null;
}

async function sendBatch(contacts, messageTemplate) {
	const results = [];
	const sendPromises = contacts.map(async (contact) => {
		const phone = findPhone(contact);
		if (!phone) return { phone: null, skipped: true, reason: 'no phone/mobile field found' };

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

	const settled = await Promise.all(sendPromises);
	for (const r of settled) results.push(r);
	return results;
}

async function handleBulkRequest(req, res) {
	try {
		const { contacts, message } = req.body || {};

		if (!Array.isArray(contacts) || contacts.length === 0) {
			res.status(400).send({ success: false, error: 'contacts array is required and must not be empty' });
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

app.post('/bulk', handleBulkRequest);
app.options('/bulk', (req, res) => res.status(200).end());

module.exports = app;
