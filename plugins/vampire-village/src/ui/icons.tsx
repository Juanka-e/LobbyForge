/**
 * Line icons for the panel. Always decorative (`aria-hidden`): every icon
 * sits next to text that says the same thing, so colour and shape are
 * never the only cue.
 */
import type { ReactNode } from 'react';
import type { VillageRole } from '../state';

function Svg({ size = 22, children }: { size?: number; children: ReactNode }) {
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

export const MoonIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Svg>
);

export const SunIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

/** Two fangs under a lip — the game's own mark. */
export const FangsIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 7c3 2 6 3 9 3s6-1 9-3" />
    <path d="M7 9l1.5 6L10 9.8" />
    <path d="M14 9.8l1.5 5.2L17 9" />
  </Svg>
);

export const EyeIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

export const CrossIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" />
  </Svg>
);

export const TargetIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 1v4M12 19v4M1 12h4M19 12h4" />
  </Svg>
);

export const ShieldIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
  </Svg>
);

export const MaskIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 5h16v6a8 8 0 0 1-16 0z" />
    <path d="M8 10h.01M16 10h.01M9 14c1.8 1.4 4.2 1.4 6 0" />
  </Svg>
);

export const HomeIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 11l9-7 9 7" />
    <path d="M5 10v10h14V10" />
    <path d="M10 20v-6h4v6" />
  </Svg>
);

export const SkullIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 3a8 8 0 0 0-5 14.2V21h10v-3.8A8 8 0 0 0 12 3z" />
    <path d="M9 12h.01M15 12h.01M10 21v-3M14 21v-3" />
  </Svg>
);

export const TrophyIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" />
    <path d="M17 6h3a3 3 0 0 1-3 4M7 6H4a3 3 0 0 0 3 4" />
  </Svg>
);

export const PeopleIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <path d="M17 8v6M14 11h6" />
  </Svg>
);

export const CloseIcon = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const SendIcon = ({ size = 18 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 12l16-8-6 16-2-6z" />
  </Svg>
);

const ROLE_ICONS: Record<VillageRole, (props: { size?: number }) => ReactNode> = {
  vampire: FangsIcon,
  villager: HomeIcon,
  seer: EyeIcon,
  doctor: CrossIcon,
  hunter: TargetIcon,
  survivor: ShieldIcon,
  jester: MaskIcon,
};

export function RoleIcon({ role, size }: { role: VillageRole; size?: number }) {
  const Icon = ROLE_ICONS[role];
  return <Icon size={size} />;
}
