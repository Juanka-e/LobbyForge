'use client';

import { useT } from '@/lib/i18n/client';
import { useBlockList } from './BlockListProvider';

/**
 * Block/unblock button — reads from the shared BlockListProvider.
 */
export function MemberBlockButton({
  userId,
  isSelf,
}: {
  userId: string;
  isSelf: boolean;
  onBlockedChange?: (blocked: boolean) => void;
}) {
  const t = useT();
  const { isBlocked, toggleBlock } = useBlockList();
  const blocked = isBlocked(userId);

  if (isSelf) return null;

  async function handleToggle() {
    await toggleBlock(userId);
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      title={blocked ? t('lobby.roster.unblock') : t('lobby.roster.block')}
      aria-label={blocked ? t('lobby.roster.unblockAria') : t('lobby.roster.blockAria')}
      className={`p-1 rounded transition-all flex-shrink-0 ${
        blocked
          ? 'opacity-100 text-danger hover:bg-danger/10'
          : // Revealed on hover and on keyboard focus; never an invisible
            // target on a touch screen (one tap there blocked someone) —
            // touch users block from the profile card's menu.
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:hidden text-text-muted hover:bg-surface-container hover:text-danger'
      }`}
    >
      <span className="material-symbols-outlined text-[14px]" aria-hidden>
        {blocked ? 'remove_circle' : 'block'}
      </span>
    </button>
  );
}
