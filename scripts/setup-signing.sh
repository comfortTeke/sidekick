#!/bin/bash
# One-time setup: creates a personal code signing certificate in your login keychain.
# Signing every build with the same certificate lets macOS remember Sidekick's
# Microphone and Screen Recording permissions across updates.
set -e

NAME="Sidekick Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "Signing certificate already set up."
  exit 0
fi

echo ""
echo "Setting up a personal signing certificate for Sidekick (one time only)."
echo "macOS will ask for your Mac password to trust it."
echo ""

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cert.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = $NAME
[ ext ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

# macOS's built-in openssl (LibreSSL) makes a p12 the keychain can import
OPENSSL=/usr/bin/openssl
$OPENSSL req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.cnf" 2>/dev/null
$OPENSSL pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$NAME" -out "$TMP/id.p12" -passout pass:sidekick 2>/dev/null

security import "$TMP/id.p12" -k "$KEYCHAIN" -P sidekick -T /usr/bin/codesign >/dev/null
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"

echo "Signing certificate created."
