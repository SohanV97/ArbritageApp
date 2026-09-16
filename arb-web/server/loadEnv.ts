/**
 * Load .env.local into process.env.
 *
 * Next does this for us; a standalone process does not, and Node's own `--env-file` is not a
 * substitute here: it silently drops the multi-line quoted RSA PEM in KALSHI_PRIVATE_KEY.
 * Verified on this file — KALSHI_API_KEY and POLYMARKET_PRIVATE_KEY load, KALSHI_PRIVATE_KEY
 * comes back undefined. Every Kalshi signature would fail, and the websocket feed reads the
 * inline PEM with no path fallback, so it would fail too.
 *
 * The parser the 11 scripts already use handles it, so this is that approach generalised:
 * a value opened with a quote runs until the matching close quote, however many lines that
 * takes. Existing environment variables always win, so a real shell export can override the
 * file without editing it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface LoadedEnv {
  path: string;
  loaded: string[];
  skipped: string[];
}

/** Parse dotenv text, supporting values quoted across multiple lines. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let rest = m[2];

    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : null;
    if (!quote) {
      // Unquoted: the value ends at the line, minus any trailing comment.
      out[key] = rest.replace(/\s+#.*$/, '').trim();
      continue;
    }

    // Quoted: consume lines until the closing quote. This is what --env-file gets wrong.
    rest = rest.slice(1);
    const close = rest.indexOf(quote);
    if (close !== -1) {
      out[key] = rest.slice(0, close);
      continue;
    }
    const parts = [rest];
    while (++i < lines.length) {
      const next = lines[i];
      const end = next.indexOf(quote);
      if (end === -1) { parts.push(next); continue; }
      parts.push(next.slice(0, end));
      break;
    }
    out[key] = parts.join('\n');
  }
  return out;
}

export function loadEnv(file = '.env.local', cwd = process.cwd()): LoadedEnv {
  const path = join(cwd, file);
  if (!existsSync(path)) return { path, loaded: [], skipped: [] };
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    // A real environment variable always wins over the file.
    if (process.env[k] !== undefined) { skipped.push(k); continue; }
    process.env[k] = v;
    loaded.push(k);
  }
  return { path, loaded, skipped };
}
