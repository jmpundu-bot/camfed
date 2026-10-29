const crypto = require('crypto');

function config() {
  const endpoint = (process.env.AWS_ENDPOINT_URL_S3 || process.env.NEON_STORAGE_ENDPOINT || '').replace(/\/$/, '');
  const bucket = process.env.NEON_STORAGE_BUCKET || process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME || process.env.S3_BUCKET_NAME || process.env.AWS_BUCKET || process.env.NEON_BUCKET_NAME;
  const accessKey = process.env.AWS_ACCESS_KEY_ID || process.env.NEON_STORAGE_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.NEON_STORAGE_SECRET_ACCESS_KEY;
  const missing = [];
  if (!endpoint) missing.push('AWS_ENDPOINT_URL_S3');
  if (!bucket) missing.push('NEON_STORAGE_BUCKET (or AWS_S3_BUCKET)');
  if (!accessKey) missing.push('AWS_ACCESS_KEY_ID');
  if (!secretKey) missing.push('AWS_SECRET_ACCESS_KEY');
  if (missing.length) {
    throw new Error(`Neon Object Storage is not configured. Missing environment variable(s): ${missing.join(', ')}.`);
  }
  const region = endpoint.match(/\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech/i)?.[1] || process.env.AWS_REGION || 'us-east-2';
  return { endpoint, bucket, accessKey, secretKey, region };
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function signedHeaders(method, key, body = Buffer.alloc(0), contentType) {
  const c = config();
  const url = new URL(`${c.endpoint}/${encodeURIComponent(c.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': now };
  if (contentType) headers['content-type'] = contentType;
  const signed = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(name => `${name}:${headers[name].trim()}\n`).join('');
  const canonical = [method, url.pathname, '', canonicalHeaders, signed, payloadHash].join('\n');
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const dateKey = hmac(`AWS4${c.secretKey}`, date);
  const regionKey = crypto.createHmac('sha256', dateKey).update(c.region).digest();
  const serviceKey = crypto.createHmac('sha256', regionKey).update('s3').digest();
  const signingKey = crypto.createHmac('sha256', serviceKey).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return { url, headers };
}

async function request(method, key, body, contentType) {
  const { url, headers } = signedHeaders(method, key, body, contentType);
  const response = await fetch(url, { method, headers, body: method === 'PUT' ? body : undefined });
  if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Neon Object Storage ${method} failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response;
}

async function put(key, body, contentType) {
  await request('PUT', key, body, contentType);
  return key;
}

async function get(key) {
  const response = await request('GET', key, Buffer.alloc(0));
  return Buffer.from(await response.arrayBuffer());
}

async function remove(key) {
  if (key) await request('DELETE', key, Buffer.alloc(0));
}

async function check() {
  const { bucket } = config();
  await request('HEAD', '');
  return bucket;
}

module.exports = { put, get, remove, check };
