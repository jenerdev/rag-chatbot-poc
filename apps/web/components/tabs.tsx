'use client';

// Tabs (plan/ui-components.md Phase 5), the WAI-ARIA pattern by hand: a
// tablist whose ONE selected tab is in the Tab order (roving tabindex);
// ←/→ move and select, Home/End go to the ends; each panel is labelled by
// its tab.
//
// Every panel stays MOUNTED, hidden when not selected (trap 6): a form in
// one tab keeps what was typed while another tab is open, and nothing is
// fetched again on the way back.

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface Tab {
  id: string;
  label: string;
  panel: ReactNode;
}

export function Tabs({ label, tabs }: { label: string; tabs: Tab[] }) {
  const [selected, setSelected] = useState(tabs[0]?.id);
  const base = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const go = (index: number) => {
    const i = (index + tabs.length) % tabs.length;
    setSelected(tabs[i]?.id);
    buttons.current[i]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const to = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    go(to);
  };

  return (
    <>
      <div role="tablist" aria-label={label} className="tabs">
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={tab.id === selected}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={tab.id === selected ? 0 : -1}
            onClick={() => setSelected(tab.id)}
            onKeyDown={(event) => onKeyDown(event, i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        // tabIndex 0: each panel opens with text, not a control, so the
        // panel itself is the next stop after the tab (the APG's advice).
        <div key={tab.id} role="tabpanel" id={`${base}-panel-${tab.id}`} aria-labelledby={`${base}-tab-${tab.id}`} hidden={tab.id !== selected} tabIndex={0} className="tab-panel">
          {tab.panel}
        </div>
      ))}
    </>
  );
}
