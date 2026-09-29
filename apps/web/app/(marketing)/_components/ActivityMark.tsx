import type { CSSProperties } from 'react';
import { activityTone } from '@/lib/hub-format';
import tones from './hub-tones.module.css';

const SIZES = {
  sm: 'size-9 rounded-[10px] text-base',
  md: 'size-10 rounded-xl text-[19px]',
  lg: 'size-12 rounded-[14px] text-[22px]',
} as const;

/**
 * An activity's letter tile in its identity hue. Decorative — the name is
 * always written next to it.
 */
export default function ActivityMark({
  pluginId,
  name,
  size = 'md',
  className = '',
}: {
  pluginId: string;
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const tone = activityTone(pluginId);
  const style = { '--tone': tone.dark, '--tone-light': tone.light } as CSSProperties;
  return (
    <span
      aria-hidden
      style={style}
      className={`${tones.tone} flex shrink-0 items-center justify-center font-display font-extrabold ${SIZES[size]} ${className}`}
    >
      {/* Product names are brand words, not prose: no locale casing. */}
      {Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
    </span>
  );
}
