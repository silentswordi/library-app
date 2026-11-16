import React from 'react';
import { ArrowUp } from 'lucide-react';

interface ScrollToTopButtonProps {
  visible: boolean;
  onClick: () => void;
  hasBottomNav?: boolean;
}

export const ScrollToTopButton: React.FC<ScrollToTopButtonProps> = ({
  visible,
  onClick,
  hasBottomNav = false,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="رفتن به بالای صفحه"
      title="رفتن به بالای صفحه"
      className={`fixed right-4 z-30 flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-white/95 text-teal-800 shadow-lg backdrop-blur-md transition-all duration-150 hover:bg-teal-700 hover:text-white active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 ${
        hasBottomNav ? 'bottom-[74px]' : 'bottom-5'
      } ${
        visible
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-3 opacity-0'
      }`}
    >
      <ArrowUp className="h-5 w-5" />
    </button>
  );
};
