import type { APIRoute } from 'astro';
import { Client } from '@notionhq/client';

// ── AWS SigV4 helpers — no external packages, uses Web Crypto API ─────────────
async function sha256(data: string | Uint8Array): Promise<ArrayBuffer> {
  const input = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return crypto.subtle.digest('SHA-256', input);
}

async function hmacSha256(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

async function uploadToR2(
  accountId: string,
  accessKeyId: string,
  secretAccessKey: string,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const region  = 'auto';
  const service = 's3';
  const host    = `${accountId}.r2.cloudflarestorage.com`;
  const url     = `https://${host}/${bucket}/${key}`;

  const now      = new Date();
  const ymd      = now.toISOString().slice(0, 10).replace(/-/g, '');
  const datetime = ymd + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z';

  const payloadHash     = toHex(await sha256(body));
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${datetime}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    'PUT', `/${bucket}/${key}`, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const credentialScope = `${ymd}/${region}/${service}/aws4_request`;
  const stringToSign    = [
    'AWS4-HMAC-SHA256', datetime, credentialScope, toHex(await sha256(canonicalRequest)),
  ].join('\n');

  let signingKey: BufferSource = new TextEncoder().encode(`AWS4${secretAccessKey}`);
  signingKey = await hmacSha256(signingKey, ymd);
  signingKey = await hmacSha256(signingKey, region);
  signingKey = await hmacSha256(signingKey, service);
  signingKey = await hmacSha256(signingKey, 'aws4_request');

  const signature    = toHex(await hmacSha256(signingKey, stringToSign));
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization':          authorization,
      'Content-Type':           contentType,
      'x-amz-content-sha256':   payloadHash,
      'x-amz-date':             datetime,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 upload failed ${res.status}: ${text}`);
  }
}

// ── API Route ─────────────────────────────────────────────────────────────────
export const POST: APIRoute = async ({ request }) => {
  try {
    const {
      name, description, modelSource, submitter,
      fileName, fileType, fileData,
      mastodonHandle,
      blueskyHandle,
      website, turnstileToken,
    } = await request.json() as {
      name: string; description: string; modelSource: string; submitter: string;
      fileName: string; fileType: string; fileData: string;
      mastodonHandle?: string;
      blueskyHandle?: string;
      website?: string; turnstileToken?: string;
    };

    // ── Honeypot check ────────────────────────────────────────────────────────
    if (website) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Turnstile verification ────────────────────────────────────────────────
    const turnstileSecret = import.meta.env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      if (!turnstileToken) {
        return new Response(JSON.stringify({ error: 'Please complete the verification.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: turnstileSecret, response: turnstileToken }),
      });
      const verifyData = await verifyRes.json() as { success: boolean };
      if (!verifyData.success) {
        return new Response(JSON.stringify({ error: 'Verification failed. Please try again.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (!name?.trim() || !submitter?.trim() || !fileData) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = Uint8Array.from(atob(fileData), c => c.charCodeAt(0));

    if (body.length > 4 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'Photo must be under 4MB' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Upload to Cloudflare R2 ───────────────────────────────────────────────
    const ext = (fileName ?? 'photo').split('.').pop()?.toLowerCase() ?? 'jpg';
    const key = `show-and-tell/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

    await uploadToR2(
      import.meta.env.CLOUDFLARE_R2_ACCOUNT_ID,
      import.meta.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      import.meta.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      import.meta.env.CLOUDFLARE_R2_BUCKET_NAME,
      key, body, fileType || 'image/jpeg',
    );

    const photoUrl = `${import.meta.env.CLOUDFLARE_R2_PUBLIC_URL}/${key}`;

    // ── Create Notion draft ───────────────────────────────────────────────────
    const notion = new Client({ auth: import.meta.env.NOTION_API_KEY });
    await notion.pages.create({
      parent: { database_id: import.meta.env.NOTION_SHOW_AND_TELL_DB_ID },
      properties: {
        'Name':            { title:     [{ text: { content: name } }] },
        'Description':     { rich_text: [{ text: { content: description } }] },
        'Photo URL':       { url: photoUrl },
        'Model Source':    { url: modelSource || null },
        'Submitter':       { rich_text: [{ text: { content: submitter } }] },
        'Mastodon Handle': { rich_text: [{ text: { content: mastodonHandle?.trim() || '' } }] },
        'Bluesky Handle':  { rich_text: [{ text: { content: blueskyHandle?.trim() ?? '' } }] },
        'Source':          { select: { name: 'Web Form' } },
        'Approved':        { checkbox: false },
      },
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[/api/submit]', err);
    return new Response(JSON.stringify({ error: 'Submission failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
