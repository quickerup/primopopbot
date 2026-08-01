// ---------------------------------------------------------------------------
// Encrypted-at-rest secrets storage using native Web Crypto (SubtleCrypto).
// Replaces the Python original's Fernet symmetric encryption. Same goal —
// child-bot API keys/tokens are never stored in KV as plaintext — achieved
// with AES-256-GCM, keyed by a passphrase-derived key (PBKDF2 -> AES-GCM).
//
// Ciphertext blob layout stored in KV under `secrets:<botId>`:
//   base64(salt[16] || iv[12] || ciphertext)
// A fresh random salt and IV are generated on every encrypt call.
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 100_000;
const SALT_LEN = 16;
const IV_LEN = 12;

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encrypt a UTF-8 string (typically a JSON-stringified secrets map). */
export async function encryptSecrets(plaintext: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length);
  return toB64(combined);
}

/** Decrypt a blob produced by encryptSecrets. Throws if passphrase/blob mismatch. */
export async function decryptSecrets(blob: string, passphrase: string): Promise<string> {
  const combined = fromB64(blob);
  const salt = combined.slice(0, SALT_LEN);
  const iv = combined.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = combined.slice(SALT_LEN + IV_LEN);
  const key = await deriveKey(passphrase, salt);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

export type SecretsMap = Record<string, string>;

export async function loadSecrets(
  kv: KVNamespace,
  botId: string,
  passphrase: string
): Promise<SecretsMap> {
  const blob = await kv.get(`secrets:${botId}`);
  if (!blob) return {};
  try {
    const json = await decryptSecrets(blob, passphrase);
    return JSON.parse(json) as SecretsMap;
  } catch {
    // Corrupt blob or wrong passphrase — fail safe to "no secrets" rather
    // than throwing and taking the whole action sequence down.
    return {};
  }
}

export async function saveSecrets(
  kv: KVNamespace,
  botId: string,
  passphrase: string,
  secrets: SecretsMap
): Promise<void> {
  const blob = await encryptSecrets(JSON.stringify(secrets), passphrase);
  await kv.put(`secrets:${botId}`, blob);
}
