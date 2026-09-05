import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { CliError } from "../errors.js";

export function isLoopbackIp(ip: string): boolean {
  let v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) v = v.slice(7);
  if (v === "::1" || v === "0:0:0:0:0:0:0:1") return true;
  if (v === "127.0.0.1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
  return false;
}

export async function assertLoopbackUrl(urlStr: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new CliError("E_URL", `invalid probe URL ${urlStr}`);
  }
  const proto = u.protocol.replace(":", "").toLowerCase();
  if (proto === "file" || proto === "gopher") {
    throw new CliError("E_URL", `rejected probe scheme ${u.protocol}`);
  }
  if (proto !== "http" && proto !== "https") {
    throw new CliError("E_URL", `rejected probe scheme ${u.protocol}`);
  }
  const host = u.hostname;
  if (isIP(host)) {
    if (!isLoopbackIp(host)) {
      throw new CliError("E_URL", `probe host must be loopback, got ${host}`);
    }
    return u;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new CliError("E_URL", `probe host ${host} did not resolve`);
  }
  if (addrs.length === 0 || addrs.some((a) => !isLoopbackIp(a.address))) {
    throw new CliError("E_URL", `probe host ${host} does not resolve to loopback`);
  }
  return u;
}

export function probeUrl(origin: string, probePath: string): string {
  const base = origin.endsWith("/") ? origin : origin + "/";
  const path = probePath.startsWith("/") ? probePath : "/" + probePath;
  return new URL(path.replace(/^\//, ""), base).href;
}
