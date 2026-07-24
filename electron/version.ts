// Pure semver-ish helpers for the update check. No Electron imports.

// "v0.1.2" / "0.1.2" -> [0,1,2]; returns null if unparseable.
export function parseVersion(tag: string): number[] | null {
  const m = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return l[i] > c[i];
  }
  return false;
}
