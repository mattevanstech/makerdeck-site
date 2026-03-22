import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Client } from '@notionhq/client';

export const POST: APIRoute = async ({ request }) => {
  try {
    const formData = await request.formData();

    const name        = (formData.get('name') as string)?.trim();
    const description = (formData.get('description') as string)?.trim() ?? '';
    const modelSource = (formData.get('modelSource') as string)?.trim() ?? '';
    const submitter   = (formData.get('submitter') as string)?.trim();
    const photo       = formData.get('photo') as File | null;

    // Validate required fields
    if (!name || !submitter || !photo || photo.size === 0) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate file size (10MB max)
    if (photo.size > 10 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'Photo must be under 10MB' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Upload to Cloudflare R2 ─────────────────────────────────────────────
    const r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${import.meta.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     import.meta.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: import.meta.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
    });

    const ext      = photo.name.split('.').pop()?.toLowerCase() ?? 'jpg';
    const fileName = `show-and-tell/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const buffer   = Buffer.from(await photo.arrayBuffer());

    await r2.send(new PutObjectCommand({
      Bucket:      import.meta.env.CLOUDFLARE_R2_BUCKET_NAME,
      Key:         fileName,
      Body:        buffer,
      ContentType: photo.type,
    }));

    const photoUrl = `${import.meta.env.CLOUDFLARE_R2_PUBLIC_URL}/${fileName}`;

    // ── Create Notion draft ─────────────────────────────────────────────────
    const notion = new Client({ auth: import.meta.env.NOTION_API_KEY });

    await notion.pages.create({
      parent: { database_id: import.meta.env.NOTION_SHOW_AND_TELL_DB_ID },
      properties: {
        'Name':        { title:     [{ text: { content: name } }] },
        'Description': { rich_text: [{ text: { content: description } }] },
        'Photo URL':   { url: photoUrl },
        'Model Source':{ url: modelSource || null },
        'Submitter':   { rich_text: [{ text: { content: submitter } }] },
        'Source':      { select: { name: 'Web Form' } },
        'Approved':    { checkbox: false },
      },
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[/api/submit]', err);
    return new Response(JSON.stringify({ error: 'Submission failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
