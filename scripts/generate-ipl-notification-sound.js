/**
 * Writes a short chime WAV to public/sounds/ipl-notification.wav (replace with your own IPL clip if desired).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public', 'sounds');
const outFile = path.join(outDir, 'ipl-notification.wav');

const sampleRate = 11025;
const duration = 0.4;
const freqHz = 784;
const numSamples = Math.floor(sampleRate * duration);
const dataSize = numSamples * 2;
const buf = Buffer.alloc(44 + dataSize);

buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataSize, 40);

for (let i = 0; i < numSamples; i++) {
  const t = i / sampleRate;
  const attack = Math.min(1, i / (sampleRate * 0.04));
  const release = Math.min(1, (numSamples - i) / (sampleRate * 0.15));
  const envelope = attack * release;
  const sample =
    (Math.sin(2 * Math.PI * freqHz * t) * 0.22 + Math.sin(2 * Math.PI * freqHz * 1.5 * t) * 0.08) * envelope;
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, buf);
console.log('Wrote', outFile);
