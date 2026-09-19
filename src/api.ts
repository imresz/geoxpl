export async function api<T = any>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
export type NetworkEndpoint = { coordinates: [number, number]; classification: string; nodeId: number; sourceUrl: string; receivingRiver?: string };
export type Feature = { source?: NetworkEndpoint | null; mouth?: NetworkEndpoint | null; mainStem?: { status: string; limitations?: string[] }; recordedNetwork?: { geometry: GeoJSON.Geometry; bbox: [number, number, number, number]; lengthKm: number; recordCount: number }; identity?: unknown; selection?: unknown; id: string; name: string; type: string; geometry: GeoJSON.Geometry; bbox: [number, number, number, number]; status: string; lengthKm: number | null; areaKm2: number | null; confidence: string; method: string; algorithmVersion: string; warnings: string[]; created: string; evidence: { sourceId: string; sourceName: string; sourceUrl: string; licence: string; attribution: string; objectId: string; importId: string; checksum: string; sourceVersion: string }[] };
export type Job = { id: string; query: string; type: string; status: string; phase: string; message: string; updated: string; feature: Feature | null };
export const statusLabel = (s: string) => ({ pending: 'Pending', resolved: 'Resolved', partially_resolved: 'Partially resolved', missing_capability: 'Needs capability', insufficient_data: 'Insufficient data', awaiting_review: 'Awaiting review', awaiting_data: 'Needs geographic evidence', queued: 'Queued', processing: 'Processing', failed: 'Failed', approved: 'Approved', rejected: 'Rejected' }[s] || s.replaceAll('_', ' '));
