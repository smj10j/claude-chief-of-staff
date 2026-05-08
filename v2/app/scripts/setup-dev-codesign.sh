#!/usr/bin/env bash
#
# setup-dev-codesign.sh — one-time setup that creates a self-signed
# code-signing certificate in the login Keychain and configures the
# Tauri build to use it. Solves the "Mac password prompt every time
# I open the cos app" problem caused by unsigned dev builds, and
# stamps every binary you produce with your own signing identity
# instead of "ad-hoc".
#
# Why a *named* self-signed cert instead of `signingIdentity = "-"`:
# the ad-hoc dash is fine for ACL stability but says nothing about
# who built it. With a named cert, `codesign -dv` on any binary you
# produce shows "Authority=User — Chief of Staff (Dev)",
# and that's what macOS Keychain remembers as the trusted signer.
#
# Idempotent — re-running is a no-op if the cert already exists.
#
# Run once with:  npm run setup-codesign  (from v2/app)
#                 # or directly: bash v2/app/scripts/setup-dev-codesign.sh

set -euo pipefail

# Owner identity. Edit if someone else picks up the work — the cert's
# Common Name is the human-readable signature on every binary.
#
# A regular hyphen (not the prettier em-dash) is used as the separator
# because some macOS keychain tooling double-encodes non-ASCII in cert
# DNs, which orphans the cert from its private key on import.
OWNER_NAME="${COS_DEV_OWNER:-User}"
CERT_NAME="${OWNER_NAME} - Chief of Staff (Dev)"
KEYCHAIN_PATH="${HOME}/Library/Keychains/login.keychain-db"
VALID_DAYS=3650  # 10 years — this is a personal dev cert, not a CA root.

# Pre-flight: must be macOS, must have openssl and security on PATH.
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "setup-dev-codesign: this script only runs on macOS." >&2
  exit 1
fi
for tool in openssl security codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "setup-dev-codesign: required tool '$tool' not found on PATH." >&2
    exit 1
  fi
done

# Idempotency check: if a cert with this exact CN already exists in
# the login keychain AND has a private key paired with it, we're done.
# We accept untrusted (CSSMERR_TP_NOT_TRUSTED) identities — they
# still sign — so we drop the `-v` filter.
if security find-identity -p codesigning "$KEYCHAIN_PATH" 2>/dev/null \
   | grep -F "$CERT_NAME" >/dev/null; then
  echo "✓ '$CERT_NAME' already exists as a codesigning identity."
  echo "  Nothing to do. tauri.conf.json should already point at it."
  exit 0
fi

echo "Creating self-signed code-signing identity for '$OWNER_NAME'…"

WORK_DIR="$(mktemp -d -t cos-codesign)"
trap 'rm -rf "$WORK_DIR"' EXIT

KEY_PATH="$WORK_DIR/dev-codesign.key"
CRT_PATH="$WORK_DIR/dev-codesign.crt"
P12_PATH="$WORK_DIR/dev-codesign.p12"
CONF_PATH="$WORK_DIR/openssl.cnf"

# OpenSSL config — needs `extendedKeyUsage = codeSigning` so macOS
# treats the cert as a valid codesign identity (not just any TLS cert).
# `basicConstraints=CA:false` keeps it a leaf cert, not a fake CA.
cat > "$CONF_PATH" <<EOF
[ req ]
distinguished_name = dn
prompt             = no
x509_extensions    = v3_codesign

[ dn ]
CN = ${CERT_NAME}
O  = ${OWNER_NAME}
OU = Personal Dev Tools

[ v3_codesign ]
basicConstraints       = critical, CA:false
keyUsage               = critical, digitalSignature
extendedKeyUsage       = critical, codeSigning
subjectKeyIdentifier   = hash
EOF

# 2048-bit RSA — overkill for a personal dev cert but matches what
# Apple Developer certs use, so any tooling that compares formats
# won't flinch.
openssl req -x509 -newkey rsa:2048 -nodes \
  -days "$VALID_DAYS" \
  -keyout "$KEY_PATH" \
  -out "$CRT_PATH" \
  -config "$CONF_PATH" \
  -extensions v3_codesign \
  >/dev/null 2>&1

# Wrap key + cert into a .p12 so `security import` can ingest both at
# once. Use a transient throwaway password — `security import` with
# `-P ""` runs into MAC-verification quirks across openssl versions
# (some default to legacy-MAC, some to FIPS-MAC). A non-empty passout
# sidesteps that ambiguity. The .p12 lives in $WORK_DIR which the
# trap rm -rf's on exit — the Keychain is the real protection
# boundary.
P12_PASS="$(openssl rand -hex 16)"
openssl pkcs12 -export -legacy \
  -out "$P12_PATH" \
  -inkey "$KEY_PATH" \
  -in "$CRT_PATH" \
  -name "$CERT_NAME" \
  -passout "pass:$P12_PASS" \
  >/dev/null 2>&1

# Import with `-A`: the imported key is accessible to any application
# without an additional ACL prompt. The alternative (`-T <tool>` +
# `set-key-partition-list`) requires re-typing the login keychain
# password to update the partition list, which can't be automated
# without prompting. `-A` is the pragmatic choice for a personal dev
# signing identity — the security boundary is your laptop login, not
# this cert's ACL.
security import "$P12_PATH" \
  -P "$P12_PASS" \
  -k "$KEYCHAIN_PATH" \
  -A \
  >/dev/null

# Trust the cert as a code-signer in the user's trust domain. Without
# this, find-identity reports the cert as `(CSSMERR_TP_NOT_TRUSTED)`
# even though codesign can still use it. Adding user-level trust
# (no sudo, no system trust override) makes the cert chain through
# Apple's verifier without warnings. We use `-p codeSign` so the
# trust scope is *only* code signing — not TLS, not S/MIME.
security add-trusted-cert -p codeSign -k "$KEYCHAIN_PATH" "$CRT_PATH" \
  >/dev/null 2>&1 || {
    # Non-fatal — the identity is still usable for signing without
    # trust; trust just suppresses the "not trusted" tag in
    # find-identity. If this fails (likely an interactive auth
    # prompt got dismissed) the build still works.
    echo "(trust step skipped — the cert is usable for signing anyway)"
  }

# Verify the cert is findable as a codesigning identity. We use
# `find-identity` without `-v`: trusted/untrusted both count, since
# codesign accepts either for *signing* (trust matters for
# verification, not signing). A `(CSSMERR_TP_NOT_TRUSTED)` tag in
# the output is fine for our use case.
if ! security find-identity -p codesigning "$KEYCHAIN_PATH" \
     | grep -F "$CERT_NAME" >/dev/null; then
  echo "✗ Import claimed success but the identity isn't visible to" >&2
  echo "  codesigning. Open Keychain Access → login → My Certificates," >&2
  echo "  find '$CERT_NAME', and confirm the cert has a private key" >&2
  echo "  paired with it (▶ disclosure triangle should expand)." >&2
  exit 1
fi

cat <<EOF
✓ Created and imported '$CERT_NAME'
  into $KEYCHAIN_PATH

  tauri.conf.json bundle.macOS.signingIdentity is already set to this
  name. Re-run this script anytime — it short-circuits if the
  identity already exists.

Next steps:
  1. Build a release bundle:   cd v2/app && npm run tauri build
  2. Inspect the signature:
       codesign -dv 'src-tauri/target/release/bundle/macos/Chief of Staff.app' 2>&1 \\
         | grep -E 'Identifier|Authority|TeamIdentifier'
     Expected:  Identifier=com.smj10j.chiefofstaff
     For a self-signed dev cert there is NO 'Authority=' line — that's
     normal. The signature is still stable across rebuilds, which is
     what fixes the per-launch Keychain prompt.

EOF
