import type { APIRoute } from 'astro';
import { Client } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';

// Vercel cron job: polls Notion for approved Show & Tell submissions with
// "Post to Mastodon" checked that haven't been posted yet, posts each with
// photo + maker handle, then writes the Mastodon post ID back to Notion.
// Schedule defined in vercel.json (e.g. every 15 min: "*/15 * * * *")

export const GET: APIRoute = async ({ request }) => {
  const cronSecret = import.meta.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const instanceUrl   = import.meta.env.MASTODON_INSTANCE_URL?.replace(/\/$/, '');
  const accessToken   = import.meta.env.MASTODON_ACCESS_TOKEN;

  if (!instanceUrl || !accessToken) {
    return new Response(JSON.stringify({ error: 'Mastodon env vars not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const notion = new Client({ auth: import.meta.env.NOTION_API_KEY });

    const queryResponse = await notion.databases.query({
      database_id: import.meta.env.NOTION_SHOW_AND_TELL_DB_ID,
      filter: {
        and: [
          { property: 'Approved',          checkbox:  { equals: true } },
          { property: 'Post to Mastodon',   checkbox:  { equals: true } },
          { property: 'Mastodon Post ID',   rich_text: { is_empty: true } },
        ],
      },
    });

    const results: Array<{
      pageId: string; name: string; success: boolean; postId?: string; error?: string;
    }> = [];

    for (const page of queryResponse.results as PageObjectResponse[]) {
      try {
        const props = page.properties;

        const getText = (prop: string) => {
          const p = props[prop];
          if (!p) return '';
          switch (p.type) {
            case 'title':     return p.title[0]?.plain_text ?? '';
            case 'rich_text': return p.rich_text[0]?.plain_text ?? '';
            case 'url':       return p.url ?? '';
            default:          return '';
          }
        };

        const name           = getText('Name');
        const description    = getText('Description');
        const photoUrl       = getText('Photo URL');
        const modelSource    = getText('Model Source');
        const submitter      = getText('Submitter');
        const mastodonHandle = getText('Mastodon Handle');

        // ── Upload photo to Mastodon ───────────────────────────────────────
        let mediaId: string | undefined;
        if (photoUrl) {
          const photoRes = await fetch(photoUrl);
          if (photoRes.ok) {
            const photoBlob = await photoRes.blob();
            const ext = photoUrl.split('.').pop()?.split('?')[0] ?? 'jpg';
            const formData = new FormData();
            formData.append('file', new File([photoBlob], `photo.${ext}`, { type: photoBlob.type || 'image/jpeg' }));
            formData.append('description', `Photo of ${name} by ${submitter}`);

            const mediaRes = await fetch(`${instanceUrl}/api/v2/media`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${accessToken}` },
              body: formData,
            });

            if (mediaRes.ok) {
              const mediaData = await mediaRes.json() as { id: string };
              mediaId = mediaData.id;

              // Wait for processing if needed (async upload returns 202)
              if (mediaRes.status === 202) {
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            } else {
              console.warn('[mastodon-cron] Media upload failed:', await mediaRes.text());
            }
          }
        }

        // ── Build post text ────────────────────────────────────────────────
        const handleTag = mastodonHandle?.trim()
          ? `\n\nMaker: ${mastodonHandle.trim().startsWith('@') ? mastodonHandle.trim() : '@' + mastodonHandle.trim()}`
          : submitter ? `\n\nMaker: ${submitter}` : '';

        const modelLine = modelSource ? `\n\n🔗 ${modelSource}` : '';

        const statusText =
          `🖨️ ${name}${handleTag}` +
          (description ? `\n\n${description}` : '') +
          modelLine +
          `\n\n#3DPrinting #MakerDeck`;

        // ── Post status ────────────────────────────────────────────────────
        const statusBody: Record<string, unknown> = {
          status:     statusText,
          visibility: 'public',
        };
        if (mediaId) statusBody.media_ids = [mediaId];

        const statusRes = await fetch(`${instanceUrl}/api/v1/statuses`, {
          method: 'POST',
          headers: {
            'Authorization':  `Bearer ${accessToken}`,
            'Content-Type':   'application/json',
          },
          body: JSON.stringify(statusBody),
        });

        if (!statusRes.ok) {
          const errText = await statusRes.text();
          throw new Error(`Mastodon status post failed ${statusRes.status}: ${errText}`);
        }

        const statusData = await statusRes.json() as { id: string };
        const postId = statusData.id;

        // ── Mark as posted in Notion ───────────────────────────────────────
        await notion.pages.update({
          page_id: page.id,
          properties: {
            'Mastodon Post ID': { rich_text: [{ text: { content: postId } }] },
          },
        });

        results.push({ pageId: page.id, name, success: true, postId });
      } catch (pageErr) {
        console.error('[mastodon-cron] Failed for page', page.id, pageErr);
        results.push({ pageId: page.id, name: '', success: false, error: String(pageErr) });
      }
    }

    console.log(`[mastodon-cron] Processed ${results.length} submission(s)`);
    return new Response(JSON.stringify({ processed: results.length, results }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[mastodon-cron]', err);
    return new Response(JSON.stringify({ error: 'Cron job failed', details: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
