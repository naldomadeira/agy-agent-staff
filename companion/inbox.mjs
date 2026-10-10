import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The inbox is how a finished job reaches a host that is not sitting in
// `wait`: the companion appends one line per terminal job, and the host's
// prompt hook shows the lines it has not shown yet for the repository it is
// in. One file for every repository, so a run's worktrees report to the
// session that started them; each line carries the repository it belongs to.

const MAX_INBOX_BYTES = 512 * 1024;

export function configDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, 'agy-staff');
}

export function inboxFile(env = process.env) {
  return path.join(configDir(env), 'inbox.jsonl');
}

/** The repository a path belongs to, as the main worktree's real path: a job
 *  in a run's worktree is reported to the session in the main checkout. */
export function repoKey(cwd) {
  let dir;
  try { dir = fs.realpathSync(cwd); } catch { return cwd; }
  for (let current = dir; ; current = path.dirname(current)) {
    const marker = path.join(current, '.git');
    let stat = null;
    try { stat = fs.statSync(marker); } catch { /* keep walking */ }
    if (stat?.isDirectory()) return current;
    if (stat?.isFile()) {
      // A linked worktree: `.git` is a file pointing into <main>/.git/worktrees/<name>.
      const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(marker, 'utf8'));
      if (match) {
        const gitdir = path.resolve(current, match[1].trim());
        const main = gitdir.split(`${path.sep}.git${path.sep}worktrees${path.sep}`)[0];
        if (main !== gitdir) return main;
      }
      return current;
    }
    if (path.dirname(current) === current) return dir;
  }
}

/** Append one entry. Best-effort by design: a full disk or a read-only home
 *  must never turn a finished job into a failed one. */
export function appendInbox(entry, env = process.env) {
  try {
    const file = inboxFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    trimInbox(file);
  } catch { /* fail-open */ }
}

/** Keep the newest half when the file outgrows its budget. */
function trimInbox(file) {
  const size = fs.statSync(file).size;
  if (size <= MAX_INBOX_BYTES) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const kept = lines.slice(Math.floor(lines.length / 2));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, kept.join('\n') + '\n');
  fs.renameSync(tmp, file);
}

export function readInbox(env = process.env) {
  try {
    return fs.readFileSync(inboxFile(env), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function cursorFile(repo, env) {
  const name = Buffer.from(repo).toString('base64url').slice(-80);
  return path.join(configDir(env), 'cursors', `${name}.json`);
}

/** Entries for `repo` newer than its cursor, oldest first. Without a cursor
 *  only the last `firstWindowMs` counts, so a first prompt is not a flood. */
export function unreadFor(repo, { env = process.env, now = Date.now(), firstWindowMs = 24 * 3600 * 1000 } = {}) {
  let since = new Date(now - firstWindowMs).toISOString();
  try { since = JSON.parse(fs.readFileSync(cursorFile(repo, env), 'utf8')).ts || since; } catch { /* no cursor yet */ }
  return readInbox(env).filter((entry) => entry.repo === repo && entry.ts > since);
}

export function markRead(repo, ts, env = process.env) {
  try {
    const file = cursorFile(repo, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ts }));
  } catch { /* fail-open */ }
}
