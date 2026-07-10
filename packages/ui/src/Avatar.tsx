import * as React from 'react';
import { cn } from './utils.js';

export type AvatarSize = 'sm' | 'md' | 'lg';
export type AvatarStatus = 'online' | 'offline' | 'idle' | 'dnd';

export interface AvatarProps {
  src?: string | null;
  name?: string;
  fallback?: string;
  size?: AvatarSize;
  status?: AvatarStatus;
  className?: string;
}

export function Avatar({ src, name, fallback, size = 'md', status, className }: AvatarProps) {
  const [hasError, setHasError] = React.useState(false);

  const displayName = name || fallback || '?';
  const initials = displayName
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className={cn('relative inline-block', className)}>
      <div
        className={cn(
          'flex items-center justify-center rounded-full overflow-hidden bg-gray-200 text-gray-600 font-medium select-none dark:bg-gray-700 dark:text-gray-300',
          {
            'h-8 w-8 text-xs': size === 'sm',
            'h-10 w-10 text-sm': size === 'md',
            'h-14 w-14 text-lg': size === 'lg',
          }
        )}
      >
        {src && !hasError ? (
          <img
            src={src}
            alt={displayName}
            onError={() => setHasError(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span>{initials}</span>
        )}
      </div>

      {status && (
        <span
          data-testid={`avatar-status-${status}`}
          className={cn(
            'absolute bottom-0 right-0 block rounded-full ring-2 ring-white dark:ring-gray-900',
            {
              'h-2 w-2': size === 'sm',
              'h-2.5 w-2.5': size === 'md',
              'h-3.5 w-3.5': size === 'lg',
            },
            {
              'bg-green-500': status === 'online',
              'bg-gray-400': status === 'offline',
              'bg-amber-500': status === 'idle',
              'bg-red-500': status === 'dnd',
            }
          )}
        />
      )}
    </div>
  );
}
