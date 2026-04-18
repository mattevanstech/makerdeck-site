import type { APIRoute } from 'astro';
import { Client } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';

// Vercel cron job: polls Notion for approved Show & Tell submissions with
// "Post to Bluesky" checked that haven't been posted yet, posts each with
// photo + maker handle (with mention facet), then writes the Bluesky post
// URI back to Notion.

export const GET: APIRoute = async ({ request }) => {
  const cronSecret = import.meta.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const identifier = import.meta.env.BLUESKY_IDENTIFIER;
  const appPassword = import.meta.env.BLUESKY_APP_PASSWORD;

  if (!identifier || !appPassword) {
    return new Response(JSON.stringify({ error: 'Bluesky env vars not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // ── Authenticate to Bluesky ──────────────────────────────────────────────
    const sessionRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password: appPassword }),
    });
    if (!sessionRes.ok) {
      throw new Error(`Bluesky auth failed: ${await sessionRes.text()}`);
    }
    const { accessJwt, did } = await sessionRes.json() as { accessJwt: string; did: string };

    // ── Query Notion ─────────────────────────────────────────────────────────
    const notion = new Client({ auth: import.meta.env.NOTION_API_KEY });
    const queryResponse = await notion.databases.query({
      database_id: import.meta.env.NOTION_SHOW_AND_TELL_DB_ID,
      filter: {
        and: [
          { property: 'Approved', checkbox: { equals: true } },
          { property: 'Post to Bluesky', checkbox: { equals: true } },
          { property: 'Bluesky Post URI', rich_text: { is_empty: true } },
        ],
      },
    });

    const results: Array<{
      pageId: string;
      name: string;
      success: boolean;
      uri?: string;
      error?: string;
    }> = [];

    for (const page of queryResponse.results as PageObjectResponse[]) {
      try {
        const props = page.properties;
        const getText = (prop: string) => {
          const p = props[prop];
          if (!p) return '';
          switch (p.type) {
            case 'title':    return p.title[0]?.plain_text ?? '';
            case 'rich_text': return p.rich_text[0]?.plain_text ?? '';
            case 'url':      return p.url ?? '';
            default:         return '';
          }
        };

        const name        = getText('Name');
        const description = getText('Description');
        const photoUrl    = getText('Photo URL');
        const modelSource = getText('Model Source');
        const submitter   = getText('Submitter');
        const rawHandle   = getText('Bluesky Handle');
        const cleanHandle = rawHandle.trim().replace(/^@/, '');

        // ── Upload photo blob to Bluesky ─────────────────────────────────────
        let blobRef: unknown | undefined;
        if (photoUrl) {
          const photoRes = await fetch(photoUrl);
          if (photoRes.ok) {
            const photoBytes  = await photoRes.arrayBuffer();
            const contentType = photoRes.headers.get('content-type') || 'image/jpeg';
            const blobRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.uploadBlob', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessJwt}`,
                'Content-Type': contentType,
              },
              body: photoBytes,
            });
            if (blobRes.ok) {
              const blobData = await blobRes.json() as { blob: unknown };
              blobRef = blobData.blob;
            } else {
              console.warn('[bluesky-cron] Blob upload failed:', await blobRes.text());
            }
          }
        }

        // ── Resolve handle to DID for mention facet ──────────────────────────
        let mentionDid: string | undefined;
        if (cleanHandle) {
          const resolveRes = await fetch(
            `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(cleanHandle)}`
          );
          if (resolveRes.ok) {
            const resolveData = await resolveRes.json() as { did: string };
            mentionDid = resolveData.did;
          }
        }

        // ── Build post text ──────────────────────────────────────────────────
        const handleDisplay = cleanHandle ? `@${cleanHandle}` : submitter || '';
        const makerLine  = handleDisplay ? `\n\nMaker: ${handleDisplay}` : '';
        const modelLine  = modelSource   ? `\n\n🔗 ${modelSource}`        : '';
        const postText   =
          name +
          makerLine +
          (description ? `\n\n${description}` : '') +
          modelLine +
          '\n\n#3DPrinting #MakerDeck';

        // ── Build mention facet (byte-accurate offsets) ──────────────────────
        const facets: unknown[] = [];
        if (mentionDid && cleanHandle) {
          const enc       = new TextEncoder();
          const byteStart = enc.encode(name + '\n\nMaker: ').length;
          const mentionStr = `@${cleanHandle}`;
          const byteEnd   = byteStart + enc.encode(mentionStr).length;
          facets.push({
            index: { byteStart, byteEnd },
            features: [{ $type: 'app.bsky.richtext.facet#mention', did: mentionDid }],
          });
        }

        // ── Create post record ───────────────────────────────────────────────
        const record: Record<string, unknown> = {
          $type: 'app.bsky.feed.post',
          text: postText,
          createdAt: new Date().toISOString(),
        };
        if (blobRef) {
          record.embed = {
            $type: 'app.bsky.embed.images',
            images: [{ image: blobRef, alt: `${name} by ${submitter}` }],
          };
        }
        if (facets.length > 0) record.facets = facets;

        const postRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
        });
        if (!postRes.ok) {
          throw new Error(`Bluesky post failed ${postRes.status}: ${await postRes.text()}`);
        }
        const { uri } = await postRes.json() as { uri: string };

        // ── Mark as posted in Notion ─────────────────────────────────────────
        await notion.pages.update({
          page_id: page.id,
          properties: {
            'Bluesky Post URI': { rich_text: [{ text: { content: uri } }] },
          },
        });

        results.push({ pageId: page.id, name, success: true, uri });
      } catch (pageErr) {
        console.error('[bluesky-cron] Failed for page', page.id, pageErr);
        results.push({ pageId: page.id, name: '', success: false, error: String(pageErr) });
      }
    }

    console.log(`[bluesky-cron] Processed ${results.length} submission(s)`);
    return new Response(JSON.stringify({ processed: results.length, results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[bluesky-cron]', err);
    return new Response(JSON.stringify({ error: 'Cron job failed', details: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
