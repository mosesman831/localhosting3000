export const testHooks = {
  failNextSnapshot: false as boolean | NodeJS.ErrnoException,
  ebusyPaths: new Set<string>(),
  renameFailPaths: new Set<string>(),
};

export function resetTestHooks(): void {
  testHooks.failNextSnapshot = false;
  testHooks.ebusyPaths.clear();
  testHooks.renameFailPaths.clear();
}
