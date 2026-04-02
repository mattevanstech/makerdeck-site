import type { APIRoute } from 'astro';
import { Client } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';

// Vercel cron job: polls Notion hourly for approved Show & Tell submissions
// that haven't been posted to Discord yet, posts each as a rich embed,
// then writes the Discord message ID back to Notion to prevent double-posting.
// Schedule defined in vercel.json: "0 * * * *" (every hour)

export const GET: APIRoute = async ({ request }) => {
  const cronSecret = import.meta.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  try {
    const notion = new Client({ auth: import.meta.env.NOTION_API_KEY });

    const queryResponse = await notion.databases.query({
      database_id: import.meta.env.NOTION_SHOW_AND_TELL_DB_ID,
      filter: {
        and: [
          { property: 'Approved',          checkbox:  { equals: true } },
          { property: 'Discord Message ID', rich_text: { is_empty: true } },
          { property: 'Source',             select:    { does_not_equal: 'Discord' } },
        ],
      },
    });

    const results: Array<{ pageId: string; name: string; success: boolean; messageId?: string; error?: string }> = [];

    for (const page of queryResponse.results as PageObjectResponse[]) {
      try {
        const props = page.properties;
        const getText = (prop: string) => {
          const p = props[prop];
          if (!p) return '';
          switch (p.type) {
            case 'title':     return p.title[0]?.plain_text     ?? '';
            case 'rich_text': return p.rich_text[0]?.plain_text ?? '';
            case 'url':       return p.url                      ?? '';
            case 'select':    return p.select?.name             ?? '';
            default:          return '';
          }
        };

        const name        = getText('Name');
        const description = getText('Description');
        const photoUrl    = getText('Photo URL');
        const modelSource = getText('Model Source');
        const submitter   = getText('Submitter');

        const embed = {
          title:       name,
          description: description || undefined,
          color:       0x9146FF,
          image:       photoUrl ? { url: photoUrl } : undefined,
          fields: [
            ...(modelSource ? [{ name: '🔗 Model Source', value: modelSource, inline: false }] : []),
            { name: '👤 Maker', value: submitter ? `@${submitter}` : 'Anonymous', inline: true },
          ],
          footer:    { text: 'MakerDeck Show & Tell · makerdeck.net/show-and-tell' },
          timestamp: new Date().toISOString(),
        };

        const webhookUrl = import.meta.env.DISCORD_SHOW_AND_TELL_WEBHOOK_URL;
        const discordRes = await fetch(`${webhookUrl}?wait=true`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🖨️ **${name}**`,
            embeds:  [embed],
          }),
        });

        if (!discordRes.ok) {
          const errText = await discordRes.text();
          throw new Error(`Discord responded ${discordRes.status}: ${errText}`);
        }

        const discordMsg = await discordRes.json() as { id: string };
        const messageId  = discordMsg.id;

        await notion.pages.update({
          page_id:    page.id,
          properties: { 'Discord Message ID': { rich_text: [{ text: { content: messageId } }] } },
        });

        results.push({ pageId: page.id, name, success: true, messageId });
      } catch (pageErr) {
        console.error('[discord-cron] Failed for page', page.id, pageErr);
        results.push({ pageId: page.id, name: '', success: false, error: String(pageErr) });
      }
    }

    console.log(`[discord-cron] Processed ${results.length} submission(s)`);
    return new Response(JSON.stringify({ processed: results.length, results }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[discord-cron]', err);
    return new Response(JSON.stringify({ error: 'Cron job failed', details: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
