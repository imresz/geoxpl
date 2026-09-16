import test from 'node:test';
import assert from 'node:assert/strict';
import { research, sourceSchema } from '../server/research.js';
import { createStore } from '../server/store.js';

const job = { query: 'Synthetic River', type: 'river' };
const candidate = {
  name: 'Synthetic hydrography', type: 'river', format: 'geojson', url: 'https://example.org/river.json',
  nameField: 'name', idField: 'id', licence: '', attribution: '', version: '',
  completeness: 'unknown', aliases: [], notes: 'Test fixture only'
};
const report = {
  summary: 'Review this synthetic source.', nextSteps: ['Verify the licence.'],
  evidence: [{ title: 'Synthetic catalogue', url: 'https://example.org/catalogue' }], candidates: [candidate]
};
const completed = value => Response.json({
  id: 'response-test', status: 'completed',
  output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }]
});

function setup(t, fetcher) {
  const names = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'AI_REQUESTS_PER_HOUR'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.OPENAI_API_KEY = 'test-secret-not-a-real-key';
  process.env.OPENAI_MODEL = 'configured-test-model';
  process.env.AI_REQUESTS_PER_HOUR = '3';
  const store = createStore(':memory:');
  const mock = t.mock.method(globalThis, 'fetch', fetcher);
  t.after(() => {
    mock.mock.restore();
    store.close();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  return store;
}

test('research sends an OpenAI-compatible strict schema and retains HTTPS constraints', async t => {
  const store = setup(t, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'configured-test-model');
    assert.equal(body.store, false);
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.equal(body.text.format.strict, true);
    const schema = body.text.format.schema;
    for (const urlSchema of [schema.properties.evidence.items.properties.url, schema.properties.candidates.items.properties.url]) {
      assert.equal(urlSchema.format, undefined);
      assert.equal(new RegExp(urlSchema.pattern).test('https://example.org/data'), true);
      assert.equal(new RegExp(urlSchema.pattern).test('http://example.org/data'), false);
    }
    const check = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') {
        assert.equal(node.additionalProperties, false);
        assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      }
      assert.notEqual(node.format, 'starts_with');
      for (const value of Object.values(node)) check(value);
    };
    check(schema);
    return completed(report);
  });
  const result = await research(job, store, 'No approved sources');
  assert.equal(result.provider, 'OpenAI web research');
  assert.equal(result.responseId, 'response-test');
  assert.equal(result.model, 'configured-test-model');
  assert.deepEqual(result.candidates, [candidate]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ai_calls').get().n, 1);
});

test('runtime validation still rejects non-HTTPS and malformed source and evidence URLs', async t => {
  let value = report;
  const store = setup(t, async () => completed(value));
  for (const url of ['http://example.org/data', 'https://']) {
    assert.equal(sourceSchema.safeParse({ ...candidate, url }).success, false);
    value = { ...report, candidates: [{ ...candidate, url }] };
    await assert.rejects(research(job, store, 'Test'), /url/);
  }
  value = { ...report, evidence: [{ title: 'Invalid URL', url: 'http://example.org' }] };
  await assert.rejects(research(job, store, 'Test'), /url/);
});

test('API errors preserve the cause and redact credentials before reporting', async t => {
  const store = setup(t, async () => Response.json({ error: {
    message: `Invalid schema. Secret: ${process.env.OPENAI_API_KEY}; another: sk-synthetic-redaction-test`,
    code: 'invalid_json_schema', param: 'text.format.schema'
  } }, { status: 400 }));
  await assert.rejects(research(job, store, 'Test'), error => {
    assert.match(error.message, /HTTP 400/);
    assert.match(error.message, /Invalid schema/);
    assert.match(error.message, /invalid_json_schema/);
    assert.match(error.message, /text\.format\.schema/);
    assert.match(error.message, /\[REDACTED\]/);
    assert.ok(!error.message.includes(process.env.OPENAI_API_KEY));
    assert.ok(!error.message.includes('sk-synthetic'));
    return true;
  });
});

test('non-JSON API failures retain the HTTP status without echoing raw response bodies', async t => {
  const store = setup(t, async () => new Response('<html>Gateway failure</html>', { status: 502 }));
  await assert.rejects(research(job, store, 'Test'), /HTTP 502\. The provider did not return an error message\./);
});

test('incomplete AI responses cannot become research recommendations', async t => {
  const store = setup(t, async () => Response.json({ status: 'incomplete', output: [] }));
  await assert.rejects(research(job, store, 'Test'), /did not complete/);
});

test('hourly research limit prevents further API requests', async t => {
  const store = setup(t, async () => assert.fail('Rate-limited research must not call OpenAI'));
  for (let i = 0; i < 3; i++) store.db.prepare('INSERT INTO ai_calls(created) VALUES(?)').run(Date.now());
  const result = await research(job, store, 'Test');
  assert.equal(result.provider, 'rate limit');
});
