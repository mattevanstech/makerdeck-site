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

  const payloadHash      = toHex(await sha256(body));
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

  const signature     = toHex(await hmacSha256(signingKey, stringToSign));
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization':        authorization,
      'Content-Type':         contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date':           datetime,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 upload failed ${res.status}: ${text}`);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface PrintPayload {
  name: string;
  description: string;
  modelSource: string;
  fileName: string;
  fileType: string;
  fileData: string;
}

interface BatchRequest {
  submitter: string;
  mastodonHandle?: string;
  blueskyHandle?: string;
  website?: string;
  turnstileToken?: string;
  /** Batch mode: array of prints */
  prints: PrintPayload[];
}

// ── Single-print upload + Notion entry ───────────────────────────────────────
async function processPrint(
  print: PrintPayload,
  submitter: string,
  mastodonHandle: string,
  blueskyHandle: string,
): Promise<void> {
  const body = Uint8Array.from(atob(print.fileData), c => c.charCodeAt(0));

  if (body.length > 4 * 1024 * 1024) {
    throw new Error('Photo must be under 4 MB');
  }

  const ext = (print.fileName ?? 'photo').split('.').pop()?.toLowerCase() ?? 'jpg';
  const key = `show-and-tell/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

  await uploadToR2(
    import.meta.env.CLOUDFLARE_R2_ACCOUNT_ID,
    import.meta.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    import.meta.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    import.meta.env.CLOUDFLARE_R2_BUCKET_NAME,
    key,
    body,
    print.fileType || 'image/jpeg',
  );

  const photoUrl = `${import.meta.env.CLOUDFLARE_R2_PUBLIC_URL}/${key}`;

  const notion = new Client({ auth: import.meta.env.NOTION_API_KEY });
  await notion.pages.create({
    parent: { database_id: import.meta.env.NOTION_SHOW_AND_TELL_DB_ID },
    properties: {
      'Name':            { title:     [{ text: { content: print.name } }] },
      'Description':     { rich_text: [{ text: { content: print.description ?? '' } }] },
      'Photo URL':       { url: photoUrl },
      'Model Source':    { url: print.modelSource || null },
      'Submitter':       { rich_text: [{ text: { content: submitter } }] },
      'Mastodon Handle': { rich_text: [{ text: { content: mastodonHandle ?? '' } }] },
      'Bluesky Handle':  { rich_text: [{ text: { content: blueskyHandle ?? '' } }] },
      'Source':          { select: { name: 'Web Form' } },
      'Approved':        { checkbox: false },
    },
  });
}

// ── API Route ─────────────────────────────────────────────────────────────────
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json() as BatchRequest;

    const {
      submitter,
      mastodonHandle = '',
      blueskyHandle  = '',
      website        = '',
      turnstileToken = '',
      prints         = [],
    } = body;

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

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!submitter?.trim()) {
      return new Response(JSON.stringify({ error: 'Name / Discord handle is required.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!prints.length) {
      return new Response(JSON.stringify({ error: 'No prints to submit.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    for (const p of prints) {
      if (!p.name?.trim()) {
        return new Response(JSON.stringify({ error: 'Each print must have a name.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (!p.fileData) {
        return new Response(JSON.stringify({ error: 'Missing photo data for one or more prints.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // ── Process each print ────────────────────────────────────────────────────
    const errors: string[] = [];
    let successCount = 0;

    for (const print of prints) {
      try {
        await processPrint(print, submitter.trim(), mastodonHandle.trim(), blueskyHandle.trim());
        successCount++;
      } catch (err) {
        console.error('[/api/submit] print failed:', err);
        errors.push(print.name ?? 'Unknown');
      }
    }

    if (successCount === 0) {
      return new Response(JSON.stringify({ error: 'All submissions failed. Please try again.' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      submitted: successCount,
      failed: errors.length,
      failedNames: errors,
    }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[/api/submit]', err);
    return new Response(JSON.stringify({ error: 'Submission failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
