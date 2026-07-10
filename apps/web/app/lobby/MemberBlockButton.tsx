'use client';

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
      title={blocked ? 'Unblock' : 'Block'}
      aria-label={blocked ? 'Unblock this user' : 'Block this user'}
      className={`p-1 rounded transition-all flex-shrink-0 ${
        blocked
          ? 'opacity-100 text-danger hover:bg-danger/10'
          : 'opacity-0 group-hover:opacity-100 text-text-muted hover:bg-surface-container hover:text-danger'
      }`}
    >
      <span className="material-symbols-outlined text-[14px]">
        {blocked ? 'remove_circle' : 'block'}
      </span>
    </button>
  );
}
