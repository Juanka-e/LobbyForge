/**
 * An icon-only status of someone in voice — muted, deafened, server muted,
 * camera on, sharing their screen, speaking — as ONE image with a
 * translated name (and the same words as a tooltip).
 *
 * The icon is a Material Symbols ligature: the element's text IS the icon
 * name. Without this, a screen reader read the roster's mute icon out as
 * "mic_off"; an `aria-label` on a plain span is not reliably announced
 * either. So the ligature is hidden from assistive technology and the
 * wrapper carries `role="img"` and the label.
 */
export function VoiceStatusIcon({
  icon,
  label,
  className = 'text-[14px]',
}: {
  /** The Material Symbols name, e.g. `mic_off`. */
  icon: string;
  /** What it means, already translated. */
  label: string;
  /** Size and colour of the glyph. */
  className?: string;
}) {
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex flex-none" data-voice-status={icon}>
      <span className={`material-symbols-outlined ${className}`} aria-hidden>
        {icon}
      </span>
    </span>
  );
}
