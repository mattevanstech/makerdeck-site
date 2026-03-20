/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly NOTION_API_KEY: string;
  readonly NOTION_MAKER_APPS_DB_ID: string;
  readonly NOTION_GET_INVOLVED_DB_ID: string;
  readonly NOTION_COMMUNITY_RESOURCES_DB_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
