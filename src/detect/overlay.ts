export const DEFAULT_OVERLAY_SIGNATURES = [
  "vite-error-overlay",
  "data-vite-error",
  "webpack-dev-server-client-overlay",
  "react-error-overlay",
  "nextjs-portal",
  "data-nextjs-dialog",
  "__next_build_error",
  "Failed to compile",
  "module-not-found",
];

export function sniffHtml(contentType: string | null, body: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return true;
  if (ct.includes("application/json") || ct.includes("text/plain")) return false;
  if (!ct) {
    const t = body.trimStart();
    return t.startsWith("<") || t.startsWith("<!");
  }
  return false;
}

export function overlayDetected(body: string, extra: string[] = []): boolean {
  const sigs = [...DEFAULT_OVERLAY_SIGNATURES, ...extra];
  return sigs.some((s) => body.includes(s));
}

export type ProbeKind = "html" | "other";

export function classifyBody(
  contentType: string | null,
  body: string,
  extra: string[] = [],
): { html: boolean; overlay: boolean; overlay_ok: boolean } {
  const html = sniffHtml(contentType, body);
  if (!html) {
    return { html: false, overlay: false, overlay_ok: true };
  }
  const overlay = overlayDetected(body, extra);
  return { html: true, overlay, overlay_ok: !overlay };
}
