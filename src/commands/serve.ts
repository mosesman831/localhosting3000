import { runWatch } from "../watch/watch.js";

export async function cmdServe(
  root: string,
  opts: { dashboardPort?: number; signal?: AbortSignal },
): Promise<void> {
  await runWatch(root, { ...opts, paused: true });
}
