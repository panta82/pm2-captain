import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

const STORAGE_KEY = 'pm2-captain:process-sidebar-width';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 232;
const MAX_WIDTH = 480;

function constrainWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

function loadWidth(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_WIDTH;
  }
  const storedWidth = Number(window.localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(storedWidth) && storedWidth > 0
    ? constrainWidth(storedWidth)
    : DEFAULT_WIDTH;
}

export function ResizableSidebar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const [width, setWidth] = useState(loadWidth);
  const widthRef = useRef(width);
  const resizeRef = useRef<{ pointerX: number; width: number } | null>(null);
  const previousBodyStylesRef = useRef<{ cursor: string; userSelect: string } | null>(null);

  const updateWidth = (nextWidth: number) => {
    const constrainedWidth = constrainWidth(nextWidth);
    widthRef.current = constrainedWidth;
    setWidth(constrainedWidth);
  };

  const restoreBodyStyles = () => {
    if (!previousBodyStylesRef.current) {
      return;
    }
    document.body.style.cursor = previousBodyStylesRef.current.cursor;
    document.body.style.userSelect = previousBodyStylesRef.current.userSelect;
    previousBodyStylesRef.current = null;
  };

  const finishResize = () => {
    if (!resizeRef.current) {
      return;
    }
    resizeRef.current = null;
    window.localStorage.setItem(STORAGE_KEY, String(widthRef.current));
    restoreBodyStyles();
  };

  useEffect(() => restoreBodyStyles, []);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeRef.current = { pointerX: event.clientX, width: widthRef.current };
    previousBodyStylesRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) {
      return;
    }
    updateWidth(resizeRef.current.width + event.clientX - resizeRef.current.pointerX);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    updateWidth(widthRef.current + (event.key === 'ArrowRight' ? 16 : -16));
    window.localStorage.setItem(STORAGE_KEY, String(widthRef.current));
  };

  return (
    <aside
      data-component="ResizableSidebar"
      className={cn('relative', className)}
      style={{ width }}
    >
      {children}
      <div
        role="separator"
        aria-label="Resize process sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize the process sidebar"
        className="absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize touch-none bg-transparent outline-none transition-colors hover:bg-cyan/55 focus-visible:bg-cyan/75"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={handleKeyDown}
      />
    </aside>
  );
}
