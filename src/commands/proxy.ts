import { CliError } from "../errors.js";

export async function proxyJson(
  dashboard: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const url = new URL(path, dashboard.endsWith("/") ? dashboard : dashboard + "/").href;
  const origin = new URL(dashboard).origin;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CliError(
      "E_LOCKED",
      "watch is running but dashboard is not reachable; Ctrl-C the watch process.",
    );
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = (json.code as string) || "E_USAGE";
    const msg = (json.message as string) || (json.error as string) || res.statusText;
    if (code === "E_LOCKED" || res.status === 409) {
      throw new CliError("E_LOCKED", msg);
    }
    if (code.startsWith("E_")) {
      throw new CliError(code as never, msg);
    }
    throw new CliError("E_USAGE", msg);
  }
  return json;
}
