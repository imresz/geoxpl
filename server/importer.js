import { createHash } from 'node:crypto';
import { publicJson } from './network.js';
import { normalize } from './store.js';

export async function importSource(source, query, load = publicJson) {
  if (source.status !== 'approved') throw new Error('Source is not approved.');
  const terms = [query];
  let records = [], metadata = {}, truncated = false;
  if (source.format === 'arcgis') {
    const base = source.url.replace(/\/$/, '');
    if (!/\/FeatureServer\/\d+$/i.test(base) && !/\/MapServer\/\d+$/i.test(base)) throw new Error('Choose a specific ArcGIS layer URL ending in its numeric layer ID.');
    metadata = await load(`${base}?f=json`);
    if (metadata.error) throw new Error(metadata.error.message);
    if (!metadata.fields?.some(f => f.name === source.nameField)) throw new Error(`Name field ${source.nameField} was not found in the source schema.`);
    const literals = terms.map(t => `'${t.toUpperCase().replaceAll("'", "''")}'`).join(',');
    const params = new URLSearchParams({ f: 'json', where: `UPPER(${source.nameField}) IN (${literals})`, returnIdsOnly: 'true' });
    const idsResult = await load(`${base}/query?${params}`);
    if (idsResult.error) throw new Error(idsResult.error.message);
    const ids = idsResult.objectIds || [];
    if (ids.length > 25000) throw new Error('This feature exceeds the 25,000-record local import limit.');
    for (let i = 0; i < ids.length; i += 500) {
      const p = new URLSearchParams({ f: 'geojson', objectIds: ids.slice(i, i + 500).join(','), outFields: '*', outSR: '4326', returnGeometry: 'true' });
      const page = await load(`${base}/query?${p}`);
      if (page.error) throw new Error(page.error.message);
      if (!Array.isArray(page.features)) throw new Error('This layer did not return GeoJSON.');
      truncated ||= !!page.exceededTransferLimit;
      records.push(...page.features);
    }
    truncated ||= records.length !== ids.length;
  } else {
    const collection = await load(source.url);
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error('Expected a GeoJSON FeatureCollection in WGS84 longitude/latitude.');
    if (collection.crs && !JSON.stringify(collection.crs).match(/4326|CRS84/)) throw new Error('GeoJSON must use WGS84 longitude/latitude.');
    const normalized = terms.map(normalize);
    records = collection.features.filter(f => normalized.includes(normalize(String(f.properties?.[source.nameField] ?? ''))));
    metadata = { type: collection.type };
  }
  if (records.length > 25000) throw new Error('Too many records for one feature.');
  const payload = { type: 'FeatureCollection', features: records };
  return { payload, metadata, truncated, checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
