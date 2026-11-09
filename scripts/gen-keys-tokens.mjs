import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const directory = new URL('../keys/', import.meta.url);
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const expires = new Date();
expires.setUTCFullYear(expires.getUTCFullYear() + 10);
const exp = Math.floor(expires.getTime() / 1000);
const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const tokens = {};
for (const [sub, role] of [
  ['passageiro-1', 'passageiro'],
  ['passageiro-2', 'passageiro'],
  ['motorista-1', 'motorista'],
]) {
  const payload = Buffer.from(JSON.stringify({ sub, role, exp })).toString('base64url');
  const message = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(message), privateKey);
  if (!verify('RSA-SHA256', Buffer.from(message), publicKey, signature)) {
    throw new Error(`Assinatura inválida: ${sub}`);
  }
  tokens[sub] = `${message}.${signature.toString('base64url')}`;
}
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('private.pem', directory), privateKey, { mode: 0o600 });
writeFileSync(new URL('public.pem', directory), publicKey);
writeFileSync(new URL('tokens.json', directory), `${JSON.stringify(tokens, null, 2)}\n`);
writeFileSync(new URL('README.md', directory), '# TEST ONLY: chaves e tokens de teste, nunca usar em produção\n\nGerados por `node scripts/gen-keys-tokens.mjs`. Rodar novamente substitui as chaves e invalida os tokens anteriores.\n');
console.log('Gerados: keys/private.pem, keys/public.pem, keys/tokens.json e keys/README.md; 3 assinaturas verificadas.');
