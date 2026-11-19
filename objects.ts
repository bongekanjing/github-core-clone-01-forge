// The git object layer: SHA-1 addressed blobs, trees, commits and annotated tags, kept in one
// in-process store, plus the zlib and hashing the smart-HTTP protocol needs. Nothing here imports
// a git binary: every object is hashed, parsed and rebuilt from bytes on its own.
//
// An object id is sha1('<type> <byte length>\0' || payload), the loose-object framing git uses, so
// a store that keeps the framing verbatim reproduces the ids the suite recomputes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The four object types a forge stores. */
export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

/** One stored object: its type and its raw payload, without the '<type> <len>\0' header. */
export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

// ----------------------------------------------------------------------------- hashing

/** sha1 of an object's framed bytes: the id git gives it. */
export function hashObject(type: ObjectType, data: Buffer): string {
  return createHash('sha1').update(frame(type, data)).digest('hex');
}

/** The loose-object bytes: '<type> <decimal length>\0' then the payload. */
export function frame(type: ObjectType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'binary'), data]);
}

/** Split loose-object bytes into its type and payload; null when the header does not parse. */
export function unframe(raw: Buffer): GitObject | null {
  const nul = raw.indexOf(0);
  if (nul < 0) return null;
  const header = raw.subarray(0, nul).toString('binary');
  const space = header.indexOf(' ');
  if (space < 0) return null;
  const type = header.slice(0, space);
  const length = Number(header.slice(space + 1));
  if (type !== 'blob' && type !== 'tree' && type !== 'commit' && type !== 'tag') return null;
  if (!Number.isInteger(length) || length < 0) return null;
  const data = raw.subarray(nul + 1);
  if (data.length !== length) return null;
  return { type: type as ObjectType, data };
}

// ----------------------------------------------------------------------------- tree entries

/** One entry of a tree object: a mode, a name and the id it points at. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

/** A tree's payload: em-dash separated by its own binary framing, '<mode> <name>\0<20 bytes>'. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'binary'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree payload; a malformed entry ends the parse and keeps what read. */
export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < payload.length) {
    const nul = payload.indexOf(0, at);
    if (nul < 0 || nul + 21 > payload.length) break;
    const header = payload.subarray(at, nul).toString('binary');
    const space = header.indexOf(' ');
    if (space < 0) break;
    entries.push({
      mode: header.slice(0, space),
      name: header.slice(space + 1),
      sha: payload.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

/** The order git sorts tree entries in: a directory sorts as if its name ended in '/'. */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((left, right) => compareTreeNames(left, right));
}

function compareTreeNames(left: TreeEntry, right: TreeEntry): number {
  const a = left.mode === '40000' ? `${left.name}/` : left.name;
  const b = right.mode === '40000' ? `${right.name}/` : right.name;
  return Buffer.compare(Buffer.from(a, 'binary'), Buffer.from(b, 'binary'));
}

// ----------------------------------------------------------------------------- commit and tag

/** A commit's fields, as git writes them. */
export interface CommitFields {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** A commit payload: tree, parents, author, committer, then the message after a blank line. */
export function buildCommit(fields: CommitFields): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a commit payload's tree, parents and message; unknown headers are ignored. */
export function parseCommit(payload: Buffer): { tree: string; parents: string[]; message: string } {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** A tag payload: object, type, tag, tagger, then the message. */
export function buildTag(fields: { object: string; type: ObjectType; tag: string; tagger: string; message: string }): Buffer {
  const lines = [`object ${fields.object}`, `type ${fields.type}`, `tag ${fields.tag}`, `tagger ${fields.tagger}`, '', fields.message];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a tag payload's target and its history: the object it names. */
export function parseTag(payload: Buffer): { object: string; objectType: string; tag: string } {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  let object = '';
  let objectType = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) objectType = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, objectType, tag };
}

// ----------------------------------------------------------------------------- typography

export { deflateSync, inflateSync };
