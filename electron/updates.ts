// Update check against GitHub releases. The app is ad-hoc signed (not
// notarized), so silent auto-install isn't possible — instead we detect a
// newer release, notify once, and hand the user the download page.
import { Notification, shell } from "electron";
import { isNewer } from "./version";

const RELEASES_API = "https://api.github.com/repos/sankalpdamani/oatmeal/releases/latest";
export const RELEASES_PAGE = "https://github.com/sankalpdamani/oatmeal/releases/latest";
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releasePage: string;
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo> {
  let latestVersion: string | null = null;
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = (await res.json()) as { tag_name?: string };
      latestVersion = json.tag_name ?? null;
    }
  } catch {
    /* offline is fine — stay quiet */
  }
  return {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion !== null && isNewer(latestVersion, currentVersion),
    releasePage: RELEASES_PAGE,
  };
}

let notified = false;

export function startUpdateChecks(currentVersion: string) {
  const run = async () => {
    const info = await checkForUpdate(currentVersion);
    if (info.updateAvailable && !notified) {
      notified = true;
      const n = new Notification({
        title: "Oatmeal update available",
        body: `${info.latestVersion} is out (you have ${currentVersion}). Click to download.`,
      });
      n.on("click", () => void shell.openExternal(RELEASES_PAGE));
      n.show();
    }
  };
  // First check shortly after launch, then daily.
  setTimeout(() => void run(), 15000);
  setInterval(() => void run(), CHECK_EVERY_MS);
}
