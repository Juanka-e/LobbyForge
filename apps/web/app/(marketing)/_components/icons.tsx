/**
 * The hub's line icons, drawn from the design. All decorative
 * (`aria-hidden`): every control that shows one also has a text name.
 * Stroke colour follows `currentColor`, so each icon takes its token
 * colour from the element around it.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps) {
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
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const StarIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
  </Icon>
);

export const ArrowRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const MenuIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon strokeWidth={2.5} {...props}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </Icon>
);

export const LinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
  </Icon>
);

export const EyeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const EyeOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.9 5.2A10.4 10.4 0 0112 5c6.5 0 10 7 10 7a17.7 17.7 0 01-3.2 4.2M6.6 6.6A17.4 17.4 0 002 12s3.5 7 10 7a9.7 9.7 0 005.4-1.6" />
    <path d="M9.9 9.9a3 3 0 004.2 4.2M3 3l18 18" />
  </Icon>
);

export const SpeakerIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M11 5L6 9H3v6h3l5 4z" />
    <path d="M15.5 8.5a5 5 0 010 7" />
    <path d="M18.4 5.6a9 9 0 010 12.8" />
  </Icon>
);

export const GamepadIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="7" width="18" height="11" rx="4" />
    <path d="M8 11v3M6.5 12.5h3" />
    <circle cx="15.5" cy="12" r="0.8" fill="currentColor" />
    <circle cx="17.5" cy="14" r="0.8" fill="currentColor" />
  </Icon>
);

export const BranchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
