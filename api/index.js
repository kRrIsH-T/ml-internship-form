// Study link. Sends each new participant to one of the study's form versions.
//
// Balanced assignment: arrivals are counted in Redis (Upstash). Each run of N
// arrivals (N = number of versions) gets every version exactly once, in an
// order shuffled with a secret, so groups stay equal and the next assignment
// cannot be predicted. Without Redis it falls back to a plain random pick.
//
// Form links live in forms.js. Environment variables:
//   FORM_URLS       optional JSON object of version id -> form URL; overrides forms.js
//   SHUFFLE_SECRET  any long random string
//   KV_REST_API_URL / KV_REST_API_TOKEN  set automatically by the Upstash
//                   integration (UPSTASH_REDIS_REST_URL / _TOKEN also accepted)

import crypto from 'node:crypto';
import FORMS from '../forms.js';

const COOKIE = 'rms_version';
const COUNTER_KEY = 'rms:arrivals';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // a returning browser keeps its version for 30 days

// Link-preview crawlers open the URL when it is pasted into a chat or mail.
// They must not use up an assignment slot.
const PREVIEW_BOTS = /bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|skype|linkedin|outlook|googleimageproxy/i;

export function loadVersions(env = process.env, forms = FORMS) {
  let urls = forms;
  if (env.FORM_URLS) {
    try {
      urls = JSON.parse(env.FORM_URLS);
    } catch {
      throw new Error('FORM_URLS is not valid JSON');
    }
  }
  const ids = Object.keys(urls || {}).sort();
  if (ids.length === 0) throw new Error('no form links in forms.js or FORM_URLS');
  return { urls, ids };
}

/** Deterministic Fisher-Yates shuffle of ids, keyed by the secret and the cycle number. */
export function cycleOrder(ids, secret, cycle) {
  const order = ids.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const digest = crypto.createHmac('sha256', secret).update(`${cycle}:${i}`).digest();
    const j = digest.readUInt32BE(0) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Version for the n-th arrival (n starts at 1). */
export function versionForArrival(ids, secret, n) {
  const index = n - 1;
  const cycle = Math.floor(index / ids.length);
  return cycleOrder(ids, secret, cycle)[index % ids.length];
}

function redisConfig(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function nextArrival(redis) {
  const response = await fetch(`${redis.url}/incr/${encodeURIComponent(COUNTER_KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redis.token}` }
  });
  if (!response.ok) throw new Error(`Redis INCR failed with status ${response.status}`);
  const body = await response.json();
  const n = Number(body.result);
  if (!Number.isInteger(n) || n < 1) throw new Error('Redis INCR returned an unexpected value');
  return n;
}

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

export default async function handler(req, res, env = process.env, forms = FORMS) {
  let versions;
  try {
    versions = loadVersions(env, forms);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Study link is not configured: ${error.message}`);
    return;
  }
  const { urls, ids } = versions;

  // A preview bot gets a page with no redirect, so it does not touch the counter.
  if (PREVIEW_BOTS.test(req.headers['user-agent'] || '')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end('<!doctype html><meta charset="utf-8"><title>Recruitment Message Study</title>' +
      '<meta property="og:title" content="Recruitment Message Study">' +
      '<meta property="og:description" content="A short study on how students respond to recruitment e-mails.">' +
      '<p>Recruitment Message Study</p>');
    return;
  }

  // Someone who already has a version (refresh, back button) keeps it.
  const existing = readCookie(req.headers.cookie, COOKIE);
  if (existing && urls[existing]) {
    redirect(res, urls[existing]);
    return;
  }

  let version;
  const redis = redisConfig(env);
  const secret = env.SHUFFLE_SECRET;
  if (redis && secret) {
    try {
      version = versionForArrival(ids, secret, await nextArrival(redis));
    } catch (error) {
      console.error('Balanced assignment failed, using a random pick:', error.message);
    }
  } else {
    console.warn('Redis or SHUFFLE_SECRET not set: assignment is random, not balanced.');
  }
  if (!version) version = ids[crypto.randomInt(ids.length)];

  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(version)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  console.log(`assigned ${version}`);
  redirect(res, urls[version]);
}
