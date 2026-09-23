#!/bin/sh
# Builds send_sms.zip for uploading to Catalyst: the function code, its dependencies,
# and a copy of client/index.html so the function can serve the upload page.
set -e
cd "$(dirname "$0")/functions/send_sms"
npm ci --omit=dev
cp ../../client/index.html index.html
rm -f ../../send_sms.zip
zip -qr ../../send_sms.zip index.js index.html package.json package-lock.json catalyst-config.json node_modules
rm index.html
echo "Built send_sms.zip"
