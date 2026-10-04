import type { ReactNode, SVGProps } from 'react';

// The sidebar's icons, drawn as one set: a 16px grid, 1.5px rounded strokes.

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

type Props = SVGProps<SVGSVGElement>;

export const TimerIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="8" cy="8.5" r="5.5" />
    <path d="M8 5.5v3l2 1.5M6.5 1.5h3" />
  </Icon>
);
export const OverviewIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M2.5 13.5v-4M6.25 13.5v-8M10 13.5v-5.5M13.5 13.5v-11" />
  </Icon>
);
export const TimesheetIcon = (p: Props) => (
  <Icon {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="M2.5 6.5h11M6.5 6.5v7" />
  </Icon>
);
export const TimeOffIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M8 13.5V8M8 8c0-2.5-2-4.5-5-4.5C3 6 5 8 8 8ZM8 8c0-2.5 2-4.5 5-4.5C13 6 11 8 8 8ZM4 13.5h8" />
  </Icon>
);
export const TeamIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="6" cy="5.5" r="2.25" />
    <path d="M2 13c.4-2.2 2-3.5 4-3.5s3.600 1.300 4 3.500M10.500 3.500a2.250 2.250 0 0 1 0 4.250M12 9.750c1.100.500 1.800 1.600 2 3.250" />
  </Icon>
);
export const ReportsIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4 1.500h5.500L12.500 4.500V13a1.500 1.500 0 0 1-1.500 1.500H5A1.500 1.500 0 0 1 3.500 13V2a.500.500 0 0 1 .500-.500ZM9.500 1.500v3h3M6 8.500h4M6 11h4" />
  </Icon>
);
export const SettingsIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M2.500 4.500h5M11.500 4.500h2M2.500 11.500h2M8.500 11.500h5" />
    <circle cx="9.500" cy="4.500" r="1.750" />
    <circle cx="6.500" cy="11.500" r="1.750" />
  </Icon>
);
export const BackIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M6.500 3.500 2 8l4.500 4.500M2.500 8H14" />
  </Icon>
);
export const SignOutIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M6.500 2.500H4A1.500 1.500 0 0 0 2.500 4v8A1.500 1.500 0 0 0 4 13.500h2.500M10.500 5 13.500 8l-3 3M13.500 8H6.500" />
  </Icon>
);
export const BrandIcon = (p: Props) => (
  <Icon strokeWidth="1.75" {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.500V8l2.500 1.500" />
  </Icon>
);
export const SunIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.500v1.250M8 13.250v1.250M1.500 8h1.250M13.250 8h1.250M3.400 3.400l.900.900M11.700 11.700l.900.900M3.400 12.600l.900-.900M11.700 4.300l.900-.900" />
  </Icon>
);
export const MoonIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M13.500 9.500A5.750 5.750 0 0 1 6.500 2.500a5.750 5.750 0 1 0 7 7Z" />
  </Icon>
);
export const SystemIcon = (p: Props) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="8" rx="1.500" />
    <path d="M6 13.500h4M8 11v2.500" />
  </Icon>
);
