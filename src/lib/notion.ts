import { Client } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';

const notion = new Client({ auth: import.meta.env.NOTION_API_KEY });

// ── Helpers ──────────────────────────────────────────────────────────────────

function getText(page: PageObjectResponse, prop: string): string {
  const p = page.properties[prop];
  if (!p) return '';
  switch (p.type) {
    case 'title':     return p.title[0]?.plain_text ?? '';
    case 'rich_text': return p.rich_text[0]?.plain_text ?? '';
    case 'url':       return p.url ?? '';
    case 'select':    return p.select?.name ?? '';
    default:          return '';
  }
}

function getNumber(page: PageObjectResponse, prop: string): number {
  const p = page.properties[prop];
  if (!p || p.type !== 'number') return 0;
  return p.number ?? 0;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MakerApp {
  name: string;
  description: string;
  url: string;
  icon: string;
  color: string;
  gradient: string;
  order: number;
}

export interface InvolvedCard {
  name: string;
  description: string;
  url: string;
  linkText: string;
  icon: string;
  colorTheme: string;
  badge: string;
  order: number;
}

export interface CommunityResource {
  name: string;
  description: string;
  url: string;
  icon: string;
  colorTheme: string;
  order: number;
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

export async function getMakerApps(): Promise<MakerApp[]> {
  const response = await notion.databases.query({
    database_id: import.meta.env.NOTION_MAKER_APPS_DB_ID,
    filter: { property: 'Active', checkbox: { equals: true } },
    sorts: [{ property: 'Order', direction: 'ascending' }],
  });
  return (response.results as PageObjectResponse[]).map((page) => ({
    name:        getText(page, 'Name'),
    description: getText(page, 'Description'),
    url:         getText(page, 'URL'),
    icon:        getText(page, 'Icon'),
    color:       getText(page, 'Color'),
    gradient:    getText(page, 'Gradient'),
    order:       getNumber(page, 'Order'),
  }));
}

export async function getInvolvedCards(): Promise<InvolvedCard[]> {
  const response = await notion.databases.query({
    database_id: import.meta.env.NOTION_GET_INVOLVED_DB_ID,
    filter: { property: 'Active', checkbox: { equals: true } },
    sorts: [{ property: 'Order', direction: 'ascending' }],
  });
  return (response.results as PageObjectResponse[]).map((page) => ({
    name:        getText(page, 'Name'),
    description: getText(page, 'Description'),
    url:         getText(page, 'URL'),
    linkText:    getText(page, 'Link Text'),
    icon:        getText(page, 'Icon'),
    colorTheme:  getText(page, 'Color Theme'),
    badge:       getText(page, 'Badge'),
    order:       getNumber(page, 'Order'),
  }));
}

export async function getCommunityResources(): Promise<CommunityResource[]> {
  const response = await notion.databases.query({
    database_id: import.meta.env.NOTION_COMMUNITY_RESOURCES_DB_ID,
    filter: { property: 'Active', checkbox: { equals: true } },
    sorts: [{ property: 'Order', direction: 'ascending' }],
  });
  return (response.results as PageObjectResponse[]).map((page) => ({
    name:        getText(page, 'Name'),
    description: getText(page, 'Description'),
    url:         getText(page, 'URL'),
    icon:        getText(page, 'Icon'),
    colorTheme:  getText(page, 'Color Theme'),
    order:       getNumber(page, 'Order'),
  }));
}

// ── Show & Tell ───────────────────────────────────────────────────────────────

export interface ShowAndTellSubmission {
  id: string;
  name: string;
  description: string;
  photoUrl: string;
  modelSource: string;
  submitter: string;
  source: string;
  submitted: string;
  mastodonHandle: string;
  blueskyHandle: string;
  threadsHandle: string;
}

export async function getShowAndTellSubmissions(): Promise<ShowAndTellSubmission[]> {
  const response = await notion.databases.query({
    database_id: import.meta.env.NOTION_SHOW_AND_TELL_DB_ID,
    filter: { property: 'Approved', checkbox: { equals: true } },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  });
  return (response.results as PageObjectResponse[]).map((page) => ({
    id:          page.id,
    name:        getText(page, 'Name'),
    description: getText(page, 'Description'),
    photoUrl:    getText(page, 'Photo URL'),
    modelSource: getText(page, 'Model Source'),
    submitter:   getText(page, 'Submitter'),
    source:      getText(page, 'Source'),
    submitted:   (page.properties['Submitted'] as any)?.created_time ?? '',
  }));
}
