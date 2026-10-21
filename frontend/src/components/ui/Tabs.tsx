import { useState, type ReactNode } from "react";
import { clsx } from "clsx";

interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface TabsProps {
  tabs: TabItem[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  children?: ReactNode;
  className?: string;
}

export function Tabs({ tabs, activeTab: controlledTab, onTabChange, children, className }: TabsProps) {
  const [internalTab, setInternalTab] = useState(tabs[0]?.id ?? "");
  const active = controlledTab ?? internalTab;

  const handleChange = (id: string) => {
    setInternalTab(id);
    onTabChange?.(id);
  };

  return (
    <div className={clsx("flex flex-col", className)}>
      <div className="flex border-b border-[#1e2d47] gap-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleChange(tab.id)}
            className={clsx(
              "flex items-center gap-1.5 px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px",
              active === tab.id
                ? "text-[#00d4ff] border-[#00d4ff] bg-[#00d4ff08]"
                : "text-[#8892a4] border-transparent hover:text-[#e2e8f0] hover:border-[#1e2d47]"
            )}
          >
            {tab.icon && tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

export function createTabs(initialTab: string) {
  return useState(initialTab);
}
