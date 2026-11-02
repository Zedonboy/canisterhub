import { Monitor, Moon, Sun } from "lucide-react";
import { clsx } from "clsx";
import { useTheme, type ThemePref } from "@/lib/theme";

const OPTIONS: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System theme", Icon: Monitor },
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
];

export function ThemeToggle() {
  const { pref, set } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded border border-c-line bg-c-surface p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          role="radio"
          aria-checked={pref === value}
          aria-label={label}
          title={label}
          onClick={() => set(value)}
          className={clsx(
            "p-1.5 rounded transition-colors",
            pref === value ? "bg-c-accent-a14 text-c-accent" : "text-c-muted hover:text-c-text",
          )}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}
