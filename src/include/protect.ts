export function isEnvProtectBasename(basename: string): boolean {
  if (basename === ".env") return true;
  if (
    basename === ".env.example" ||
    basename === ".env.template" ||
    basename === ".env.sample"
  ) {
    return false;
  }
  return /^\.env(?!\.example$|\.template$)./.test(basename) &&
    !/\.(example|template|sample)$/.test(basename);
}
