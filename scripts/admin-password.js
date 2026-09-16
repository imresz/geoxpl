import { createStore } from '../server/store.js';
import { randomBytes, scryptSync } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
async function readPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal, or supply ADMIN_PASSWORD for this command.');
  process.stdout.write('Administrator password (at least 12 characters): ');
  emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise(resolve => {
    let value = '';
    process.stdin.on('keypress', (text, key) => {
      if (key.ctrl && key.name === 'c') process.exit(1);
      if (key.name === 'return') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); resolve(value); }
      else if (key.name === 'backspace') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } }
      else if (text && !key.ctrl && !key.meta) { value += text; process.stdout.write('*'); }
    });
  });
const password = await readPassword();
if (password.length < 12 || password.length > 200) throw new Error('Password must be 12 to 200 characters.');
const store = createStore(process.env.GEOXPL_DB || 'runtime/geoxpl.sqlite');
const salt = randomBytes(16).toString('hex');
store.setting('password', `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
store.db.prepare('DELETE FROM sessions').run();
store.event(null, 'password_updated', 'Administrator password set using local command');
store.close(); console.log('Administrator password saved. Existing sessions revoked.');
