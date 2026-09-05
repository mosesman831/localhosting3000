export function assertNoPostinstall(pkg: { scripts?: Record<string, string> }): boolean {
  return !pkg.scripts || !("postinstall" in pkg.scripts);
}
