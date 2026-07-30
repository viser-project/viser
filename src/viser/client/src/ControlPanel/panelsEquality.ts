import { shallowObjectEqual } from "../utils/shallowObjectKeysEqual";

/** Equality used by PanelsFallback's `state.panels` selector (the mobile
 * bottom sheet's panel list).
 *
 * This MUST stay value-level (`shallowObjectEqual`), NOT key-set equality:
 * `updatePanel` replaces the panel object for the updated uuid without
 * changing the key set, so a keys-only compare swallows server-side
 * visible/order/tab-metadata updates and leaves the sheet rendering stale
 * panel props. The choice lives in this dedicated module so
 * `panelUpdates.test.ts` can pin the exact function the component subscribes
 * with -- a test importing the utility alone couldn't catch the component
 * quietly switching comparators. */
export const panelsSelectorEquality = shallowObjectEqual;
