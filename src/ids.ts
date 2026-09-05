import { randomBytes } from "node:crypto";

export function nowUtc(): Date {
  return new Date();
}

export function toRfc3339Z(d: Date = nowUtc()): string {
  return d.toISOString();
}

export function compactUtc(d: Date = nowUtc()): string {
  const iso = d.toISOString();
  const y = iso.slice(0, 4);
  const mo = iso.slice(5, 7);
  const day = iso.slice(8, 10);
  const h = iso.slice(11, 13);
  const mi = iso.slice(14, 16);
  const s = iso.slice(17, 19);
  return `${y}${mo}${day}T${h}${mi}${s}`;
}

export function newSnapshotId(d: Date = nowUtc()): string {
  const hex = randomBytes(4).toString("hex");
  return `lh_${compactUtc(d)}_${hex}`;
}

export const ID_FULL = /^lh_\d{8}T\d{6}_[0-9a-f]{8}$/;

export function isFullId(id: string): boolean {
  return ID_FULL.test(id);
}
