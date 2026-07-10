import * as React from 'react';
import { cn } from './utils.js';
import { X } from 'lucide-react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Modal({ isOpen, onClose, title, children, className }: ModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="modal-overlay"
    >
      <div
        className={cn('relative w-full max-w-lg rounded-lg bg-white p-6 shadow-lg dark:bg-gray-800', className)}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          aria-label="Close modal"
        >
          <X className="h-5 w-5" />
        </button>
        {title && <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>}
        <div className="text-gray-700 dark:text-gray-300">{children}</div>
      </div>
    </div>
  );
}
