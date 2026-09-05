export function shouldPoll(hidden: boolean): boolean {
  return hidden !== true;
}

export function nextStatusDelayMs(hidden: boolean): number | null {
  if (!shouldPoll(hidden)) return null;
  return 2000;
}

export function nextSnapshotsDelayMs(hidden: boolean): number | null {
  if (!shouldPoll(hidden)) return null;
  return 5000;
}

export function schedulePoll(
  hidden: boolean,
  delayMs: number,
  fn: () => void,
  setTimer: (fn: () => void, ms: number) => unknown,
): unknown | null {
  if (!shouldPoll(hidden)) return null;
  return setTimer(fn, delayMs);
}
