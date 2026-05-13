/**
 * Image handling utilities for multimodal requests.
 *
 * Supports:
 *   - Inline base64 data URLs (data:image/png;base64,...)
 *   - HTTP/HTTPS image URL fetching with size/redirect/SSRF limits
 *
 * Security:
 *   - DNS-resolved addresses are checked against private/loopback ranges
 *     BEFORE the TCP connect — defends against DNS rebinding where a public
 *     hostname resolves to 127.0.0.1 / 169.254.169.254 / 10.x.x.x etc.
 *   - Maximum redirect depth to prevent redirect loops
 *   - Maximum image size to prevent memory exhaustion
 *
 * Output format matches what buildSendCascadeMessageRequest expects in
 * field 6 (CascadeImageAttachment): { mimeType, base64 }.
 */

import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import net from 'net';
import { URL } from 'url';
import { log } from './config.js';

const MAX_SIZE = 5 * 1024 * 1024;   // 5 MB
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

// ─── SSRF protection ──────────────────────────────────────

// Hostname-level prefilter. Catches the most common leakage (direct localhost
// strings, IPv6 literals), but is NOT sufficient on its own — DNS may resolve
// an external name to an internal IP. The post-DNS check below is authoritative.
const PRIVATE_HOSTNAME_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^fd/i,
  /^localhost$/i,
];

function isPrivateHostname(hostname) {
  return PRIVATE_HOSTNAME_RANGES.some(re => re.test(hostname));
}

/**
 * Authoritative IP check. Accepts "a.b.c.d" or IPv6 literal and returns true
 * if the address is loopback, link-local, private, or cloud-metadata-adjacent.
 * Handles IPv4-mapped IPv6 (::ffff:127.0.0.1 ⇒ 127.0.0.1).
 */
function isPrivateIp(addr) {
  if (!addr) return true;
  let ip = addr;
  const family = net.isIP(ip);
  if (family === 0) return true; // unparseable — reject
  // Unwrap IPv4-mapped IPv6
  if (family === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.test(ip)) {
    ip = ip.replace(/^::ffff:/i, '');
  }
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(n => parseInt(n, 10));
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;       // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                     // multicast + reserved
    return false;
  }
  // IPv6
  const low = ip.toLowerCase();
  if (low === '::' || low === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/i.test(low)) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(low)) return true; // unique-local
  if (low.startsWith('ff')) return true;             // multicast
  return false;
}

/**
 * Validate that a URL is safe to fetch. Throws on private addresses,
 * unsupported schemes, or suspicious hostnames (syntactic check only).
 * The authoritative check happens after DNS resolution in fetchImageUrl.
 */
export function validateImageUrl(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch { throw new Error('Invalid image URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported protocol: ${url.protocol}`);
  if (isPrivateHostname(url.hostname)) throw new Error(`Private/loopback address rejected: ${url.hostname}`);
  return url;
}

// ─── Fetch image from URL ──────────────────────────────────

async function resolveSafeAddress(hostname) {
  // If caller passed a literal IP in the URL, just check it directly.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Private IP rejected: ${hostname}`);
    return hostname;
  }
  // Resolve both families and reject if ANY answer points at a private range.
  // Rejecting on any private address (not just the one we'd pick) prevents
  // round-robin DNS from slipping a private IP past by luck of the draw.
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!answers.length) throw new Error(`DNS lookup returned no records for ${hostname}`);
  for (const a of answers) {
    if (isPrivateIp(a.address)) throw new Error(`Hostname ${hostname} resolves to private IP ${a.address}`);
  }
  return answers[0].address;
}

function fetchImageUrl(urlStr, redirects = 0) {
  return new Promise(async (resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
    let url;
    try { url = validateImageUrl(urlStr); } catch (e) { return reject(e); }

    let safeAddr;
    try {
      safeAddr = await resolveSafeAddress(url.hostname);
    } catch (e) { return reject(e); }

    const mod = url.protocol === 'https:' ? https : http;
    // Connect to the resolved IP but preserve the Host header + SNI so TLS
    // and virtual-host routing still work.
    const reqOpts = {
      host: safeAddr,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Host: url.host },
      servername: url.hostname,
      timeout: FETCH_TIMEOUT_MS,
      // Reject certs with hostname mismatch caused by IP-in-Host. SNI already
      // carries the real hostname, so Node will validate against that.
      rejectUnauthorized: url.protocol === 'https:',
    };

    const req = mod.request(reqOpts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirect without Location header'));
        res.resume();
        // Re-validate + re-resolve on every redirect; chained redirects to
        // 10.0.0.1 would otherwise bypass the initial SSRF check.
        return resolve(fetchImageUrl(new URL(loc, url).href, redirects + 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching image`));
      }
      const contentLength = parseInt(res.headers['content-length'], 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_SIZE) {
        res.resume();
        return reject(new Error(`Image too large: ${contentLength} bytes (max ${MAX_SIZE})`));
      }
      const buffers = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_SIZE) {
          res.destroy();
          return reject(new Error(`Image exceeds ${MAX_SIZE} bytes`));
        }
        buffers.push(chunk);
      });
      res.on('end', () => {
        const data = Buffer.concat(buffers);
        const ct = (res.headers['content-type'] || '').split(';')[0].trim() || 'image/png';
        resolve({ mimeType: ct, base64: data.toString('base64') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Image fetch timeout')); });
    req.end();
  });
}

// ─── Parse data URL ────────────────────────────────────────

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

// ─── Extract images from OpenAI content blocks ─────────────

/**
 * Given an OpenAI message `content` (string or content array), extract
 * all images and return { text, images }.
 *
 * Images are returned as [{ mimeType, base64 }] for proto field 6.
 * Text blocks are concatenated into a single string.
 */
export async function extractImages(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ''), images: [] };

  const textParts = [];
  const images = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }

    if (block.type === 'image_url' && block.image_url?.url) {
      const url = block.image_url.url;
      try {
        if (url.startsWith('data:')) {
          const parsed = parseDataUrl(url);
          if (parsed) images.push(parsed);
          else log.warn('Image: failed to parse data URL');
        } else {
          const fetched = await fetchImageUrl(url);
          images.push(fetched);
        }
      } catch (e) {
        log.warn(`Image: failed to process ${url.slice(0, 80)}: ${e.message}`);
      }
      continue;
    }

    // Anthropic-style image block (from /v1/messages translation)
    if (block.type === 'image' && block.source?.type === 'base64') {
      images.push({
        mimeType: block.source.media_type || 'image/png',
        base64: block.source.data,
      });
      continue;
    }
  }

  return { text: textParts.join('\n'), images };
}
