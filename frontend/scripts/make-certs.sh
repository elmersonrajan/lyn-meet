#!/bin/sh
set -e
cd "$(dirname "$0")/.."
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=59.96.57.40" \
  -addext "subjectAltName=IP:59.96.57.40,IP:192.168.1.55,DNS:localhost"
echo "wrote frontend/key.pem and frontend/cert.pem"
