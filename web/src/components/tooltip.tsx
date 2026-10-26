import { Tooltip } from 'react-tooltip';

/** The page's one tooltip: an anchor opts in with data-tooltip-id={TOOLTIP_ID} and data-tooltip-content. */
export const TOOLTIP_ID = 'global-tooltip';

const closeEvents = { escape: true };

/** Rendered once, at the root. */
export function GlobalTooltip() {
  return (
    <Tooltip
      id={TOOLTIP_ID}
      className="z-(--layer-popover) max-w-lg text-left break-words normal-case"
      place="top"
      globalCloseEvents={closeEvents}
    />
  );
}
