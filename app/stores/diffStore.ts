import { create } from "zustand";

/** URLs are owned by the caller and must stay valid while the diff is open. */
export interface DiffTarget {
  parentUrl: string;
  childUrl: string;
  parentLabel?: string;
  childLabel?: string;
}

interface DiffState {
  isOpen: boolean;
  target: DiffTarget | null;
  openDiff: (target: DiffTarget) => void;
  closeDiff: () => void;
}

export const useDiffStore = create<DiffState>()((set) => ({
  isOpen: false,
  target: null,

  openDiff: (target) => set({ target, isOpen: true }),

  closeDiff: () => set({ isOpen: false, target: null }),
}));
