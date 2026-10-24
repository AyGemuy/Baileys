import {
  proto
} from "../../WAProto/index.js";
export const ALL_WA_PATCH_NAMES = Object.entries(proto.CollectionName ?? {}).filter(([k, v]) => typeof v === "number" && v !== 0).sort((a, b) => a[1] - b[1]).map(([k]) => k.toLowerCase());