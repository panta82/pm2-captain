import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

export function TruncatedText({ text, className }: { text: string; className?: string }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const overlayRef = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [overlayStyle, setOverlayStyle] = useState<CSSProperties>({});

  useEffect(() => {
    const element = textRef.current;
    if (!element) {
      return;
    }

    const updateTruncation = () => {
      setIsTruncated(element.scrollWidth - element.clientWidth > 1);
    };

    updateTruncation();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(updateTruncation);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    if (!isTruncated) {
      setIsOpen(false);
    }
  }, [isTruncated]);

  useLayoutEffect(() => {
    if (!isOpen || !textRef.current) {
      return;
    }
    const rect = textRef.current.getBoundingClientRect();
    const maxWidth = Math.min(320, window.innerWidth - 16);
    const left = Math.min(rect.left, Math.max(8, window.innerWidth - 8 - maxWidth));
    setOverlayStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left,
      maxWidth,
    });
  }, [isOpen, text]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const close = () => setIsOpen(false);
    // Capture, so Escape only closes the overlay, ahead of the page's own use of it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || overlayRef.current?.contains(target)) {
        return;
      }
      close();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', close);
    };
  }, [isOpen]);

  return (
    <span
      ref={rootRef}
      data-component="TruncatedText"
      className={cn('relative block min-w-0 max-w-full', className)}
    >
      <span
        ref={textRef}
        title={isTruncated ? text : undefined}
        tabIndex={isTruncated ? 0 : undefined}
        role={isTruncated ? 'button' : undefined}
        aria-expanded={isTruncated ? isOpen : undefined}
        className={cn('block truncate', isTruncated && 'cursor-pointer')}
        onClick={() => {
          if (isTruncated) {
            setIsOpen(open => !open);
          }
        }}
        onKeyDown={event => {
          if (!isTruncated) {
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setIsOpen(open => !open);
          }
        }}
      >
        {text}
      </span>
      {isOpen
        ? createPortal(
            <span
              ref={overlayRef}
              data-component="TruncatedText"
              role="tooltip"
              style={overlayStyle}
              className="z-50 rounded-lg border border-line bg-surface-plane px-2.5 py-1.5 text-left text-xs font-semibold break-words whitespace-normal text-white shadow-xl"
            >
              {text}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}
