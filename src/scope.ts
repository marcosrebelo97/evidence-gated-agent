function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Minimal glob: "**" crosses directories, "*" and "?" stay inside one path segment. */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        const followedBySlash = pattern[i + 2] === '/';
        source += followedBySlash ? '(?:.*/)?' : '.*';
        i += followedBySlash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Returns the changed files that match a forbidden pattern.
 * Patterns without "/" match the file name in any directory (".env" catches "api/.env").
 */
export function findForbidden(files: readonly string[], patterns: readonly string[]): string[] {
  const matchers = patterns.map((pattern) => ({
    byName: !pattern.includes('/'),
    regexp: globToRegExp(pattern),
  }));
  return files.filter((file) => {
    const name = file.split('/').pop() ?? file;
    return matchers.some(({ byName, regexp }) => regexp.test(byName ? name : file));
  });
}

/** Branch-safe slug: no accents, lowercase, dash-separated. */
export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/g, '') || 'request';
}

export function branchName(prefix: string, id: string, title: string): string {
  return `${prefix}${id}-${slugify(title)}`;
}
