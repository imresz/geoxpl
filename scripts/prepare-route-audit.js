import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// Pass the output of Import-Csv | ConvertTo-Json from the coverage audit on stdin.
const rows = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
const bytes = readFileSync(process.argv[2]);
const dtp = JSON.parse(bytes);
const codes = Object.fromEntries(rows.filter(r => /^[MABC][0-9]+$/.test(r.Code) ||
  (r.Scheme === 'Numeric' && /^[1-9][0-9]?$/.test(r.Code))).map(r => [
  r.Code, { vicmap: Number(r.VicmapRecords), dtp: Number(r.DtpRecords) }
]));
const fallback = Object.fromEntries(Object.entries(codes).filter(([, row]) => !row.vicmap).map(([code]) => [code, []]));
for (const f of dtp.features) {
  const code = f.properties.SRNS?.trim().toUpperCase();
  if (Object.hasOwn(fallback, code)) fallback[code].push(f);
}
for (const [code, records] of Object.entries(fallback)) {
  if (records.length !== codes[code].dtp) throw Error(`DTP audit count mismatch for ${code}`);
}
const dir = new URL('../server/data/', import.meta.url);
writeFileSync(new URL('victorian-route-coverage.json', dir), JSON.stringify({
  audited: '2026-11-16', dtpEdition: '2026-03-10', dtpSha256: createHash('sha256').update(bytes).digest('hex'), codes
}, null, 2) + '\n');
writeFileSync(new URL('victorian-dtp-only-routes.json.gz', dir), gzipSync(JSON.stringify(fallback)));
