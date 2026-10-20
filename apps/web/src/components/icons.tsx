const base = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const PlayIcon = () => <svg {...base}><path d="M7 5v14l11-7z" /></svg>;
export const CalendarIcon = () => <svg {...base}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>;
export const LibraryIcon = () => <svg {...base}><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></svg>;
export const YouIcon = () => <svg {...base}><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5" /></svg>;
export const PinIcon = () => <svg {...base} width={14} height={14}><path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7" /></svg>;
export const BackIcon = () => <svg {...base}><path d="m15 18-6-6 6-6" /></svg>;
export const EyeIcon = () => <svg {...base} width={16} height={16}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>;
export const CheckIcon = () => <svg {...base} width={18} height={18}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
