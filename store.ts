// The forge's state: repositories, their refs and object graphs, and the issue and pull-request
// records on top. One process serves every check from here, so this file owns the invariants:
//
//   - a repository belongs to a login; the same name under another login is a different address
//     that does not exist, never a forbidden one;
//   - an object is stored by type and payload, addressed by its sha1, so the same bytes reached by
//     a REST contents commit or by a smart-HTTP push are one object with one id;
//   - every ref points at a commit that exists, and a commit's tree is walked from the tip.
//
// Timestamps come from the store's clock, which a trial can pin so two runs on one instance write
// the same bytes (the replay check compares state.json byte for byte).

import { randomUUID } from 'node:crypto';
import {
  type CommitFields,
  type GitObject,
  type ObjectType,
  type TreeEntry,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  sortTreeEntries,
} from './objects.ts';

/** A stored object, its payload as it arrived, and the ids it is known by. */
interface StoredObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

/** One repository record: its metadata, refs and object graph. */
export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** refs/heads/... and refs/tags/...: a full ref name to the commit (or tag object) it holds. */
  refs: Map<string, string>;
  objects: Map<string, StoredObject>;
  /** A tree-less commit id for an unborn repository: null until the first commit. */
  emptyCommit: string | null;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, IssueComment>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  nextLabel: number;
  /** The forge's clock: pinned when a trial needs byte-identical exports. */
  clock: Clock;
}

/** A label record: issues may only carry one this repository created. */
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

/** An issue record, open or closed. */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: number;
}

/** One comment on an issue. */
export interface IssueComment {
  id: number;
  issue: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

/** A pull request record, open, closed or merged. */
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  /** The head branch as it was when the pull was opened: a later push does not move it. */
  headShaAtOpen: string | null;
}

/** The store's clock: pinned to one instant when a trial needs byte-identical exports. */
export class Clock {
  private fixed: number | null = null;
  private step = 0;

  /** Freeze the clock at `epochMs`, one second apart per read, so a run is reproducible. */
  pin(epochMs: number): void {
    this.fixed = epochMs;
    this.step = 0;
  }

  /** The current instant as an ISO 8601 string, second precision, in UTC. */
  now(): string {
    if (this.fixed === null) return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    this.step += 1;
    return new Date(this.fixed + this.step * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Seconds since the epoch, as git writes an identity's time. */
  epoch(): number {
    if (this.fixed === null) return Math.floor(Date.now() / 1000);
    this.step += 1;
    return Math.floor(this.fixed / 1000) + this.step;
  }
}

/** The whole forge: repositories by id, by owner/name, and the counters that name them. */
export class Forge {
  readonly clock = new Clock();
  readonly repos = new Map<number, Repo>();
  /** `owner/name` in lower case, the one address a repository has. */
  readonly byPath = new Map<string, Repo>();
  /** The login the bearer token names: the owner of every repository this process serves. */
  readonly login: string;
  private nextRepo = 1000;

  constructor(login: string) {
    this.login = login;
  }

  /** The address key `owner/name` uses. */
  static key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  /** A repository at `owner/name`, or null: an absent one and a foreign owner's one are both null. */
  find(owner: string, name: string): Repo | null {
    const repo = this.byPath.get(Forge.key(owner, name)) ?? null;
    if (repo === null) return null;
    // A repository belongs to the token's login: another owner's name is a 404, never a 403.
    return repo.owner.toLowerCase() === owner.toLowerCase() ? repo : null;
  }

  /** Create a repository owned by this login; null when the name is taken. */
  create(name: string, options: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repo | null {
    const key = Forge.key(this.login, name);
    if (this.byPath.has(key)) return null;
    const at = this.clock.now();
    const repo: Repo = {
      id: this.nextRepo++,
      owner: this.login,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: at,
      updatedAt: at,
      refs: new Map(),
      objects: new Map(),
      emptyCommit: null,
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      nextLabel: 1,
      clock: this.clock,
    };
    this.repos.set(repo.id, repo);
    this.byPath.set(key, repo);
    return repo;
  }

  /** Remove a repository and everything under it. */
  destroy(repo: Repo): void {
    this.repos.delete(repo.id);
    this.byPath.delete(Forge.key(repo.owner, repo.name));
  }

  /** The repositories this login owns, oldest first (the order pagination walks). */
  list(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner.toLowerCase() === this.login.toLowerCase())
      .sort((left, right) => left.id - right.id);
  }
}

// ----------------------------------------------------------------------------- objects

/** Store an object's payload and answer its id; the same bytes always store once. */
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

/** One object by id, or null when the repository does not hold it. */
export function getObject(repo: Repo, sha: string): GitObject | null {
  const stored = repo.objects.get(sha);
  return stored === undefined ? null : { type: stored.type, data: stored.data };
}

/** The type of a stored object, or null. */
export function objectType(repo: Repo, sha: string): ObjectType | null {
  return repo.objects.get(sha)?.type ?? null;
}

/** Peel an id to a commit: a tag object is followed to what it names. */
export function peelToCommit(repo: Repo, sha: string): string | null {
  let at = sha;
  for (let hop = 0; hop < 8; hop += 1) {
    const object = getObject(repo, at);
    if (object === null) return null;
    if (object.type === 'commit') return at;
    if (object.type !== 'tag') return null;
    at = parseTagObject(object.data).object;
  }
  return null;
}

/** Re-exported so callers need one import for tag parsing. */
function parseTagObject(data: Buffer): { object: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  let object = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
  }
  return { object };
}

/** A commit's tree and parents. */
export function commitInfo(repo: Repo, sha: string): { tree: string; parents: string[]; message: string } | null {
  const object = getObject(repo, sha);
  if (object === null || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

// ----------------------------------------------------------------------------- trees and paths

/** Flatten a tree into path -> {mode, sha}, walking sub-trees. */
export function flattenTree(repo: Repo, treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
  const files = new Map<string, { mode: string; sha: string }>();
  const object = getObject(repo, treeSha);
  if (object === null || object.type !== 'tree') return files;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [inner, value] of flattenTree(repo, entry.sha, path)) files.set(inner, value);
    } else {
      files.set(path, { mode: entry.mode, sha: entry.sha });
    }
  }
  return files;
}

/**
 * Rebuild the trees on a path from a flat file map, answering the new root tree id. Every
 * directory on the way is rewritten; a directory left empty disappears, as git drops it.
 */
export function writeTreeFromFiles(repo: Repo, files: Map<string, { mode: string; sha: string }>): string {
  interface Node {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of files) {
    const parts = path.split('/').filter((part) => part !== '');
    let node = root;
    for (let at = 0; at < parts.length - 1; at += 1) {
      const part = parts[at] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    const leaf = parts[parts.length - 1] as string;
    node.files.set(leaf, value);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, sha: value.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: write(child) });
    return putObject(repo, 'tree', buildTree(sortTreeEntries(entries)));
  };
  return write(root);
}

// ----------------------------------------------------------------------------- commits

/** A committer or author line: `Name <email> <epoch> <+0000>`. */
export function identity(name: string, email: string, epoch: number): string {
  return `${name} <${email}> ${epoch} +0000`;
}

export interface CreateCommitOptions {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly authorEpoch?: number;
  readonly committerName?: string;
  readonly committerEmail?: string;
  readonly committerEpoch?: number;
}

/** Write one commit object and answer its id. */
export function createCommit(repo: Repo, options: CreateCommitOptions): string {
  const epoch = options.authorEpoch ?? repo.id * 0 + 1_700_000_000;
  const fields: CommitFields = {
    tree: options.tree,
    parents: options.parents,
    author: identity(options.authorName ?? 'makefun', options.authorEmail ?? 'bot@makefun.invalid', options.authorEpoch ?? epoch),
    committer: identity(
      options.committerName ?? options.authorName ?? 'makefun',
      options.committerEmail ?? options.authorEmail ?? 'bot@makefun.invalid',
      options.committerEpoch ?? epoch,
    ),
    message: options.message,
  };
  return putObject(repo, 'commit', buildCommit(fields));
}

/**
 * Commit a set of file changes on top of `parent` (null for a first commit) and move `ref` to it.
 * `changes` maps a path to its new bytes, or null to delete it. Answers the commit id.
 */
export function commitFiles(
  repo: Repo,
  ref: string | null,
  parent: string | null,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
  when?: { name: string; email: string; epoch: number },
): string {
  const parentTree = parent === null ? null : commitInfo(repo, parent)?.tree ?? null;
  const files = new Map<string, { mode: string; sha: string }>();
  if (parentTree !== null) {
    for (const [path, value] of flattenTree(repo, parentTree)) files.set(path, value);
  }
  for (const [path, content] of changes) {
    if (content === null) {
      files.delete(path);
      continue;
    }
    files.set(path, { mode: '100644', sha: putObject(repo, 'blob', content) });
  }
  const tree = writeTreeFromFiles(repo, files);
  const epoch = when?.epoch ?? 1_700_000_000;
  const sha = createCommit(repo, {
    tree,
    parents: parent === null ? [] : [parent],
    message,
    authorName: when?.name,
    authorEmail: when?.email,
    authorEpoch: epoch,
    committerName: when?.name,
    committerEmail: when?.email,
    committerEpoch: epoch,
  });
  if (ref !== null) repo.refs.set(ref, sha);
  return sha;
}

/**
 * Write the tree a set of changes makes on top of `parent` (null for a first tree) and answer its
 * id, without writing a commit or moving a ref. A merge needs the tree before its parents are known.
 */
export function commitTreeOnly(
  repo: Repo,
  parent: string | null,
  changes: ReadonlyMap<string, Buffer | null>,
  _when?: { name: string; email: string; epoch: number },
): string {
  const parentTree = parent === null ? null : commitInfo(repo, parent)?.tree ?? null;
  const files = new Map<string, { mode: string; sha: string }>();
  if (parentTree !== null) {
    for (const [path, value] of flattenTree(repo, parentTree)) files.set(path, value);
  }
  for (const [path, content] of changes) {
    if (content === null) {
      files.delete(path);
      continue;
    }
    files.set(path, { mode: '100644', sha: putObject(repo, 'blob', content) });
  }
  return writeTreeFromFiles(repo, files);
}

// ----------------------------------------------------------------------------- refs
/** `refs/heads/main` for a branch name that is already a full ref. */
export function headRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

/** The short name of a full ref: `refs/heads/main` -> `main`. */
export function shortRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** The commit a ref or branch name resolves to, peeled through tags; null when absent. */
export function resolveRef(repo: Repo, name: string): string | null {
  const direct = repo.refs.get(name) ?? repo.refs.get(headRef(name));
  if (direct !== undefined) return direct;
  return null;
}

/** The peeled commit a ref names, or null. */
export function resolveCommit(repo: Repo, name: string): string | null {
  const target = resolveRef(repo, name);
  return target === null ? null : peelToCommit(repo, target);
}

/** Every ref of the repository, sorted by name, with tag objects peeled to their commit. */
export function allRefs(repo: Repo): { ref: string; sha: string; peeled: string | null }[] {
  return [...repo.refs.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([ref, sha]) => ({
      ref,
      sha,
      peeled: objectType(repo, sha) === 'tag' ? peelToCommit(repo, sha) : null,
    }));
}

/** A fresh numeric id for a record only this store mints. */
export function freshId(): number {
  return Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 12), 16);
}
