import { useEffect, useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
type Choice = "system" | "light" | "dark";
const key = "observatory.theme";
function stored(): Choice { try { const value = localStorage.getItem(key); if (value === "light" || value === "dark") return value; } catch {} return "system"; }
export function ThemeControl() {
  const [choice, setChoice] = useState<Choice>(stored);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { const theme = choice === "system" ? media.matches ? "dark" : "light" : choice; document.documentElement.dataset.theme = theme; document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b1019" : "#f5f7fb"); };
    const sync = (event: StorageEvent) => { if (event.key === key || event.key === null) setChoice(stored()); };
    apply(); media.addEventListener("change", apply); window.addEventListener("storage", sync);
    return () => { media.removeEventListener("change", apply); window.removeEventListener("storage", sync); };
  }, [choice]);
  const Icon = choice === "system" ? Monitor : choice === "light" ? Sun : Moon;
  return <label className="theme-control"><Icon size={15}/><select aria-label="Color theme" value={choice} onChange={event => { const value = event.target.value as Choice; setChoice(value); try { localStorage.setItem(key, value); } catch {} }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>;
}
