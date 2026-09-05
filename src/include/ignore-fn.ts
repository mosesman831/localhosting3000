import { createRequire } from "node:module";
import type { Ignore } from "ignore";

const require = createRequire(import.meta.url);
export const ignore: (rules?: string | string[]) => Ignore = require("ignore");
