import type { APIRoute } from 'astro';
import { Client } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';

const NOTION_TOKEN = import.meta.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = import.meta.env.NOTION_DATABASE_ID;
const BLUESKY_IDENTIFIER = import.meta.env.BLUESKY_IDENTIFIER;
const BLUESKY_APP_PASSWORD = import.meta.env.BLUESKY_APP_PASSWORD;
const CRON_SECRET = import.meta.env.CRON_SECRET;

export const GET: APIRoute = async ({ request }) => {
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  // Authenticate with Bluesky
  const sessionRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: BLUESKY_IDENTIFIER, password: BLUESKY_APP_PASSWORD }),
  });
  if (!sessionRes.ok) {
    return new Response(JSON.stringify({ error: 'Bluesky auth failed' }), { status: 500 });
  }
  const session = await sessionRes.json();
  const accessJwt = session.accessJwt;
  const did = session.did;

  // Query Notion for approved submissions pending Bluesky post
  const response = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        { property: 'Approved', checkbox: { equals: true } },
        { property: 'Post to Bluesky', checkbox: { equals: true } },
        { property: 'Bluesky Post URI', rich_text: { is_empty: true } },
      ],
    },
  });

  const results = [];

  for (const page of response.results as PageObjectResponse[]) {
    try {
      const props = page.properties;

      const name = props['Name']?.type === 'title'
        ? props['Name'].title[0]?.plain_text ?? '' : '';
      const submitter = props['Submitter']?.type === 'rich_text'
        ? props['Submitter'].rich_text[0]?.plain_text ?? '' : '';
      const description = props['Description']?.type === 'rich_text'
        ? props['Description'].rich_text[0]?.plain_text ?? '' : '';
      const shopLink = props['Shop Link']?.type === 'url'
        ? props['Shop Link'].url ?? '' : '';
      const blueskyHandle = props['Bluesky Handle']?.type === 'rich_text'
        ? props['Bluesky Handle'].rich_text[0]?.plain_text ?? '' : '';

      // Get photo
      const photoFiles = props['Photo']?.type === 'files' ? props['Photo'].files : [];
      const photoUrl = photoFiles[0]?.type === 'file'
        ? photoFiles[0].file.url
        : photoFiles[0]?.type === 'external' ? photoFiles[0].external.url : null;

      // Upload image blob
      let blobRef = null;
      if (photoUrl) {
        const imgRes = await fetch(photoUrl);
        const imgBuffer = await imgRes.arrayBuffer();
        const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
        const uploadRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.uploadBlob', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessJwt}`, 'Content-Type': contentType },
          body: imgBuffer,
        });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          blobRef = uploadData.blob;
        }
      }

      // Build post text
      const cleanHandle = blueskyHandle.replace(/^@/, '');
      let postText = `${name}\n\nMaker: `;
      postText += cleanHandle ? `@${cleanHandle}\n` : `${submitter}\n`;
      if (description) postText += `${description} `;
      if (shopLink) postText += `\ud83d\udd17 ${shopLink}\n`;
      postText += `#3DPrinting #MakerDeck`;

      // Build facets
      const enc = new TextEncoder();
      const facets: Record<string, unknown>[] = [];

      // Mention facet
      if (cleanHandle) {
        const mentionPrefix = `${name}\n\nMaker: `;
        const byteStart = enc.encode(mentionPrefix).length;
        const mentionStr = `@${cleanHandle}`;
        const byteEnd = byteStart + enc.encode(mentionStr).length;
        const resolveRes = await fetch(
          `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(cleanHandle)}`
        );
        if (resolveRes.ok) {
          const resolveData = await resolveRes.json();
          facets.push({
            index: { byteStart, byteEnd },
            features: [{ $type: 'app.bsky.richtext.facet#mention', did: resolveData.did }],
          });
        }
      }

      // URL facets
      const urlRegex = /https?:\/\/[^\s]+/g;
      let urlMatch;
      while ((urlMatch = urlRegex.exec(postText)) !== null) {
        const byteStart = enc.encode(postText.slice(0, urlMatch.index)).length;
        const byteEnd = byteStart + enc.encode(urlMatch[0]).length;
        facets.push({
          index: { byteStart, byteEnd },
          features: [{ $type: 'app.bsky.richtext.facet#link', uri: urlMatch[0] }],
        });
      }

      // Hashtag facets
      const tagRegex = /#(\w+)/g;
      let tagMatch;
      while ((tagMatch = tagRegex.exec(postText)) !== null) {
        const byteStart = enc.encode(postText.slice(0, tagMatch.index)).length;
        const byteEnd = byteStart + enc.encode(tagMatch[0]).length;
        facets.push({
          index: { byteStart, byteEnd },
          features: [{ $type: 'app.bsky.richtext.facet#tag', tag: tagMatch[1] }],
        });
      }

      // Build and create record
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
        const err = await postRes.text();
        results.push({ name, error: err });
        continue;
      }

      const postData = await postRes.json();
      const postUri = postData.uri;

      // Mark as posted in Notion
      await notion.pages.update({
        page_id: page.id,
        properties: {
          'Bluesky Post URI': { rich_text: [{ text: { content: postUri } }] },
        },
      });

      results.push({ name, uri: postUri });
    } catch (err) {
      results.push({ name: 'unknown', error: String(err) });
    }
  }

  console.log(`[bluesky-cron] Processed ${results.length} submission(s):`, JSON.stringify(results));
  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
