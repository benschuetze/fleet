import { Bell, type LucideIcon, Monitor, Moon, Settings, Sun } from "lucide-react";

/**
 * Icons from lucide, only behind the gear (stage 12.7): everything else on the screen is text on the character
 * grid (spec, "Ein Schirm im CLI-Look", rule 8). Always decorative; the text next to them carries the meaning.
 */
const ICONS = {
  gear: Settings,
  bell: Bell,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const C = ICONS[name];
  return <C className={`i ${className}`} aria-hidden="true" strokeWidth={1.8} />;
}
