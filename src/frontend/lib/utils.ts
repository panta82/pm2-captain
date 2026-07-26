import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) {
    return '—';
  }
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [
    days ? `${days}d` : '',
    hours ? `${hours}h` : '',
    `${minutes}m`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) {
    return '';
  }
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

export function compactPath(path: string | null): string {
  if (!path) {
    return '—';
  }
  const home = path.match(/^\/home\/[^/]+/)?.[0];
  return home ? path.replace(home, '~') : path;
}
