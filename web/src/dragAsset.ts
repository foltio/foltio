import type { FullAsset } from "./useProject";

// The library item being dragged (dragover events cannot read dataTransfer contents).
export const dragAsset: { current: FullAsset | null } = { current: null };
