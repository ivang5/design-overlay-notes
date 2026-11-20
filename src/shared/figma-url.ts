/**
 * Figma URL handling.
 *
 * We deliberately accept a narrow set of URL shapes on www.figma.com only.
 * The file key is used purely as a local grouping key; it is never sent
 * anywhere and the extension never talks to Figma's APIs.
 */

/** Path prefixes that open a single Figma document in the browser. */
const DOCUMENT_PATH_KINDS = ['design', 'file', 'proto', 'board'] as const;
export type FigmaDocumentKind = (typeof DOCUMENT_PATH_KINDS)[number];

export interface ParsedFigmaUrl {
  kind: FigmaDocumentKind;
  /** Best-effort file key parsed from the URL path. */
  fileKey: string;
  /** Branch key when the URL points at a branch (`/design/:key/branch/:branchKey/...`). */
  branchKey: string | null;
  /** Human-ish file name from the URL slug, if present. */
  slugName: string | null;
}

const FILE_KEY_RE = /^[A-Za-z0-9]{10,64}$/;

/** Hosts we accept. The e2e build additionally accepts a local fixture server. */
function isAllowedHost(url: URL): boolean {
  if (url.protocol === 'https:' && url.hostname === 'www.figma.com') return true;
  if (__E2E__ && url.protocol === 'http:' && url.hostname === '127.0.0.1') return true;
  return false;
}

export function parseFigmaUrl(raw: string | null | undefined): ParsedFigmaUrl | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isAllowedHost(url)) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const [kind, fileKey, ...rest] = segments;
  if (!kind || !fileKey) return null;
  if (!(DOCUMENT_PATH_KINDS as readonly string[]).includes(kind)) return null;
  if (!FILE_KEY_RE.test(fileKey)) return null;

  let branchKey: string | null = null;
  let slug: string | undefined = rest[0];
  if (rest[0] === 'branch' && rest[1] && FILE_KEY_RE.test(rest[1])) {
    branchKey = rest[1];
    slug = rest[2];
  }

  return {
    kind: kind as FigmaDocumentKind,
    fileKey,
    branchKey,
    slugName: slug ? slugToName(slug) : null,
  };
}

export function isSupportedPageUrl(raw: string | null | undefined): boolean {
  return parseFigmaUrl(raw) !== null;
}

/** Key used to group captures into a local project. Branches get their own group. */
export function projectKeyFor(parsed: ParsedFigmaUrl): string {
  return parsed.branchKey ? `${parsed.fileKey}/branch/${parsed.branchKey}` : parsed.fileKey;
}

function slugToName(slug: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    decoded = slug;
  }
  const name = decoded.replace(/[-_]+/g, ' ').trim();
  return name.length > 0 ? name : null;
}

/** Query parameters worth keeping: they help reopen the same frame/page in Figma. */
const KEPT_QUERY_PARAMS = ['node-id'];

/**
 * Remove tracking/session parameters and fragments. Only an allowlist of
 * navigation parameters survives. Returns null for unparseable URLs.
 */
export function sanitizePageUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const kept = new URLSearchParams();
  for (const key of KEPT_QUERY_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null) kept.set(key, value);
  }
  const query = kept.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

/**
 * Turn a browser tab title such as "Checkout flow – Figma" into "Checkout flow".
 */
export function cleanFigmaTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const cleaned = title.replace(/\s+[–—-]\s+Figma(?:\s+\w+)?$/u, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}
