import * as React from 'react';
import { cn } from '../utils.js';
import { X, CheckCircle, AlertTriangle, AlertCircle } from 'lucide-react';

export interface ToastProps {
  message: string;
  type?: 'success' | 'warning' | 'error';
  onClose: () => void;
  className?: string;
}

export function Toast({ message, type = 'success', onClose, className }: ToastProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 w-80 p-4 rounded-lg shadow-lg border text-sm',
        {
          'bg-green-50 border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-800 dark:text-green-300': type === 'success',
          'bg-yellow-50 border-yellow-200 text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-300': type === 'warning',
          'bg-red-50 border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300': type === 'error',
        },
        className
      )}
      role="alert"
    >
      {type === 'success' && <CheckCircle className="h-5 w-5 shrink-0" />}
      {type === 'warning' && <AlertTriangle className="h-5 w-5 shrink-0" />}
      {type === 'error' && <AlertCircle className="h-5 w-5 shrink-0" />}
      <span className="flex-1">{message}</span>
      <button onClick={onClose} className="hover:opacity-75" aria-label="Close notification">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
