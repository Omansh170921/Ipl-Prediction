/**
 * Generates public/firebase-messaging-sw.js from template, injecting Firebase config from .env.
 * Service workers cannot use import.meta.env, so we inject at build time.
 * Run before dev/build (via predev/prebuild scripts).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

function loadEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key.startsWith('VITE_FIREBASE_')) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

loadEnv();

const vars = {
  __VITE_FIREBASE_API_KEY__: process.env.VITE_FIREBASE_API_KEY || '',
  __VITE_FIREBASE_AUTH_DOMAIN__: process.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  __VITE_FIREBASE_PROJECT_ID__: process.env.VITE_FIREBASE_PROJECT_ID || '',
  __VITE_FIREBASE_STORAGE_BUCKET__: process.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  __VITE_FIREBASE_MESSAGING_SENDER_ID__: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  __VITE_FIREBASE_APP_ID__: process.env.VITE_FIREBASE_APP_ID || '',
};

const templatePath = path.join(rootDir, 'public', 'firebase-messaging-sw.template.js');
const outputPath = path.join(rootDir, 'public', 'firebase-messaging-sw.js');

let template = fs.readFileSync(templatePath, 'utf8');
for (const [placeholder, value] of Object.entries(vars)) {
  template = template.split(placeholder).join(value);
}

fs.writeFileSync(outputPath, template, 'utf8');
console.log('Generated firebase-messaging-sw.js with config from .env');
