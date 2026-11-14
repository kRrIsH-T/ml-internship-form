import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import handler, { versionForArrival, cycleOrder } from '../api/index.js';

const IDS = ['L1', 'L2', 'L3', 'L4', 'S1', 'S2', 'S3', 'S4'];
const URLS = Object.fromEntries(IDS.map((id) => [id, `https://forms.example/${id}`]));
const ENV = {
  FORM_URLS: JSON.stringify(URLS),
  SHUFFLE_SECRET: 'test-secret',
  KV_REST_API_URL: 'https://redis.example',
  KV_REST_API_TOKEN: 'token'
};

let counter;
let redisCalls;
beforeEach(() => {
  counter = 0;
  redisCalls = 0;
  globalThis.fetch = async (url, options) => {
    redisCalls++;
    assert.equal(url, 'https://redis.example/incr/rms%3Aarrivals');
    assert.equal(options.headers.Authorization, 'Bearer token');
    counter++;
    return { ok: true, json: async () => ({ result: counter }) };
  };
});

function fakeRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: '',
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(body = '') { this.body = body; }
  };
}

async function visit(env = ENV, reqHeaders = {}, forms = {}) {
  const res = fakeRes();
  await handler({ headers: { 'user-agent': 'Mozilla/5.0', ...reqHeaders } }, res, env, forms);
  return res;
}

const versionOf = (res) => res.headers.location.split('/').pop();

test('every run of 8 arrivals covers each version exactly once', () => {
  for (let cycle = 0; cycle < 20; cycle++) {
    const run = [];
    for (let k = 1; k <= 8; k++) run.push(versionForArrival(IDS, 'secret', cycle * 8 + k));
    assert.deepEqual(run.slice().sort(), IDS);
  }
});

test('order differs between cycles and depends on the secret', () => {
  assert.notDeepEqual(cycleOrder(IDS, 'secret', 0), cycleOrder(IDS, 'secret', 1));
  assert.notDeepEqual(cycleOrder(IDS, 'secret', 0), cycleOrder(IDS, 'other', 0));
});

test('80 participants split into 8 groups of exactly 10', async () => {
  const counts = {};
  for (let i = 0; i < 80; i++) {
    const res = await visit();
    assert.equal(res.statusCode, 302);
    counts[versionOf(res)] = (counts[versionOf(res)] || 0) + 1;
  }
  assert.deepEqual(Object.keys(counts).sort(), IDS);
  for (const id of IDS) assert.equal(counts[id], 10);
});

test('a returning browser keeps its version and does not use a slot', async () => {
  const first = await visit();
  const cookie = first.headers['set-cookie'].split(';')[0];
  assert.match(first.headers['set-cookie'], /HttpOnly; Secure; SameSite=Lax/);
  const again = await visit(ENV, { cookie });
  assert.equal(versionOf(again), versionOf(first));
  assert.equal(redisCalls, 1);
});

test('a stale cookie for an unknown version gets a fresh assignment', async () => {
  const res = await visit(ENV, { cookie: 'rms_version=OLD9' });
  assert.ok(IDS.includes(versionOf(res)));
  assert.equal(redisCalls, 1);
});

test('link-preview bots get no redirect and do not use a slot', async () => {
  for (const ua of ['WhatsApp/2.23', 'facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'TelegramBot (like TwitterBot)']) {
    const res = await visit(ENV, { 'user-agent': ua });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.location, undefined);
  }
  assert.equal(redisCalls, 0);
});

test('falls back to a random version when Redis fails', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  const res = await visit();
  assert.equal(res.statusCode, 302);
  assert.ok(IDS.includes(versionOf(res)));
});

test('falls back to a random version when Redis is not configured', async () => {
  const res = await visit({ FORM_URLS: ENV.FORM_URLS });
  assert.equal(res.statusCode, 302);
  assert.ok(IDS.includes(versionOf(res)));
  assert.equal(redisCalls, 0);
});

test('uses forms.js links when FORM_URLS is not set', async () => {
  const env = { ...ENV };
  delete env.FORM_URLS;
  const res = await visit(env, {}, URLS);
  assert.equal(res.statusCode, 302);
  assert.ok(IDS.includes(versionOf(res)));
});

test('FORM_URLS overrides forms.js', async () => {
  const res = await visit({ FORM_URLS: JSON.stringify({ X1: 'https://forms.example/X1' }) }, {}, URLS);
  assert.equal(versionOf(res), 'X1');
});

test('missing or broken FORM_URLS returns a clear error', async () => {
  assert.equal((await visit({})).statusCode, 500);
  const broken = await visit({ FORM_URLS: '{not json' });
  assert.equal(broken.statusCode, 500);
  assert.match(broken.body, /not valid JSON/);
});
