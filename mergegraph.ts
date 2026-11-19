// Merging two lines of history: the one place a pull request's merge is computed, so the REST route
// and the MCP tool cannot drift apart. A merge is refused when both sides changed the same path away
// from their common ancestor — the same test git makes — and otherwise lands every changed path of
// the head onto the base in one commit with the base tip as its first parent.

import type { Repo } from './store.ts';
import { commitInfo, commitTreeOnly, createCommit, flattenTree } from './store.ts';

/** A path's blob id and mode, or null when the path is gone. */
type Entry = { mode: string; sha: string };

/** The newest commit both tips share, or null when they share no history. */
export function mergeBase(repo: Repo, left: string, right: string): string | null {
  const ancestors = new Set<string>();
  const queue = [left];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (ancestors.has(sha)) continue;
    ancestors.add(sha);
    const info = commitInfo(repo, sha);
    if (info === null) continue;
    for (const parent of info.parents) queue.push(parent);
  }
  const visit = [right];
  const seen = new Set<string>();
  while (visit.length > 0) {
    const sha = visit.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestors.has(sha)) return sha;
    const info = commitInfo(repo, sha);
    if (info === null) continue;
    for (const parent of info.parents) visit.push(parent);
  }
  return null;
}

/** True when `older` is `newer` or one of its ancestors: the fast-forward test. */
export function isAncestor(repo: Repo, older: string, newer: string): boolean {
  if (older === newer) return true;
  const seen = new Set<string>();
  const queue = [newer];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const info = commitInfo(repo, sha);
    if (info === null) continue;
    if (info.parents.includes(older)) return true;
    for (const parent of info.parents) queue.push(parent);
  }
  return false;
}

/**
 * Merge `headSha` onto `baseSha` and answer the merge commit's id, or null when the two histories
 * conflict. The base branch ref is moved by the caller (the store owns refs).
 */
export function mergeBranches(repo: Repo, headSha: string, baseSha: string, message: string): string | null {
  const headTree = commitInfo(repo, headSha)?.tree;
  const baseTree = commitInfo(repo, baseSha)?.tree;
  if (headTree === undefined || baseTree === undefined) return null;

  // A base that is already an ancestor of the head merges by fast-forward: the head becomes the base.
  if (isAncestor(repo, baseSha, headSha)) {
    repo.refs.set(`refs/heads/${branchOf(repo, baseSha)}`, headSha);
    return headSha;
  }

  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const ancestor = mergeBase(repo, headSha, baseSha);
  const root = ancestor === null ? new Map<string, Entry>() : flattenTree(repo, commitInfo(repo, ancestor)?.tree as string);

  // A path both sides changed away from the ancestor, differently, is the conflict.
  for (const path of new Set([...base.keys(), ...head.keys()])) {
    const ours = base.get(path);
    const theirs = head.get(path);
    const original = root.get(path);
    const oursSha = ours?.sha ?? null;
    const theirsSha = theirs?.sha ?? null;
    const originalSha = original?.sha ?? null;
    if (oursSha === theirsSha) continue;
    const weChanged = oursSha !== originalSha;
    const theyChanged = theirsSha !== originalSha;
    if (weChanged && theyChanged) return null;
  }

  // Everything the head adds or changes over the ancestor lands on the base.
  const changes = new Map<string, Buffer | null>();
  for (const [path, entry] of head) {
    const original = root.get(path)?.sha ?? null;
    if (entry.sha !== original) changes.set(path, readBlob(repo, entry.sha));
  }
  for (const path of root.keys()) {
    if (!head.has(path)) changes.set(path, null);
  }

  const tree = commitTreeOnly(repo, baseSha, changes);
  const parents = ancestor === baseSha ? [baseSha, headSha] : [baseSha, headSha];
  return createCommit(repo, { tree, parents, message, authorEpoch: repo.clock.epoch() });
}

/** The branch a commit is the tip of, else the default branch: the ref a merge advances. */
function branchOf(repo: Repo, sha: string): string {
  for (const [ref, value] of repo.refs) {
    if (value === sha && ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  }
  return repo.defaultBranch;
}

/** A blob's bytes, empty when the object is not a blob here. */
function readBlob(repo: Repo, sha: string): Buffer {
  const object = repo.objects.get(sha);
  return object === undefined ? Buffer.alloc(0) : object.data;
}
