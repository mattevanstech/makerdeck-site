import type { APIRoute } from 'astro';
import { Client } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';

// Vercel cron job: polls Notion for approved Show & Tell submissions with
// "Post to Threads" checked that haven't been posted yet, posts each with
// photo + maker handle, then writes the Threads post ID back to Notion.

export const GET: APIRoute = async ({ request }) => {
  const cronSecret = import.meta.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const userId = import.meta.env.THREADS_USER_ID;
  const accessToken = import.meta.env.THREADS_ACCESS_TOKEN;

  if (!userId || !accessToken) {
    return new Response(JSON.stringify({ error: 'Threads env vars not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const baseUrl = `https://graph.threads.net/v1.0/${userId}`;

  try {
    // ── Query Notion ─────────────────────────────────────────────────────────
    const notion = new Client({ auth: import.meta.env.NOTION_API_KEY });
    const queryResponse = await notion.databases.query({
      database_id: import.meta.env.NOTION_SHOW_AND_TELL_DB_ID,
      filter: {
        and: [
          { property: 'Approved', checkbox: { equals: true } },
          { property: 'Post to Threads', checkbox: { equals: true } },
          { property: 'Threads Post ID', rich_text: { is_empty: true } },
        ],
      },
    });

    const results: Array<{
      pageId: string;
      name: string;
      success: boolean;
      postId?: string;
      error?: string;
    }> = [];

    for (const page of queryResponse.results as PageObjectResponse[]) {
      try {
        const props = page.properties;
        const getText = (prop: string) => {
          const p = props[prop];
          if (!p) return '';
          switch (p.type) {
            case 'title': return p.title[0]?.plain_text ?? '';
            case 'rich_text': return p.rich_text[0]?.plain_text ?? '';
            case 'url': return p.url ?? '';
            default: return '';
          }
        };

        const name = getText('Name');
        const description = getText('Description');
        const photoUrl = getText('Photo URL');
        const modelSource = getText('Model Source');
        const submitter = getText('Submitter');
        const rawHandle = getText('Threads Handle');
        const cleanHandle = rawHandle.trim().replace(/^@+/, '').split('@')[0];

        // ── Build post text (no hashtags on Threads) ─────────────────────────
        const handleDisplay = cleanHandle ? `@${cleanHandle}` : submitter || '';
        const makerLine = handleDisplay ? `\n\nMaker: ${handleDisplay}` : '';
        const modelLine = modelSource ? `\n\n\uD83D\uDD17 ${modelSource}` : '';
        const frameLen = (name + makerLine + modelLine).length;
        const maxDescLen = 495 - frameLen - 2; // Threads limit is 500 chars
        const trimDesc = description && maxDescLen > 10 && description.length > maxDescLen
          ? description.substring(0, maxDescLen - 1) + '\u2026'
          : description || '';
        const postText =
          name +
          makerLine +
          (trimDesc ? `\n\n${trimDesc}` : '') +
          modelLine;

        // ── Create Threads media container ───────────────────────────────────
        const containerParams: Record<string, string> = {
          access_token: accessToken,
          text: postText,
        };

        if (photoUrl) {
          containerParams.media_type = 'IMAGE';
          containerParams.image_url = photoUrl;
        } else {
          containerParams.media_type = 'TEXT';
        }

        const containerRes = await fetch(
          `${baseUrl}/threads?${new URLSearchParams(containerParams)}`,
          { method: 'POST' }
        );

        if (!containerRes.ok) {
          throw new Error(`Container creation failed ${containerRes.status}: ${await containerRes.text()}`);
        }
        const { id: containerId } = await containerRes.json() as { id: string };

        // ── Publish the container ────────────────────────────────────────────
        const publishRes = await fetch(
          `${baseUrl}/threads_publish?${new URLSearchParams({ creation_id: containerId, access_token: accessToken })}`,
          { method: 'POST' }
        );

        if (!publishRes.ok) {
          throw new Error(`Publish failed ${publishRes.status}: ${await publishRes.text()}`);
        }
        const { id: postId } = await publishRes.json() as { id: string };

        // ── Mark as posted in Notion ─────────────────────────────────────────
        await notion.pages.update({
          page_id: page.id,
          properties: {
            'Threads Post ID': { rich_text: [{ text: { content: postId } }] },
          },
        });

        results.push({ pageId: page.id, name, success: true, postId });
        console.log(`[threads-cron] Posted: ${name} → ${postId}`);

      } catch (pageErr) {
        console.error('[threads-cron] Failed for page', page.id, pageErr);
        results.push({ pageId: page.id, name: '', success: false, error: String(pageErr) });
      }
    }

    console.log(`[threads-cron] Processed ${results.length} submission(s)`);
    return new Response(JSON.stringify({ processed: results.length, results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[threads-cron]', err);
    return new Response(JSON.stringify({ error: 'Cron job failed', details: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
