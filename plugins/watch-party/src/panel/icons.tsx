/**
 * The panel's icons, drawn inline (the kit ships none and plugins load no
 * icon font). All decorative: every control that shows one carries a
 * translated `aria-label` or visible text. `currentColor` keeps them on
 * the theme.
 */

import type { ReactNode } from 'react';

function Svg({ size = 20, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const PlayIcon = ({ size = 22 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
  </Svg>
);

export const PauseIcon = ({ size = 22 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const BackIcon = () => (
  <Svg>
    <path d="M4 12a8 8 0 1 0 8-8H7" />
    <path d="M9 1 6 4l3 3" />
  </Svg>
);

export const ForwardIcon = () => (
  <Svg>
    <path d="M20 12a8 8 0 1 1-8-8h5" />
    <path d="m15 1 3 3-3 3" />
  </Svg>
);

export const NextIcon = () => (
  <Svg size={18}>
    <path d="M5 5v14l10-7z" fill="currentColor" stroke="none" />
    <path d="M19 5v14" />
  </Svg>
);

export const UpIcon = () => (
  <Svg size={16}>
    <path d="m6 15 6-6 6 6" />
  </Svg>
);

export const DownIcon = () => (
  <Svg size={16}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const RemoveIcon = () => (
  <Svg size={16}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const ExternalIcon = () => (
  <Svg size={16}>
    <path d="M14 4h6v6" />
    <path d="M20 4 10 14" />
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </Svg>
);

export const SyncIcon = () => (
  <Svg size={18}>
    <path d="M20 12a8 8 0 0 1-14.9 4" />
    <path d="M4 12A8 8 0 0 1 18.9 8" />
    <path d="M19 3v5h-5" />
    <path d="M5 21v-5h5" />
  </Svg>
);

export const ScreenIcon = () => (
  <Svg size={36}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
    <path d="m10 8 4 2-4 2z" fill="currentColor" stroke="none" />
  </Svg>
);
