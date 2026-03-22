import type { APIRoute } from 'astro';
import { Client } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';

// Called by a Notion automation when "Approved" is checked on a submission.
// Configure the Notion automation HTTP request body as:
// { "secret": "YOUR_NOTION_WEBHOOK_SECRET", "pageId": "{{page_id}}" }

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();

    // Verify the shared secret to ensure this came from Notion
    if (body.secret !== import.meta.env.NOTION_WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    const pageId: string = body.pageId;
    if (!pageId) {
      return new Response(JSON.stringify({ error: 'Missing pageId' }), { status: 400 });
    }

    // Fetch the full Notion page to get its properties
    const notion = new Client({ auth: import.meta.env.NOTION_API_KEY });
    const page   = await notion.pages.retrieve({ page_id: pageId }) as PageObjectResponse;

    const props = page.properties;
    const getText = (prop: string) => {
      const p = props[prop];
      if (!p) return '';
      switch (p.type) {
        case 'title':     return p.title[0]?.plain_text ?? '';
        case 'rich_text': return p.rich_text[0]?.plain_text ?? '';
        case 'url':       return p.url ?? '';
        case 'select':    return p.select?.name ?? '';
        default:          return '';
      }
    };

    const name        = getText('Name');
    const description = getText('Description');
    const photoUrl    = getText('Photo URL');
    const modelSource = getText('Model Source');
    const submitter   = getText('Submitter');
    const source      = getText('Source');

    // Only post to Discord for web form submissions (Discord submissions are
    // already in the channel; we don't want to double-post them)
    if (source === 'Discord') {
      return new Response(JSON.stringify({ skipped: 'Discord source — not reposting' }), { status: 200 });
    }

    // ── Post to Discord via webhook ─────────────────────────────────────────
    const embed = {
      title:       name,
      description: description || undefined,
      color:       0x9146FF, // Twitch purple
      image:       { url: photoUrl },
      fields: [
        ...(modelSource ? [{ name: '🔗 Model Source', value: modelSource, inline: false }] : []),
        { name: '👤 Maker', value: submitter, inline: true },
      ],
      footer:    { text: 'MakerDeck Show & Tell · makerdeck.net/show-and-tell' },
      timestamp: new Date().toISOString(),
    };

    const discordRes = await fetch(import.meta.env.DISCORD_SHOW_AND_TELL_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '🖨️ **New print in the Show & Tell gallery!**',
        embeds:  [embed],
      }),
    });

    if (!discordRes.ok) {
      throw new Error(`Discord webhook responded ${discordRes.status}`);
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });

  } catch (err) {
    console.error('[/api/notify-discord]', err);
    return new Response(JSON.stringify({ error: 'Notification failed' }), { status: 500 });
  }
};
