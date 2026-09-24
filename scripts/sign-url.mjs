#!/usr/bin/env node
/**
 * Genera una CloudFront Signed URL (Boss Fight — Reto 1).
 *
 * Uso:  node scripts/sign-url.mjs <url-privada> [minutos]
 * Ej.:  node scripts/sign-url.mjs https://xxx.cloudfront.net/privados/doc.pdf 10
 *
 * ¿Qué hace? Crea los 3 parámetros que CloudFront exige para archivos privados:
 *   1. Policy     = JSON {recurso, fecha de expiración} en base64 URL-safe
 *   2. Signature  = firma RSA-SHA1 del JSON de la policy en texto plano, con TU llave
 *                   PRIVADA (CloudFront la verifica con la llave PÚBLICA del stack)
 *   3. Key-Pair-Id= id de esa llave pública en CloudFront
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ID de la llave pública registrada en CloudFront (se obtiene con: aws cloudfront list-public-keys)
const KEY_PAIR_ID = 'K1GUYZR5X6N320';

// Base64 con los 3 caracteres que CloudFront prohíbe en parámetros de URL:
// '+' -> '-', '/' -> '~', '=' -> '_' (por carácter, incluidos los de relleno)
const urlSafe = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '~').replace(/=/g, '_');

const [url, minutesArg = '10'] = process.argv.slice(2);
if (!url) {
  console.error('Uso: node scripts/sign-url.mjs <url-privada> [minutos]');
  process.exit(1);
}
const minutes = Number(minutesArg);
const expiresEpoch = Math.floor(Date.now() / 1000) + minutes * 60;

// 1) Política "canned": este recurso vale hasta esta fecha (epoch en segundos)
const policy = JSON.stringify({
  Statement: [{ Resource: url, Condition: { DateLessThan: { 'AWS:EpochTime': expiresEpoch } } }],
});
const policyB64 = urlSafe(Buffer.from(policy, 'utf8'));

// 2-3) Firma RSA-SHA1 del JSON de la POLÍTICA en texto plano (CloudFront verifica
//      este mismo texto con la llave pública; el base64 es solo para transportarla)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = readFileSync(path.join(__dirname, '..', 'cdk', 'keys', 'cloudfront-private.pem'), 'utf8');
const signature = urlSafe(createSign('RSA-SHA1').update(policy, 'utf8').sign(privateKey));

// 4) URL final firmada
const signedUrl = `${url}?Policy=${policyB64}&Signature=${signature}&Key-Pair-Id=${KEY_PAIR_ID}`;

console.log(`Vencimiento: ${new Date(expiresEpoch * 1000).toISOString()} (${minutes} min)`);
console.log(signedUrl);
