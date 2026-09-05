import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface Io {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  json: boolean;
  yes: boolean;
  dir: string;
  env: NodeJS.ProcessEnv;
}

const als = new AsyncLocalStorage<Io>();

export function defaultIo(): Io {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    json: false,
    yes: false,
    dir: process.cwd(),
    env: process.env,
  };
}

export function getIo(): Io {
  return als.getStore() ?? defaultIo();
}

export function runWithIo<T>(io: Io, fn: () => T): T {
  return als.run(io, fn);
}

export function writeOut(text: string): void {
  const io = getIo();
  io.stdout.write(text.endsWith("\n") || text === "" ? text : text + "\n");
}

export function writeOutRaw(text: string): void {
  getIo().stdout.write(text);
}

export function writeErr(text: string): void {
  const io = getIo();
  io.stderr.write(text.endsWith("\n") || text === "" ? text : text + "\n");
}

export function writeJson(value: unknown): void {
  writeOutRaw(JSON.stringify(value, null, 2) + "\n");
}

export async function readLine(prompt: string): Promise<string> {
  const io = getIo();
  const stdin = io.stdin as Readable & { isTTY?: boolean };
  if (!stdin.isTTY && !io.yes) {
    return "";
  }
  return await new Promise((resolve) => {
    const rl = createInterface({ input: io.stdin, output: io.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
