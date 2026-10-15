/**
 * Where a debounced search box stands:
 * - idle: the box shows what is applied
 * - debouncing: waiting for a quiet period after typing
 * - resolving: applying the text (including React transition work)
 */
export type IDebouncePhase = 'idle' | 'debouncing' | 'resolving';
