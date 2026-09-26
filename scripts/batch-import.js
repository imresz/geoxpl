import { readFileSync } from 'node:fs';
import { createStore } from '../server/store.js';
import { enqueueBatch, listBatches, batchStatus } from '../server/batches.js';

const [command, value, ...extra] = process.argv.slice(2);
if (!['enqueue', 'status'].includes(command) || (command === 'enqueue' && !value) || extra.length) {
  console.error('Usage: npm run batch -- enqueue <manifest.json> | status [batch-id]');
  process.exitCode = 1;
} else {
  const store = createStore(process.env.GEOXPL_DB || 'runtime/geoxpl.sqlite');
  try {
    const result = command === 'enqueue' ? enqueueBatch(store, JSON.parse(readFileSync(value, 'utf8')))
      : value ? batchStatus(store, value) : listBatches(store);
    if (!result) throw Error('Batch not found.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { store.close(); }
}
