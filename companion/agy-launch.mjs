import fs from 'node:fs';

/** A Node-based AGY wrapper may be reached through a symlink without a script
 * extension. Run its target through Node on every platform, including Windows. */
export function agyLaunch(bin, args) {
  let target = bin;
  try { target = fs.realpathSync(bin); } catch { /* bare PATH command or missing worker */ }
  if (/\.(mjs|cjs|js)$/i.test(target)) return { cmd: process.execPath, args: [target, ...args] };
  return { cmd: bin, args };
}
