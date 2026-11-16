import React from 'react';
import { BookOpen, Search } from 'lucide-react';
import { AppTab } from '../types/library';

interface BottomTabBarProps {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
}

export const BottomTabBar: React.FC<BottomTabBarProps> = ({
  activeTab,
  onSelectTab,
}) => {
  return (
    <nav
      aria-label="منوی اصلی"
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur-md pb-safe"
    >
      <div className="mx-auto grid h-[58px] max-w-6xl grid-cols-2 items-center">
        <button
          type="button"
          onClick={() => onSelectTab('library')}
          className={`flex h-full min-h-[48px] flex-col items-center justify-center gap-0.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-teal-700 ${
            activeTab === 'library'
              ? 'text-teal-700'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <BookOpen
            className="h-5 w-5"
            strokeWidth={activeTab === 'library' ? 2.4 : 1.9}
          />
          <span>کتاب‌ها</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTab('search')}
          className={`flex h-full min-h-[48px] flex-col items-center justify-center gap-0.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-teal-700 ${
            activeTab === 'search'
              ? 'text-teal-700'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <Search
            className="h-5 w-5"
            strokeWidth={activeTab === 'search' ? 2.4 : 1.9}
          />
          <span>جستجو در کتاب‌ها</span>
        </button>
      </div>
    </nav>
  );
};
