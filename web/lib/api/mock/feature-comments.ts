/**
 * Comments on a feature (#1553), as api/oracle/comments/router.py: everyone who can open the
 * app reads and adds them; a person edits and deletes their own, an owner deletes any. A
 * comment hangs on the feature (its roadmap and key), so every row of it shows it and it
 * follows the feature to Trash and back.
 */
import type { Schemas } from '@/lib/api/client';

import { mockUuid } from './ids';
import { reply } from './typed';

export type FeatureCommentRow = {
  id: string;
  roadmap_id: string;
  key: string;
  author_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
};

const MAX_BODY = 2000;

type Who = { id: string; role: string };
type Feature = { roadmap_id: string; key: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function text(raw: unknown): string | Response {
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (!body) return json(422, { detail: 'Write something first' });
  if (body.length > MAX_BODY)
    return json(422, { detail: `A comment is at most ${MAX_BODY} characters` });
  return body;
}

function counts(rows: FeatureCommentRow[]): Response {
  const out = new Map<string, Schemas['FeatureCommentCount']>();
  for (const c of rows) {
    const k = `${c.roadmap_id}\n${c.key}`;
    const n = out.get(k) ?? { roadmap_id: c.roadmap_id, key: c.key, count: 0 };
    n.count += 1;
    out.set(k, n);
  }
  return reply('/v1/simple/comment-counts', 'get', [...out.values()]);
}

const bodyOf = async (req: Request) =>
  text(((await req.json()) as { body?: unknown } | null)?.body);

async function onComment(
  rows: FeatureCommentRow[],
  c: FeatureCommentRow,
  me: Who,
  out: (c: FeatureCommentRow) => Schemas['FeatureCommentOut'],
  req: Request,
): Promise<Response | null> {
  const one = '/v1/simple/roadmap/items/{item_id}/comments/{comment_id}' as const;
  if (req.method === 'PATCH') {
    if (c.author_id !== me.id) return json(403, { detail: 'Only its author can edit a comment' });
    const body = await bodyOf(req);
    if (body instanceof Response) return body;
    c.body = body;
    c.edited_at = new Date().toISOString();
    return reply(one, 'patch', out(c));
  }
  if (req.method === 'DELETE') {
    if (c.author_id !== me.id && me.role !== 'owner')
      return json(403, { detail: 'Only its author or an owner can delete it' });
    rows.splice(rows.indexOf(c), 1);
    return reply(one, 'delete', undefined, 204);
  }
  return null;
}

/** Answers the comment routes (p: the path's parts), or null for another route. */
export async function routeFeatureComments(
  rows: FeatureCommentRow[],
  me: Who,
  nameOf: (id: string) => string,
  featureOf: (itemId: string) => Promise<Feature | null>,
  req: Request,
  p: string[],
): Promise<Response | null> {
  if (p[1] !== 'simple') return null;
  if (p[2] === 'comment-counts' && !p[3] && req.method === 'GET') return counts(rows);
  if (p[2] !== 'roadmap' || p[3] !== 'items' || !p[4] || p[5] !== 'comments') return null;
  const feature = await featureOf(p[4]);
  if (!feature) return json(404, { detail: 'Feature not found' });
  const out = (c: FeatureCommentRow): Schemas['FeatureCommentOut'] => ({
    id: c.id,
    author: { id: c.author_id, name: nameOf(c.author_id) },
    body: c.body,
    created_at: c.created_at,
    edited_at: c.edited_at,
    can_edit: c.author_id === me.id,
    can_delete: c.author_id === me.id || me.role === 'owner',
  });
  const mine = rows.filter((c) => c.roadmap_id === feature.roadmap_id && c.key === feature.key);
  if (p[6]) {
    const c = mine.find((x) => x.id === p[6]);
    return c ? onComment(rows, c, me, out, req) : json(404, { detail: 'Comment not found' });
  }
  const path = '/v1/simple/roadmap/items/{item_id}/comments' as const;
  if (req.method === 'GET') return reply(path, 'get', mine.map(out));
  if (req.method !== 'POST') return null;
  const body = await bodyOf(req);
  if (body instanceof Response) return body;
  const row: FeatureCommentRow = {
    id: mockUuid(),
    ...feature,
    author_id: me.id,
    body,
    created_at: new Date().toISOString(),
    edited_at: null,
  };
  rows.push(row);
  return reply(path, 'post', out(row), 201);
}
