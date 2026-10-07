'use client';

// The search field over a staff list (plan/ui-components.md Phase 4). It
// filters the rows already loaded (lib/search.ts); it asks the server for
// nothing. Escape clears it, the way the browser's own search fields do.

import { Icon } from './icons';

export function ListSearch({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return (
    <div className="list-search">
      <Icon name="search" size={16} />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value !== '') {
            e.preventDefault();
            onChange('');
          }
        }}
      />
    </div>
  );
}
