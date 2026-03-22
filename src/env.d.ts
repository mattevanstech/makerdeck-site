/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly NOTION_API_KEY: string;
  readonly NOTION_MAKER_APPS_DB_ID: string;
  readonly NOTION_GET_INVOLVED_DB_ID: string;
  readonly NOTION_COMMUNITY_RESOURCES_DB_ID: string;
  readonly NOTION_SHOW_AND_TELL_DB_ID: string;
  readonly CLOUDFLARE_R2_ACCOUNT_ID: string;
  readonly CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  readonly CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
  readonly CLOUDFLARE_R2_BUCKET_NAME: string;
  readonly CLOUDFLARE_R2_PUBLIC_URL: string;
  readonly DISCORD_SHOW_AND_TELL_WEBHOOK_URL: string;
  readonly NOTION_WEBHOOK_SECRET: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
