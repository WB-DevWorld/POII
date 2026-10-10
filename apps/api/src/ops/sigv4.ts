// AWS Signature Version 4 for S3-compatible object storage, with node:crypto only (no SDK).
// Follows "Authenticating Requests: Using the Authorization Header (AWS Signature Version 4)" of the Amazon S3 API
// reference: canonical request → string to sign → HMAC chain over date, region, service, "aws4_request".
import { createHash, createHmac } from 'node:crypto';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}

export interface SigV4Request {
  method: string;
  /** Absolute URL; host (with a non-default port) and path come from here. */
  url: URL;
  /** Headers to send and sign, besides host, x-amz-date and x-amz-content-sha256 which are added. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body (EMPTY_SHA256 for none). */
  payloadSha256: string;
  date: Date;
}

export interface SignedRequest {
  /** Headers to send (host excluded: fetch derives it from the URL). */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as SigV4 wants it: everything except A-Z a-z 0-9 - _ . ~ is percent-encoded. */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(ch) || (ch === '/' && !encodeSlash)) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** 20130524T000000Z */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => pairs.push([uriEncode(key), uriEncode(value)]));
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** The URL's path is expected to be built with uriEncode already (S3 does not double-encode). */
function canonicalUri(url: URL): string {
  return url.pathname || '/';
}

export function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export function signV4(request: SigV4Request, credentials: SigV4Credentials): SignedRequest {
  const service = credentials.service ?? 's3';
  const xAmzDate = amzDate(request.date);
  const dateStamp = xAmzDate.slice(0, 8);
  const toSign: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) toSign[name.toLowerCase()] = value;
  toSign.host = request.url.host;
  toSign['x-amz-content-sha256'] = request.payloadSha256;
  toSign['x-amz-date'] = xAmzDate;
  const names = Object.keys(toSign).sort();
  const canonicalHeaders = names.map(name => `${name}:${toSign[name]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    request.method.toUpperCase(), canonicalUri(request.url), canonicalQuery(request.url), canonicalHeaders, signedHeaders,
    request.payloadSha256,
  ].join('\n');
  const scope = `${dateStamp}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', xAmzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(credentials.secretAccessKey, dateStamp, credentials.region, service))
    .update(stringToSign, 'utf8').digest('hex');
  const headers: Record<string, string> = {};
  for (const name of names) if (name !== 'host') headers[name] = toSign[name]!;
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
