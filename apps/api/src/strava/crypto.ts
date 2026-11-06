import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config';

/** Tokens do Strava ficam criptografados no servidor (AES-256-GCM), nunca no app. */
function key(): Buffer {
  const k = Buffer.from(config.tokenEncKey, 'base64');
  if (k.length !== 32) throw new Error('TOKEN_ENC_KEY deve ter 32 bytes em base64 (openssl rand -base64 32).');
  return k;
}

export function encryptToken(plain: string, k: Buffer = key()): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decryptToken(blob: string, k: Buffer = key()): string {
  const [iv, tag, enc] = blob.split('.').map((x) => Buffer.from(x, 'base64')) as [Buffer, Buffer, Buffer];
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
