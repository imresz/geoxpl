import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';

export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export async function publicBytes(input, maxBytes = 20_000_000, accept = 'application/octet-stream') {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Sources must use public HTTPS URLs.');
  const hosts = await lookup(url.hostname, { all: true });
  if (!hosts.length || hosts.some(h => !publicAddress(h.address))) throw new Error('Private network source addresses are not permitted.');
  const chosen = hosts[0];
  const agent = new Agent({ connect: { lookup: (_hostname, options, callback) => options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family) } });
  try {
    const response = await fetch(url, { dispatcher: agent, redirect: 'error', signal: AbortSignal.timeout(45000), headers: { 'User-Agent': 'GeoXpl/0.1 (local geographic research)', Accept: accept } });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maxBytes) throw new Error('Source exceeds the local import size limit.'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  } finally { await agent.close(); }
}
export async function publicJson(input, maxBytes = 20_000_000) {
  return JSON.parse((await publicBytes(input, maxBytes, 'application/json')).toString('utf8'));
}
