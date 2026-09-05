import { classifyBody } from "./overlay.js";
import { assertLoopbackUrl } from "./ssrf.js";
import type { LastProbe } from "../types.js";
import { toRfc3339Z } from "../ids.js";

const MAX_BODY = 512 * 1024;
const MAX_REDIRECTS = 3;

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  overlay: boolean | null;
  html: boolean;
  error: string | null;
  confidence: "overlay_clean" | "http_stable" | null;
}

export async function probeOnce(
  url: string,
  opts: { timeoutMs: number; overlaySignatures: string[] },
): Promise<ProbeResult> {
  let current = url;
  try {
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      await assertLoopbackUrl(current);
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), opts.timeoutMs);
      let res: Response;
      try {
        res = await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: ac.signal,
          headers: {
            Accept: "text/html, application/json;q=0.9, */*;q=0.1",
            "User-Agent": "localhosting/0.1 (+local)",
          },
        });
      } finally {
        clearTimeout(t);
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        if (hops === MAX_REDIRECTS) {
          return fail("too many redirects", res.status);
        }
        const loc = res.headers.get("location");
        if (!loc) return fail("redirect without location", res.status);
        current = new URL(loc, current).href;
        continue;
      }

      if (res.status >= 400) {
        return fail(`status ${res.status}`, res.status);
      }
      if (res.status < 200 || res.status >= 400) {
        return fail(`status ${res.status}`, res.status);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      const body = buf.subarray(0, MAX_BODY).toString("utf8");
      const ct = res.headers.get("content-type");
      const cls = classifyBody(ct, body, opts.overlaySignatures);
      if (!cls.overlay_ok) {
        return {
          ok: false,
          status: res.status,
          overlay: true,
          html: true,
          error: "overlay",
          confidence: null,
        };
      }
      const confidence = cls.html ? "overlay_clean" : "http_stable";
      return {
        ok: true,
        status: res.status,
        overlay: false,
        html: cls.html,
        error: null,
        confidence,
      };
    }
    return fail("too many redirects", null);
  } catch (err) {
    const e = err as Error;
    return fail(e.name === "AbortError" ? "timeout" : e.message, null);
  }
}

function fail(error: string, status: number | null): ProbeResult {
  return {
    ok: false,
    status,
    overlay: error === "overlay" ? true : null,
    html: false,
    error,
    confidence: null,
  };
}

export function toLastProbe(url: string, r: ProbeResult): LastProbe {
  return {
    url,
    last_status: r.status,
    last_overlay: r.overlay,
    last_error: r.error,
    last_at: toRfc3339Z(),
  };
}
