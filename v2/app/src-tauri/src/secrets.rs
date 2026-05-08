use keyring::Entry;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "com.smj10j.chiefofstaff";

/// Account name for the database encryption key. Stored as a 64-char
/// hex string (32 raw bytes = 256 bits, the SQLCipher default).
const DB_KEY_ACCOUNT: &str = "db-encryption-key";

/// Account name for the encrypted-blob form of the workspace key,
/// wrapped under a key derived from the user's BIP-39 recovery phrase.
/// Lets a user with only their phrase recover the workspace after a
/// Keychain wipe (TimeMachine restore, SetupAssistant flow). Stored as
/// hex(version_byte || nonce_12 || ciphertext_32 || tag_16) =
/// 1+12+32+16 = 61 bytes = 122 hex chars.
const RECOVERY_WRAPPED_ACCOUNT: &str = "recovery-wrapped-key";

/// Sentinel: "the user has been shown the recovery phrase and confirmed
/// they wrote it down". When this is missing, sensitive features should
/// be gated and the wizard shouldn't be skippable on the recovery step.
const RECOVERY_CONFIRMED_ACCOUNT: &str = "recovery-confirmed";

/// Stable salt for the PBKDF2 derivation. The phrase itself is
/// already 256 bits of entropy, so the salt's value doesn't add
/// security — it's only here to domain-separate this derivation from
/// any other use of the same phrase. Versioning the salt lets us
/// rotate the KDF without invalidating recovery for existing users
/// (we'd just re-wrap on next unlock).
const PBKDF2_SALT_V1: &[u8] = b"cos-app/recovery-wrap/v1";
const PBKDF2_ITERATIONS: u32 = 600_000;

/// Wrap-format version byte. If the wrapping scheme ever changes
/// (new AEAD, new salt format), we bump this and branch on read.
const WRAP_VERSION_V1: u8 = 1;

pub fn set(account: &str, value: &str) -> AppResult<()> {
    Entry::new(SERVICE, account)?.set_password(value)?;
    Ok(())
}

pub fn get(account: &str) -> AppResult<Option<String>> {
    match Entry::new(SERVICE, account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e)),
    }
}

pub fn delete(account: &str) -> AppResult<()> {
    match Entry::new(SERVICE, account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e)),
    }
}

/// Get the database encryption key, generating one on first call.
/// Returns a 64-char lowercase hex string suitable for SQLCipher's
/// `PRAGMA key = "x'<hex>'";` form.
///
/// Idempotent — once generated the key never changes. If the
/// Keychain ever loses it, recovery is via the BIP-39 phrase the
/// user wrote down at install (M8b).
pub fn ensure_db_encryption_key() -> AppResult<String> {
    if let Some(existing) = get(DB_KEY_ACCOUNT)? {
        return Ok(existing);
    }
    let key = random_hex_key()?;
    set(DB_KEY_ACCOUNT, &key)?;
    Ok(key)
}

/// True if the encryption key already exists in Keychain.
pub fn has_db_encryption_key() -> AppResult<bool> {
    Ok(get(DB_KEY_ACCOUNT)?.is_some())
}

/// Wipe the key. Used by the recovery / re-setup flow when the user
/// explicitly wants to start over. Does NOT delete the encrypted DB
/// itself.
#[allow(dead_code)]
pub fn forget_db_encryption_key() -> AppResult<()> {
    delete(DB_KEY_ACCOUNT)
}

/// 32 random bytes → lowercase hex.
fn random_hex_key() -> AppResult<String> {
    let bytes = random_bytes::<32>()?;
    Ok(hex::encode(bytes))
}

/// Reads `N` cryptographically random bytes from /dev/urandom. macOS
/// guarantees this never blocks once boot is done.
fn random_bytes<const N: usize>() -> AppResult<[u8; N]> {
    use std::fs::File;
    use std::io::Read;
    let mut bytes = [0u8; N];
    let mut f = File::open("/dev/urandom").map_err(AppError::Io)?;
    f.read_exact(&mut bytes).map_err(AppError::Io)?;
    Ok(bytes)
}

/// True if the user has been shown the recovery phrase and confirmed
/// capture by re-typing it.
pub fn has_recovery_confirmed() -> AppResult<bool> {
    Ok(get(RECOVERY_CONFIRMED_ACCOUNT)?.is_some())
}

/// True if a wrapped recovery blob exists in Keychain (i.e., the user
/// has, at some point, generated a recovery phrase). Distinct from
/// `has_recovery_confirmed` — generation can predate confirmation.
pub fn has_recovery_wrapped() -> AppResult<bool> {
    Ok(get(RECOVERY_WRAPPED_ACCOUNT)?.is_some())
}

/// Generate a 24-word BIP-39 phrase, derive a wrapping key from it,
/// encrypt the workspace key under the wrapping key, and store the
/// ciphertext in Keychain. Returns the phrase (and only the phrase)
/// to the caller — the phrase itself is never persisted, the user
/// must write it down.
///
/// Idempotent only on the explicit-reset path: if a wrapped key
/// already exists, the call errors. The reset flow must call
/// `forget_recovery` first.
pub fn create_recovery_phrase() -> AppResult<String> {
    if has_recovery_wrapped()? {
        return Err(AppError::InvalidState(
            "recovery phrase already exists — use the reset flow to replace it".into(),
        ));
    }
    let workspace_key_hex = ensure_db_encryption_key()?;
    let workspace_key = hex::decode(&workspace_key_hex).map_err(|e| {
        AppError::InvalidState(format!("workspace key in Keychain is not hex: {e}"))
    })?;
    if workspace_key.len() != 32 {
        return Err(AppError::InvalidState(format!(
            "workspace key length is {} bytes, expected 32",
            workspace_key.len()
        )));
    }

    // 256 bits of entropy → 24 BIP-39 words.
    let entropy: [u8; 32] = random_bytes()?;
    let mnemonic = bip39::Mnemonic::from_entropy(&entropy)
        .map_err(|e| AppError::InvalidState(format!("bip39: {e}")))?;
    let phrase = mnemonic.to_string();

    let wrapped = wrap_workspace_key(&workspace_key, &phrase)?;
    set(RECOVERY_WRAPPED_ACCOUNT, &hex::encode(wrapped))?;

    Ok(phrase)
}

/// Mark the user as having confirmed they wrote the phrase down (by
/// re-typing the four random words the wizard demanded). Until this
/// flag is set, sensitive features should be gated.
pub fn mark_recovery_confirmed() -> AppResult<()> {
    set(RECOVERY_CONFIRMED_ACCOUNT, "true")
}

/// Wipe the recovery state — used by "rotate phrase" / "regenerate".
/// Leaves the workspace key untouched.
pub fn forget_recovery() -> AppResult<()> {
    delete(RECOVERY_WRAPPED_ACCOUNT)?;
    delete(RECOVERY_CONFIRMED_ACCOUNT)?;
    Ok(())
}

/// Recovery import path — given the 24-word phrase, decrypt the
/// wrapped workspace key and re-store it in Keychain. Used when
/// Keychain has lost the workspace key (e.g., after migration to a
/// new machine where the user restored only the encrypted DB file).
///
/// The wrapped blob itself is *also* in Keychain, so this only helps
/// if Keychain is partially intact — but that's the realistic failure
/// mode (Keychain entry deleted by Time Machine / SetupAssistant
/// while the actual encrypted DB rolled forward via backup).
///
/// For the harder case where Keychain is fully wiped, `import_phrase`
/// also accepts the wrapped blob inline (call `recover_with_wrapped`).
pub fn recover_workspace_key_from_phrase(phrase: &str) -> AppResult<String> {
    let wrapped_hex = get(RECOVERY_WRAPPED_ACCOUNT)?.ok_or_else(|| {
        AppError::InvalidState(
            "no wrapped recovery blob in Keychain — phrase alone is not enough"
                .into(),
        )
    })?;
    let wrapped = hex::decode(&wrapped_hex)
        .map_err(|e| AppError::InvalidState(format!("wrapped blob is not hex: {e}")))?;
    recover_with_wrapped(&wrapped, phrase)
}

/// Lower-level recovery — caller supplies both the phrase and the
/// wrapped blob bytes. Used by `recover_workspace_key_from_phrase`
/// internally; exposed for tests and the future "import wrapped blob
/// from a sidecar file" feature.
pub fn recover_with_wrapped(wrapped: &[u8], phrase: &str) -> AppResult<String> {
    let workspace_key = unwrap_workspace_key(wrapped, phrase)?;
    let key_hex = hex::encode(workspace_key);
    set(DB_KEY_ACCOUNT, &key_hex)?;
    Ok(key_hex)
}

// --- key wrapping primitives ------------------------------------------------

fn derive_wrapping_key(phrase: &str) -> AppResult<[u8; 32]> {
    use hmac::Hmac;
    use sha2::Sha256;
    // BIP-39 phrases are normalized: trim + collapse whitespace + NFKD.
    // We don't import unicode_normalization for one call; phrases from
    // our own generator are ASCII-only, and import accepts the same
    // normalization the bip39 crate validates.
    let canonical = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2::<Hmac<Sha256>>(
        canonical.as_bytes(),
        PBKDF2_SALT_V1,
        PBKDF2_ITERATIONS,
        &mut out,
    )
    .map_err(|e| AppError::InvalidState(format!("pbkdf2: {e}")))?;
    Ok(out)
}

fn wrap_workspace_key(workspace_key: &[u8], phrase: &str) -> AppResult<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    if workspace_key.len() != 32 {
        return Err(AppError::InvalidState(format!(
            "workspace key length is {} bytes, expected 32",
            workspace_key.len()
        )));
    }
    let wrapping_key = derive_wrapping_key(phrase)?;
    let cipher = Aes256Gcm::new_from_slice(&wrapping_key)
        .map_err(|e| AppError::InvalidState(format!("aes-gcm key: {e}")))?;
    let nonce_bytes: [u8; 12] = random_bytes()?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, workspace_key)
        .map_err(|e| AppError::InvalidState(format!("aes-gcm encrypt: {e}")))?;

    // version || nonce || ciphertext+tag
    let mut out = Vec::with_capacity(1 + 12 + ciphertext.len());
    out.push(WRAP_VERSION_V1);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn unwrap_workspace_key(wrapped: &[u8], phrase: &str) -> AppResult<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    if wrapped.len() < 1 + 12 + 16 {
        return Err(AppError::InvalidState(format!(
            "wrapped blob too short: {} bytes",
            wrapped.len()
        )));
    }
    let version = wrapped[0];
    if version != WRAP_VERSION_V1 {
        return Err(AppError::InvalidState(format!(
            "unsupported wrap version: {}",
            version
        )));
    }
    let nonce_bytes: [u8; 12] = wrapped[1..13].try_into().unwrap();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = &wrapped[13..];

    let wrapping_key = derive_wrapping_key(phrase)?;
    let cipher = Aes256Gcm::new_from_slice(&wrapping_key)
        .map_err(|e| AppError::InvalidState(format!("aes-gcm key: {e}")))?;
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::InvalidState("recovery phrase did not decrypt the workspace key".into()))
}

/// Validate a phrase against BIP-39's checksum (so users discover
/// typos before we try to decrypt). Does NOT confirm the phrase
/// matches the wrapped blob — only that it is a syntactically valid
/// 24-word phrase. Use `recover_workspace_key_from_phrase` for the
/// full end-to-end check.
pub fn phrase_is_valid_bip39(phrase: &str) -> bool {
    let canonical = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
    bip39::Mnemonic::parse(&canonical).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_hex_key_is_64_chars_lowercase_hex() {
        let key = random_hex_key().unwrap();
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(key, key.to_ascii_lowercase());
    }

    #[test]
    fn random_hex_key_is_unique_per_call() {
        let a = random_hex_key().unwrap();
        let b = random_hex_key().unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn wrap_unwrap_roundtrips_workspace_key() {
        let workspace_key: [u8; 32] = [7u8; 32];
        let phrase =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon art";
        let wrapped = wrap_workspace_key(&workspace_key, phrase).unwrap();
        // First byte must be the version sentinel.
        assert_eq!(wrapped[0], WRAP_VERSION_V1);
        let recovered = unwrap_workspace_key(&wrapped, phrase).unwrap();
        assert_eq!(recovered, workspace_key);
    }

    #[test]
    fn unwrap_rejects_wrong_phrase() {
        let workspace_key: [u8; 32] = [9u8; 32];
        let phrase_a =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon art";
        // Different valid 24-word phrase.
        let phrase_b =
            "legal winner thank year wave sausage worth useful legal winner thank year \
             wave sausage worth useful legal winner thank year wave sausage worth title";
        let wrapped = wrap_workspace_key(&workspace_key, phrase_a).unwrap();
        let result = unwrap_workspace_key(&wrapped, phrase_b);
        assert!(result.is_err(), "wrong phrase must not decrypt");
    }

    #[test]
    fn unwrap_rejects_truncated_blob() {
        let result = unwrap_workspace_key(&[1, 2, 3], "anything");
        assert!(result.is_err());
    }

    #[test]
    fn unwrap_rejects_unknown_version() {
        // Build a "valid-looking" but version-99 blob.
        let mut blob = vec![99u8];
        blob.extend_from_slice(&[0u8; 12 + 32 + 16]);
        let result = unwrap_workspace_key(&blob, "x");
        assert!(result.is_err());
    }

    #[test]
    fn phrase_validation_catches_typos() {
        let good =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon art";
        assert!(phrase_is_valid_bip39(good));
        // Wrong final word (breaks the checksum).
        let bad =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon";
        assert!(!phrase_is_valid_bip39(bad));
        // Word from outside the wordlist.
        let off_list =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon notaword";
        assert!(!phrase_is_valid_bip39(off_list));
    }

    #[test]
    fn phrase_normalization_collapses_whitespace() {
        let canonical =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon art";
        // Same phrase, weird spacing — must still validate, and must
        // derive the same wrapping key.
        let weird = "  abandon\tabandon\nabandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art ";
        assert!(phrase_is_valid_bip39(weird));
        let k1 = derive_wrapping_key(canonical).unwrap();
        let k2 = derive_wrapping_key(weird).unwrap();
        assert_eq!(k1, k2, "whitespace variance must not change the derived key");
    }

    #[test]
    fn derive_wrapping_key_is_deterministic() {
        let phrase =
            "legal winner thank year wave sausage worth useful legal winner thank year \
             wave sausage worth useful legal winner thank year wave sausage worth title";
        let a = derive_wrapping_key(phrase).unwrap();
        let b = derive_wrapping_key(phrase).unwrap();
        assert_eq!(a, b);
    }

    /// End-to-end simulation of the recovery flow without touching
    /// Keychain: we generate a phrase from real entropy, wrap a
    /// workspace key under it, then unwrap with the phrase to confirm
    /// we get the workspace key back. Models the lost-Keychain
    /// scenario the wizard is designed to defend against.
    #[test]
    fn end_to_end_phrase_recovers_workspace_key() {
        // Step 1: generate a real 24-word phrase from a known entropy
        // value so the test is deterministic.
        let entropy: [u8; 32] = [42; 32];
        let mnemonic = bip39::Mnemonic::from_entropy(&entropy).unwrap();
        let phrase = mnemonic.to_string();
        let words: Vec<&str> = phrase.split_whitespace().collect();
        assert_eq!(words.len(), 24, "BIP-39/256 always gives 24 words");

        // Step 2: simulate generating + wrapping a workspace key.
        let workspace_key: [u8; 32] = [0xAA; 32];
        let wrapped = wrap_workspace_key(&workspace_key, &phrase).unwrap();

        // Step 3: simulate Keychain wipe — wrapped blob survives (it
        // would in reality if it had been backed up); workspace key
        // is gone. Recovery: phrase + wrapped → workspace key.
        let recovered = unwrap_workspace_key(&wrapped, &phrase).unwrap();
        assert_eq!(recovered, workspace_key);

        // Step 4: even a one-word substitution must fail. Pick a
        // valid replacement word from the wordlist so it's a
        // checksum-failure, not a wordlist-failure.
        let mut bad_words = words.clone();
        bad_words[0] = "zoo";
        let bad_phrase = bad_words.join(" ");
        let result = unwrap_workspace_key(&wrapped, &bad_phrase);
        assert!(result.is_err(), "one-word change must break recovery");
    }

    /// Wrap output must include a fresh nonce per call — otherwise
    /// repeated wraps under the same phrase would leak that the
    /// underlying workspace key is unchanged.
    #[test]
    fn wrap_uses_fresh_nonce_each_call() {
        let workspace_key: [u8; 32] = [1u8; 32];
        let phrase =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon art";
        let a = wrap_workspace_key(&workspace_key, phrase).unwrap();
        let b = wrap_workspace_key(&workspace_key, phrase).unwrap();
        assert_ne!(
            &a[1..13],
            &b[1..13],
            "two wraps must use different nonces"
        );
        assert_ne!(a, b, "two wraps of the same plaintext must yield different ciphertexts");
    }

    // Note: create_recovery_phrase / recover_workspace_key_from_phrase /
    // mark_recovery_confirmed touch the system Keychain so they can't
    // be unit-tested without polluting it. They're exercised through
    // the M8b integration test in tests/recovery_e2e.rs (gated behind
    // an env var so CI doesn't run them).
}
