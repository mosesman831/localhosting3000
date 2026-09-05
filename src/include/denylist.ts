export const DENYLIST_PATTERNS: string[] = [
  "node_modules/",
  ".git/",
  ".localhosting/",
  ".next/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".turbo/",
  ".cache/",
  ".parcel-cache/",
  ".nuxt/",
  ".svelte-kit/",
  ".output/",
  ".vercel/",
  ".netlify/",
  ".pnpm-store/",
  ".yarn/",
  ".nyc_output/",
  "playwright-report/",
  "test-results/",
  "__pycache__/",
  ".pytest_cache/",
  "venv/",
  ".venv/",
  "target/",
  "vendor/bundle/",
  "*.pyc",
  ".DS_Store",
  "Thumbs.db",
];

export const DEFAULT_EXTRA_IGNORE: string[] = [
  "*.log",
  "*.tmp",
  "*.swp",
  "*.swo",
  "*~",
];

export function denylistEnabled(): boolean {
  return process.env.LOCALHOSTING_TEST_ALLOW_DENYLIST !== "1";
}
