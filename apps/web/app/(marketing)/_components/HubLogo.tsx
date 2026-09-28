import Link from 'next/link';
import { focusRing } from './styles';

/** The LobbyForge mark: four voice bars on the accent. Decorative. */
export function LogoMark() {
  return (
    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center gap-0.5 rounded-[9px] bg-primary">
      {[9, 16, 12, 7].map((height, index) => (
        <span key={index} className="w-[3px] rounded-sm bg-on-primary" style={{ height }} />
      ))}
    </span>
  );
}

/** Mark + wordmark, linking home. The wordmark text is the link's name. */
export function HubLogo({ href }: { href: '/landing' | '/home' }) {
  return (
    <Link href={href} className={`inline-flex items-center gap-2.5 rounded-lg text-text-primary ${focusRing}`}>
      <LogoMark />
      <span className="font-display text-[19px] font-bold tracking-[-0.01em] sm:text-[21px]">LobbyForge</span>
    </Link>
  );
}
