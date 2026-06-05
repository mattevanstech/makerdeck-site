import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { url } = await request.json() as { url: string };

    if (!url?.trim()) {
      return new Response(JSON.stringify({ error: 'No URL provided' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only allow http/https
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return new Response(JSON.stringify({ error: 'URL must be http or https' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch the page server-side (avoids CORS, works for any site)
    const res = await fetch(parsedUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MakerDeck/1.0; +https://makerdeck.net)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'Could not fetch URL' }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only read the first 100KB to keep it fast
    const reader = res.body?.getReader();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (bytes < 100_000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        bytes += value.length;
      }
      reader.cancel();
    }

    // Extract OG title (handles both attribute orderings)
    const ogTitle =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];

    // Extract OG description
    const ogDescription =
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1];

    // Fallback: plain <title> tag
    const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];

    // Fallback: meta name=description
    const metaDesc =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1];

    // Decode HTML entities in the title
    const rawTitle = (ogTitle ?? pageTitle ?? '').trim();
    const rawDesc  = (ogDescription ?? metaDesc ?? '').trim();

    const title       = rawTitle.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const description = rawDesc.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    return new Response(JSON.stringify({ title, description }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[/api/fetch-model-meta]', err);
    return new Response(JSON.stringify({ error: 'Failed to fetch metadata' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
