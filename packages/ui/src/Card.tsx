import * as React from 'react';
import { cn } from './utils.js';

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  footer?: React.ReactNode;
  bodyClassName?: string;
  titleClassName?: string;
  footerClassName?: string;
}

export function Card({
  className,
  title,
  footer,
  children,
  bodyClassName,
  titleClassName,
  footerClassName,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900',
        className
      )}
      {...props}
    >
      {title && (
        <div className={cn('border-b border-gray-200 px-5 py-4 dark:border-gray-800', titleClassName)}>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h3>
        </div>
      )}
      <div className={cn('p-5 text-sm text-gray-700 dark:text-gray-300', bodyClassName)}>
        {children}
      </div>
      {footer && (
        <div className={cn('border-t border-gray-200 px-5 py-4 dark:border-gray-800', footerClassName)}>
          {footer}
        </div>
      )}
    </div>
  );
}
