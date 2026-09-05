import { runWatch } from "../watch/watch.js";

export async function cmdWatch(
  root: string,
  opts: {
    url?: string;
    probePath?: string;
    dashboardPort?: number;
    includeEnv?: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  await runWatch(root, opts);
}
