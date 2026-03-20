// Color theme mappings for Notion-driven card sections.
// Full class strings are written out so Tailwind's JIT includes them.
export interface ThemeClasses {
  border: string;
  iconBg: string;
  iconText: string;
  ctaText: string;
  ctaHover: string;
}

export const colorThemes: Record<string, ThemeClasses> = {
  indigo: {
    border: 'hover:border-indigo-500/50',
    iconBg: 'bg-indigo-500/20',
    iconText: 'text-indigo-400',
    ctaText: 'text-indigo-400',
    ctaHover: 'hover:text-indigo-300',
  },
  purple: {
    border: 'hover:border-purple-500/50',
    iconBg: 'bg-purple-500/20',
    iconText: 'text-purple-400',
    ctaText: 'text-purple-400',
    ctaHover: 'hover:text-purple-300',
  },
  orange: {
    border: 'hover:border-orange-500/50',
    iconBg: 'bg-orange-500/20',
    iconText: 'text-orange-400',
    ctaText: 'text-orange-400',
    ctaHover: 'hover:text-orange-300',
  },
  pink: {
    border: 'hover:border-pink-500/50',
    iconBg: 'bg-pink-500/20',
    iconText: 'text-pink-400',
    ctaText: 'text-pink-400',
    ctaHover: 'hover:text-pink-300',
  },
  teal: {
    border: 'hover:border-teal-500/50',
    iconBg: 'bg-teal-500/20',
    iconText: 'text-teal-400',
    ctaText: 'text-teal-400',
    ctaHover: 'hover:text-teal-300',
  },
  blue: {
    border: 'hover:border-blue-500/50',
    iconBg: 'bg-blue-500/20',
    iconText: 'text-blue-400',
    ctaText: 'text-blue-400',
    ctaHover: 'hover:text-blue-300',
  },
  yellow: {
    border: 'hover:border-yellow-500/50',
    iconBg: 'bg-yellow-500/20',
    iconText: 'text-yellow-400',
    ctaText: 'text-yellow-400',
    ctaHover: 'hover:text-yellow-300',
  },
  emerald: {
    border: 'hover:border-emerald-500/50',
    iconBg: 'bg-emerald-500/20',
    iconText: 'text-emerald-400',
    ctaText: 'text-emerald-400',
    ctaHover: 'hover:text-emerald-300',
  },
  red: {
    border: 'hover:border-red-500/50',
    iconBg: 'bg-red-500/20',
    iconText: 'text-red-400',
    ctaText: 'text-red-400',
    ctaHover: 'hover:text-red-300',
  },
  cyan: {
    border: 'hover:border-cyan-500/50',
    iconBg: 'bg-cyan-500/20',
    iconText: 'text-cyan-400',
    ctaText: 'text-cyan-400',
    ctaHover: 'hover:text-cyan-300',
  },
};

export function getTheme(colorTheme: string): ThemeClasses {
  return colorThemes[colorTheme] ?? colorThemes.blue!;
}
