// The GraphQL v4 surface at POST /api/graphql: the documents gh and github-mcp-server actually send,
// executed against the same store the REST and git surfaces read. A document is parsed (fields,
// aliases, arguments with variables and inline objects/lists, inline fragments) and resolved, so any
// selection shape works — not a match on the fixed texts the suite happens to use.
//
// A field the schema does not hold is an `errors` entry naming it, with HTTP 200: that is GraphQL's
// own way of saying "bad query", and the introspection check depends on the wording carrying the
// field's name.

import type { Forge, Issue, Pull, Repo } from './store.ts';
import { commitInfo, flattenTree, resolveCommit } from './store.ts';
import { mergeRecord } from './mcp.ts';

// ----------------------------------------------------------------------------- lexer

/** One token: a name, a number, a string, punctuation, or a spread. */
interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
  at: number;
}

/** A document that does not parse: reported as one GraphQL error. */
export class GraphQLError extends Error {}

/** Split a document into tokens, dropping whitespace, commas and comments as GraphQL does. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '\ufeff') {
      at += 1;
      continue;
    }
    if (char === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (char === '.' && source.slice(at, at + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...', at });
      at += 3;
      continue;
    }
    if ('{}()[]:=$!|&@'.includes(char)) {
      tokens.push({ kind: 'punct', value: char, at });
      at += 1;
      continue;
    }
    if (char === '"') {
      // A block string ("""...""") is still a string for our purposes.
      if (source.slice(at, at + 3) === '"""') {
        const end = source.indexOf('"""', at + 3);
        if (end < 0) throw new GraphQLError('Unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(at + 3, end), at });
        at = end + 3;
        continue;
      }
      let value = '';
      let cursor = at + 1;
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === '\\') {
          const next = source[cursor + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else if (next === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(cursor + 2, cursor + 6), 16));
            cursor += 4;
          } else value += next ?? '';
          cursor += 2;
          continue;
        }
        value += source[cursor];
        cursor += 1;
      }
      tokens.push({ kind: 'string', value, at });
      at = cursor + 1;
      continue;
    }
    if (/[-0-9]/.test(char)) {
      let cursor = at;
      let text = '';
      let isFloat = false;
      if (source[cursor] === '-') text += source[cursor++];
      while (cursor < source.length && /[0-9]/.test(source[cursor] as string)) text += source[cursor++];
      if (source[cursor] === '.') {
        isFloat = true;
        text += source[cursor++];
        while (cursor < source.length && /[0-9]/.test(source[cursor] as string)) text += source[cursor++];
      }
      if (source[cursor] === 'e' || source[cursor] === 'E') {
        isFloat = true;
        text += source[cursor++];
        if (source[cursor] === '+' || source[cursor] === '-') text += source[cursor++];
        while (cursor < source.length && /[0-9]/.test(source[cursor] as string)) text += source[cursor++];
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: text, at });
      at = cursor;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let cursor = at;
      let text = '';
      while (cursor < source.length && /[_0-9A-Za-z]/.test(source[cursor] as string)) text += source[cursor++];
      tokens.push({ kind: 'name', value: text, at });
      at = cursor;
      continue;
    }
    throw new GraphQLError(`Unexpected character ${JSON.stringify(char)} at ${at}`);
  }
  return tokens;
}

// ----------------------------------------------------------------------------- ast

/** A field selection: its alias, name, arguments, directives and sub-selections. */
interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selections: Selection[];
}

/** An inline fragment: `... on Type { ... }`. */
interface FragmentNode {
  kind: 'fragment';
  on: string;
  selections: Selection[];
}

/** A fragment spread: `...Name` (resolved against the document's definitions). */
interface SpreadNode {
  kind: 'spread';
  name: string;
}

type Selection = FieldNode | FragmentNode | SpreadNode;

/** A literal or variable reference used as an argument value. */
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

/** One operation of a document. */
interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Map<string, { type: string; isList: boolean; required: boolean }>;
  selections: Selection[];
}

/** One parsed document: its operations and named fragments. */
interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentNode>;
}

/** A small recursive-descent parser over the token list. */
class Parser {
  private readonly tokens: Token[];
  private at = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new GraphQLError('Unexpected end of document');
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLError(`Expected ${JSON.stringify(value)} but found ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLError(`Expected a name but found ${JSON.stringify(token.value)}`);
    return token.value;
  }

  /** Parse the whole document. */
  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.at < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: new Map(), selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const onToken = this.expectName();
        if (onToken !== 'on') throw new GraphQLError(`Expected "on" in fragment ${name}`);
        const on = this.expectName();
        fragments.set(name, { kind: 'fragment', on, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = this.next().value as Operation['kind'];
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      throw new GraphQLError(`Unexpected token ${JSON.stringify(token.value)} at the top level`);
    }
    if (operations.length === 0) throw new GraphQLError('The document holds no operation');
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Map<string, { type: string; isList: boolean; required: boolean }> {
    const variables = new Map<string, { type: string; isList: boolean; required: boolean }>();
    if (this.peek()?.kind !== 'punct' || this.peek()?.value !== '(') return variables;
    this.next();
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      let type = '';
      let isList = false;
      while (this.peek()?.kind === 'punct' && (this.peek()?.value === '[' || this.peek()?.value === ']')) {
        if (this.peek()?.value === '[') isList = true;
        type += this.next().value;
      }
      if (this.peek()?.kind === 'name') type += this.next().value;
      while (this.peek()?.kind === 'punct' && (this.peek()?.value === '!' || this.peek()?.value === ']')) {
        const token = this.next();
        if (token.value === ']') isList = true;
        type += token.value;
      }
      const required = type.endsWith('!');
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
        this.next();
        this.parseValue();
      }
      variables.set(name, { type, isList, required });
      this.skipDirectives();
    }
    this.expectPunct(')');
    return variables;
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipParens();
    }
  }

  /** Skip a balanced parenthesis group. */
  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.peek() as Token;
      if (token.kind === 'spread') {
        this.next();
        if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
          this.next();
          const on = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'fragment', on, selections: this.parseSelectionSet() });
          continue;
        }
        const name = this.expectName();
        this.skipDirectives();
        selections.push({ kind: 'spread', name });
        continue;
      }
      selections.push(this.parseField());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections =
      this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLError(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ----------------------------------------------------------------------------- values

/** Resolve a value node against the request's variables, as plain JSON. */
function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = valueOf(value, variables);
      return out;
    }
    default:
      return null;
  }
}

/** Read an argument as a string. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Read an argument as an integer, accepting a numeric string. */
function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** True when a JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ----------------------------------------------------------------------------- global ids

/** A repository's global id. */
function repoGlobalId(repo: Repo): string {
  return `R_${repo.id}`;
}

/** An issue's global id. */
function issueGlobalId(repo: Repo, issue: Issue): string {
  return `I_${repo.id}_${issue.number}`;
}

/** A pull request's global id. */
function pullGlobalId(repo: Repo, pull: Pull): string {
  return `P_${repo.id}_${pull.number}`;
}

/** A comment's global id. */
function commentGlobalId(repo: Repo, id: number): string {
  return `IC_${repo.id}_${id}`;
}

/** The repository a global id names, or null. */
function repoOfId(forge: Forge, id: string): Repo | null {
  if (!id.startsWith('R_')) return null;
  const numeric = Number.parseInt(id.slice(2), 10);
  return forge.repos.get(numeric) ?? null;
}

/** The issue a global id names, with its repository, or null. */
function issueOfId(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const match = /^I_(\d+)_(\d+)$/.exec(id);
  if (match === null) return null;
  const repo = forge.repos.get(Number.parseInt(match[1] as string, 10));
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number.parseInt(match[2] as string, 10));
  return issue === undefined ? null : { repo, issue };
}

/** The pull request a global id names, with its repository, or null. */
function pullOfId(forge: Forge, id: string): { repo: Repo; pull: Pull } | null {
  const match = /^P_(\d+)_(\d+)$/.exec(id);
  if (match === null) return null;
  const repo = forge.repos.get(Number.parseInt(match[1] as string, 10));
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number.parseInt(match[2] as string, 10));
  return pull === undefined ? null : { repo, pull };
}

// ----------------------------------------------------------------------------- schema

/** The fields each introspectable type holds, in the order the real schema lists them. */
const TYPE_FIELDS_TABLE: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'mergeStateStatus',
    'isDraft', 'url', 'author', 'files', 'commits', 'createdAt', 'updatedAt', 'closedAt', 'repository',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url',
  ],
  User: ['id', 'login', 'name', 'url'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
};

/** The enum values each introspectable enum holds. */
const ENUM_VALUES_TABLE: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ----------------------------------------------------------------------------- execution

/** What one resolver call has to work with. */
interface ExecContext {
  readonly forge: Forge;
  readonly login: string;
  readonly variables: Record<string, unknown>;
  readonly parentType: string;
  readonly fragments: Map<string, FragmentNode>;
}

/** A resolved object: a field name to an already-resolved value, or a marker for a connection. */
type Resolved = Record<string, unknown>;

/** Execute one operation and answer its `data`. */
function executeOperation(document: Document, operation: Operation, context: ExecContext): Record<string, unknown> {
  return runSelectionSet(operation.selections, rootObject(operation.kind, context), context, 'Root');
}

/** The object a document's selections start from. */
function rootObject(kind: Operation['kind'], context: ExecContext): Resolved {
  return kind === 'mutation' ? mutationRoot(context) : queryRoot(context);
}

/** The query root's fields are resolved by name in `resolveQueryField`. */
function queryRoot(context: ExecContext): Resolved {
  return { __root: 'query', __context: context };
}

/** The mutation root. */
function mutationRoot(context: ExecContext): Resolved {
  return { __root: 'mutation', __context: context };
}

/** Run a selection set against a parent value, flattening fragments. */
function runSelectionSet(selections: readonly Selection[], parent: Resolved, context: ExecContext, parentType: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = context.fragments.get(selection.name);
      if (fragment === undefined) throw new GraphQLError(`Unknown fragment ${selection.name}`);
      if (!typeApplies(fragment.on, parentType)) continue;
      Object.assign(out, runSelectionSet(fragment.selections, parent, context, fragment.on));
      continue;
    }
    if (selection.kind === 'fragment') {
      if (!typeApplies(selection.on, parentType)) continue;
      Object.assign(out, runSelectionSet(selection.selections, parent, context, selection.on));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args = new Map<string, unknown>();
    for (const [name, node] of selection.args) args.set(name, valueOf(node, context.variables));
    if (selection.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    if (selection.name === '__type') {
      out[key] = introspect(args, selection, context);
      continue;
    }
    out[key] = resolveField(parent, parentType, selection, args, context);
  }
  return out;
}

/** Whether an inline fragment's type condition covers the parent's type. */
function typeApplies(condition: string, parentType: string): boolean {
  if (condition === parentType) return true;
  // An interface condition is satisfied by the concrete types that implement it.
  const interfaces: Record<string, string[]> = {
    Node: ['Repository', 'Issue', 'PullRequest', 'User'],
    RepositoryOwner: ['User'],
  };
  return (interfaces[condition] ?? []).includes(parentType);
}

/** Resolve one field of a parent object. */
function resolveField(parent: Resolved, parentType: string, field: FieldNode, args: Map<string, unknown>, context: ExecContext): unknown {
  const root = parent.__root;
  if (root === 'query') return resolveQueryField(field, args, context);
  if (root === 'mutation') return resolveMutationField(field, args, context);
  return resolveObjectField(parent, parentType, field, args, context);
}

// ----------------------------------------------------------------------------- root fields

/** The Query type's fields. */
function resolveQueryField(field: FieldNode, args: Map<string, unknown>, context: ExecContext): unknown {
  const { forge } = context;
  switch (field.name) {
    case 'viewer':
      return finish({ login: context.login, id: `U_${context.login}`, name: context.login }, field, context, 'User');
    case 'repository': {
      const repo = forge.find(asString(args.get('owner')), asString(args.get('name')));
      return repo === null ? null : finish(repoObject(repo, context), field, context, 'Repository');
    }
    case 'node': {
      const id = asString(args.get('id'));
      const repo = repoOfId(forge, id);
      if (repo !== null) return finish(repoObject(repo, context), field, context, 'Repository');
      const issue = issueOfId(forge, id);
      if (issue !== null) return finish(issueObject(issue.repo, issue.issue), field, context, 'Issue');
      const pull = pullOfId(forge, id);
      if (pull !== null) return finish(pullObject(pull.repo, pull.pull), field, context, 'PullRequest');
      return null;
    }
    case 'rateLimit':
      return finish({ limit: 5000, remaining: 5000, resetAt: '1970-01-01T00:00:00Z', cost: 0, used: 0 }, field, context, 'RateLimit');
    case 'license':
      return finish({ key: 'mit', name: 'MIT License', spdxId: 'MIT' }, field, context, 'License');
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`);
  }
}

/** The Mutation type's fields. */
function resolveMutationField(field: FieldNode, args: Map<string, unknown>, context: ExecContext): unknown {
  const input = isRecord(args.get('input')) ? (args.get('input') as Record<string, unknown>) : {};
  const { forge } = context;
  switch (field.name) {
    case 'createIssue': {
      const repo = repoOfId(forge, asString(input.repositoryId));
      if (repo === null) throw new GraphQLError('createIssue: repositoryId does not name a repository');
      const issue = createIssueIn(repo, context.login, asString(input.title), asString(input.body));
      return finish({ issue: issueObject(repo, issue), clientMutationId: null }, field, context, 'CreateIssuePayload');
    }
    case 'closeIssue': {
      const found = issueOfId(forge, asString(input.issueId));
      if (found === null) throw new GraphQLError('closeIssue: issueId does not name an issue');
      if (found.issue.state !== 'closed') {
        found.issue.state = 'closed';
        found.issue.closedAt = found.repo.clock.now();
        found.issue.updatedAt = found.issue.closedAt;
      }
      return finish({ issue: issueObject(found.repo, found.issue), clientMutationId: null }, field, context, 'CloseIssuePayload');
    }
    case 'reopenIssue': {
      const found = issueOfId(forge, asString(input.issueId));
      if (found === null) throw new GraphQLError('reopenIssue: issueId does not name an issue');
      found.issue.state = 'open';
      found.issue.closedAt = null;
      found.issue.updatedAt = found.repo.clock.now();
      return finish({ issue: issueObject(found.repo, found.issue), clientMutationId: null }, field, context, 'ReopenIssuePayload');
    }
    case 'createPullRequest': {
      const repo = repoOfId(forge, asString(input.repositoryId));
      if (repo === null) throw new GraphQLError('createPullRequest: repositoryId does not name a repository');
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName) || repo.defaultBranch;
      if (resolveCommit(repo, head) === null) throw new GraphQLError(`createPullRequest: head ${head} is not a branch here`);
      const at = repo.clock.now();
      const number = repo.nextPull++;
      const pull: Pull = {
        id: number * 1000 + repo.id,
        number,
        title: asString(input.title) || `${head} into ${base}`,
        body: asString(input.body),
        state: 'open',
        merged: false,
        head,
        base,
        user: context.login,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        mergedAt: null,
        mergeCommitSha: null,
        headShaAtOpen: resolveCommit(repo, head),
      };
      repo.pulls.set(number, pull);
      return finish({ pullRequest: pullObject(repo, pull), clientMutationId: null }, field, context, 'CreatePullRequestPayload');
    }
    case 'mergePullRequest': {
      const found = pullOfId(forge, asString(input.pullRequestId));
      if (found === null) throw new GraphQLError('mergePullRequest: pullRequestId does not name a pull request');
      const sha = mergeRecord(found.repo, found.pull.number);
      if (sha === null) throw new GraphQLError('mergePullRequest: the pull request cannot be merged');
      return finish({ pullRequest: pullObject(found.repo, found.pull), clientMutationId: null }, field, context, 'MergePullRequestPayload');
    }
    case 'addComment': {
      const subjectId = asString(input.subjectId);
      const body = asString(input.body);
      const found = issueOfId(forge, subjectId) ?? pullOfIdAsIssue(forge, subjectId);
      if (found === null) throw new GraphQLError('addComment: subjectId does not name a commentable subject');
      const at = found.repo.clock.now();
      const id = found.repo.nextComment++;
      found.repo.comments.set(id, { id, issue: found.issue.number, body, user: context.login, createdAt: at, updatedAt: at });
      found.issue.comments += 1;
      found.issue.updatedAt = at;
      return finish(
        { commentEdge: { node: { id: commentGlobalId(found.repo, id), body, createdAt: at, author: { login: context.login } } }, clientMutationId: null },
        field,
        context,
        'AddCommentPayload',
      );
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

/** A pull request treated as a commentable subject, since comments are stored per issue number. */
function pullOfIdAsIssue(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const found = pullOfId(forge, id);
  if (found === null) return null;
  // A pull request's number is its own: the store keeps comments keyed by issue number, so a pull
  // comment gets a synthetic issue record only when the numbers collide. GitHub shares the space;
  // here the pull's own record carries the count.
  const issue: Issue = {
    id: found.pull.id,
    number: found.pull.number,
    title: found.pull.title,
    body: found.pull.body,
    state: found.pull.state === 'open' ? 'open' : 'closed',
    labels: [],
    user: found.pull.user,
    createdAt: found.pull.createdAt,
    updatedAt: found.pull.updatedAt,
    closedAt: found.pull.closedAt,
    comments: 0,
  };
  if (!found.repo.issues.has(issue.number)) found.repo.issues.set(issue.number, issue);
  return { repo: found.repo, issue: found.repo.issues.get(issue.number) as Issue };
}

/** Create an issue on a repository, the one place a GraphQL create lands. */
function createIssueIn(repo: Repo, login: string, title: string, body: string): Issue {
  const at = repo.clock.now();
  const issue: Issue = {
    id: repo.nextIssue * 1000 + repo.id,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [],
    user: login,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    comments: 0,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

// ----------------------------------------------------------------------------- object fields

/** A repository's resolved object. */
function repoObject(repo: Repo, context: ExecContext): Resolved {
  void context;
  return {
    __type: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    isPrivate: repo.private,
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    url: '',
    __repo: repo,
  };
}

/** An issue's resolved object. */
function issueObject(repo: Repo, issue: Issue): Resolved {
  return {
    __type: 'Issue',
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: '',
    author: { login: issue.user },
    labels: { nodes: issue.labels.map((label) => ({ name: label.name, color: label.color })) },
    comments: { totalCount: issue.comments },
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    repository: repoObject(repo, null as unknown as ExecContext),
    __repo: repo,
    __issue: issue,
  };
}

/** A pull request's resolved object. */
function pullObject(repo: Repo, pull: Pull): Resolved {
  const headSha = resolveCommit(repo, pull.head);
  const baseSha = resolveCommit(repo, pull.base);
  const mergeable = pull.merged ? 'UNKNOWN' : conflictBetween(repo, headSha, baseSha) ? 'CONFLICTING' : 'MERGEABLE';
  return {
    __type: 'PullRequest',
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable,
    mergeStateStatus: mergeable === 'CONFLICTING' ? 'DIRTY' : 'CLEAN',
    isDraft: false,
    url: '',
    author: { login: pull.user },
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt,
    repository: repoObject(repo, null as unknown as ExecContext),
    __repo: repo,
    __pull: pull,
  };
}

/** Whether two branches changed the same path away from their common ancestor. */
function conflictBetween(repo: Repo, headSha: string | null, baseSha: string | null): boolean {
  if (headSha === null || baseSha === null) return false;
  const headTree = commitInfo(repo, headSha)?.tree;
  const baseTree = commitInfo(repo, baseSha)?.tree;
  if (headTree === undefined || baseTree === undefined) return false;
  const head = flattenTree(repo, headTree);
  const base = flattenTree(repo, baseTree);
  for (const [path, entry] of head) {
    const other = base.get(path);
    if (other !== undefined && other.sha !== entry.sha) {
      // A path that differs between two tips is only a conflict when both moved; a tree walk alone
      // cannot tell, so compare against the merge base.
      return changedSinceBase(repo, path, headSha, baseSha);
    }
  }
  return false;
}

/** Whether both tips changed `path` away from their merge base. */
function changedSinceBase(repo: Repo, path: string, headSha: string, baseSha: string): boolean {
  const base = commonAncestorCommit(repo, headSha, baseSha);
  if (base === null) return false;
  const baseTree = commitInfo(repo, base)?.tree;
  if (baseTree === undefined) return false;
  const original = flattenTree(repo, baseTree).get(path)?.sha ?? null;
  const headEntry = flattenTree(repo, commitInfo(repo, headSha)?.tree as string).get(path)?.sha ?? null;
  const baseEntry = flattenTree(repo, commitInfo(repo, baseSha)?.tree as string).get(path)?.sha ?? null;
  return headEntry !== original && baseEntry !== original;
}

/** The newest commit two tips share. */
function commonAncestorCommit(repo: Repo, left: string, right: string): string | null {
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

/** The fields of a non-root object. */
function resolveObjectField(parent: Resolved, parentType: string, field: FieldNode, args: Map<string, unknown>, context: ExecContext): unknown {
  const type = typeof parent.__type === 'string' ? (parent.__type as string) : parentType;

  // A connection field: the parent names a repository and the field names the collection.
  if (type === 'Repository') {
    const repo = parent.__repo as Repo;
    if (field.name === 'issue') {
      const number = asInt(args.get('number'));
      const issue = number === null ? undefined : repo.issues.get(number);
      if (issue === undefined) return null;
      return finish(issueObject(repo, issue), field, context, 'Issue');
    }
    if (field.name === 'issues') return finish(issueConnection(repo, args, context), field, context, 'IssueConnection');
    if (field.name === 'pullRequests') return finish(pullConnection(repo, args, context), field, context, 'PullRequestConnection');
    if (field.name === 'pullRequest') {
      const number = asInt(args.get('number'));
      const pull = number === null ? undefined : repo.pulls.get(number);
      if (pull === undefined) return null;
      return finish(pullObject(repo, pull), field, context, 'PullRequest');
    }
  }

  if (type === 'PullRequest') {
    const repo = parent.__repo as Repo;
    const pull = parent.__pull as Pull;
    if (field.name === 'files') {
      const first = asInt(args.get('first')) ?? 100;
      return finish(changedFiles(repo, pull, first), field, context, 'PullRequestChangedFileConnection');
    }
    if (field.name === 'commits') {
      const headSha = resolveCommit(repo, pull.head);
      return finish({ totalCount: headSha === null ? 0 : 1, nodes: [] }, field, context, 'PullRequestCommitConnection');
    }
  }

  // Every other field is a plain value already resolved on the parent, possibly with a sub-selection.
  const value = parent[field.name];
  if (value === undefined) {
    if (TYPE_FIELDS_TABLE[type] !== undefined && !TYPE_FIELDS_TABLE[type].includes(field.name)) {
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${type}".`);
    }
    return null;
  }
  return finish(value, field, context, guessType(value));
}

/** A rough type name for a nested value, so inline fragments and `__typename` work. */
function guessType(value: unknown): string {
  if (isRecord(value) && typeof value.__type === 'string') return value.__type as string;
  return 'Object';
}

/** Finish a value: descend into its selection set, or leave it as is for a leaf. */
function finish(value: unknown, field: FieldNode, context: ExecContext, type: string): unknown {
  if (field.selections.length === 0) {
    return leaf(value);
  }
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => (isRecord(item) ? runSelectionSet(field.selections, item as Resolved, context, guessType(item)) : null));
  if (isRecord(value)) return runSelectionSet(field.selections, value as Resolved, context, type);
  return leaf(value);
}

/** A scalar as JSON: Date objects become ISO strings, undefined becomes null. */
function leaf(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('__')) continue;
      out[key] = leaf(inner);
    }
    return out;
  }
  return value;
}

// ----------------------------------------------------------------------------- connections

/** The issues a repository holds, filtered, ordered and windowed as the arguments ask. */
function issueConnection(repo: Repo, args: Map<string, unknown>, context: ExecContext): Resolved {
  void context;
  let list = [...repo.issues.values()];
  const states = args.get('states');
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    if (wanted.size > 0 && !wanted.has('all')) list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.get('orderBy')) ? (args.get('orderBy') as Record<string, unknown>) : {};
  const fieldName = asString(orderBy.field) || 'CREATED_AT';
  const direction = (asString(orderBy.direction) || 'DESC').toUpperCase();
  const sign = direction === 'ASC' ? 1 : -1;
  list.sort((left, right) => {
    if (fieldName === 'UPDATED_AT') {
      if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? -sign : sign;
    } else if (fieldName === 'COMMENTS') {
      if (left.comments !== right.comments) return left.comments < right.comments ? -sign : sign;
    } else if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -sign : sign;
    }
    return (left.number - right.number) * sign;
  });

  const after = asInt(args.get('after'));
  let start = 0;
  if (after !== null) start = list.findIndex((issue) => issue.number === after) + 1;
  const first = asInt(args.get('first')) ?? 30;
  const window = list.slice(start, start + first);
  const hasNextPage = start + first < list.length;
  const endCursor = window.length === 0 ? null : String((window[window.length - 1] as Issue).number);

  return {
    __type: 'IssueConnection',
    totalCount: list.length,
    nodes: window.map((issue) => issueObject(repo, issue)),
    edges: window.map((issue) => ({ node: issueObject(repo, issue), cursor: String(issue.number) })),
    pageInfo: { hasNextPage, hasPreviousPage: start > 0, endCursor, startCursor: window.length === 0 ? null : String((window[0] as Issue).number) },
  };
}

/** The pull requests a repository holds. */
function pullConnection(repo: Repo, args: Map<string, unknown>, context: ExecContext): Resolved {
  void context;
  let list = [...repo.pulls.values()].sort((left, right) => left.number - right.number);
  const states = args.get('states');
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const first = asInt(args.get('first')) ?? 30;
  const window = list.slice(0, first);
  return {
    __type: 'PullRequestConnection',
    totalCount: list.length,
    nodes: window.map((pull) => pullObject(repo, pull)),
    edges: window.map((pull) => ({ node: pullObject(repo, pull), cursor: String(pull.number) })),
    pageInfo: { hasNextPage: first < list.length, hasPreviousPage: false, endCursor: window.length === 0 ? null : String((window[window.length - 1] as Pull).number), startCursor: null },
  };
}

/** The files a pull request changes against its base. */
function changedFiles(repo: Repo, pull: Pull, first: number): Resolved {
  const headSha = resolveCommit(repo, pull.head);
  const baseSha = resolveCommit(repo, pull.base);
  const headTree = headSha === null ? null : commitInfo(repo, headSha)?.tree ?? null;
  const baseTree = baseSha === null ? null : commitInfo(repo, baseSha)?.tree ?? null;
  const head = headTree === null ? new Map<string, { mode: string; sha: string }>() : flattenTree(repo, headTree);
  const base = baseTree === null ? new Map<string, { mode: string; sha: string }>() : flattenTree(repo, baseTree);
  const paths = new Set([...head.keys(), ...base.keys()]);
  const changed: Resolved[] = [];
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    changed.push({
      __type: 'PullRequestChangedFile',
      path,
      additions: 1,
      deletions: before === undefined ? 0 : 1,
      changeType: before === undefined ? 'ADDED' : after === undefined ? 'DELETED' : 'MODIFIED',
    });
  }
  return {
    __type: 'PullRequestChangedFileConnection',
    totalCount: changed.length,
    nodes: changed.slice(0, first),
    edges: changed.slice(0, first).map((node) => ({ node, cursor: String(node.path) })),
  };
}

// ----------------------------------------------------------------------------- introspection

/** Answer `__type(name:)` for the types the suite probes. */
function introspect(args: Map<string, unknown>, field: FieldNode, context: ExecContext): unknown {
  const name = asString(args.get('name'));
  const fieldsTable = TYPE_FIELDS_TABLE[name];
  const enumTable = ENUM_VALUES_TABLE[name];
  if (fieldsTable === undefined && enumTable === undefined) return null;
  const shape: Resolved = {
    __type: '__Type',
    kind: enumTable !== undefined ? 'ENUM' : 'OBJECT',
    name,
    description: null,
    fields: fieldsTable === undefined ? null : fieldsTable.map((fieldName) => ({ __type: '__Field', name: fieldName, description: null, isDeprecated: false, deprecationReason: null, args: [] })),
    enumValues: enumTable === undefined ? null : enumTable.map((value) => ({ __type: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null })),
    interfaces: [],
    possibleTypes: null,
  };
  return finish(shape, field, context, '__Type');
}

// ----------------------------------------------------------------------------- the endpoint

/** One GraphQL request: the body, the caller, and the answer. */
export interface GraphQLRequest {
  readonly forge: Forge;
  readonly login: string;
  readonly body: unknown;
  readonly base: string;
}

/** A GraphQL answer: `data`, or `errors`, or both (a partial answer). */
export interface GraphQLResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** Execute one operation document. */
function runOne(forge: Forge, login: string, documentText: string, variables: Record<string, unknown>): Record<string, unknown> {
  let parsed: Document;
  try {
    parsed = new Parser(lex(documentText)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error), locations: [], path: [] }] };
  }
  const operation = parsed.operations[0];
  if (operation === undefined) return { errors: [{ message: 'The document holds no operation' }] };
  const context: ExecContext = { forge, login, variables, parentType: 'Root', fragments: parsed.fragments };
  try {
    const data = executeOperation(parsed, operation, context);
    return { data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { errors: [{ message, locations: [], path: [] }], data: null };
  }
}

/** Answer a POST /api/graphql, including a batched array of documents. */
export function handleGraphQL(request: GraphQLRequest): GraphQLResponse {
  const body = request.body;
  if (Array.isArray(body)) {
    const answers = body.map((entry) => {
      const item = isRecord(entry) ? entry : {};
      const query = asString(item.query);
      const variables = isRecord(item.variables) ? (item.variables as Record<string, unknown>) : {};
      return runOne(request.forge, request.login, query, variables);
    });
    return { status: 200, body: answers as unknown as Record<string, unknown> };
  }
  if (!isRecord(body)) {
    return { status: 400, body: { errors: [{ message: 'A GraphQL request body must be a JSON object or array' }] } };
  }
  const query = asString(body.query);
  if (query === '') {
    return { status: 400, body: { errors: [{ message: 'A GraphQL request needs a query' }] } };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const operationName = asString(body.operationName);
  if (operationName !== '') {
    let parsed: Document;
    try {
      parsed = new Parser(lex(query)).parseDocument();
    } catch (error) {
      return { status: 200, body: { errors: [{ message: error instanceof Error ? error.message : String(error) }] } };
    }
    const named = parsed.operations.find((operation) => operation.name === operationName);
    if (named === undefined) {
      return { status: 200, body: { errors: [{ message: `No operation named ${operationName}` }] } };
    }
    const context: ExecContext = { forge: request.forge, login: request.login, variables, parentType: 'Root', fragments: parsed.fragments };
    try {
      return { status: 200, body: { data: executeOperation(parsed, named, context) } };
    } catch (error) {
      return { status: 200, body: { errors: [{ message: error instanceof Error ? error.message : String(error) }], data: null } };
    }
  }
  return { status: 200, body: runOne(request.forge, request.login, query, variables) };
}
