"use client";

import type { CSSProperties, PointerEvent, ReactNode } from "react";

interface SpotlightCardProps {
  className?: string;
  children: ReactNode;
}

/**
 * A card that lights up under the pointer.
 *
 * The position is written straight onto the element's inline style rather than
 * held in state: this fires on every pointer move, and a re-render per frame
 * for a decorative gradient is the kind of thing that makes a page feel slower
 * the more it is polished. Touch devices never fire it, and the card is fully
 * legible without it.
 */
export function SpotlightCard({ className = "", children }: SpotlightCardProps) {
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const card = event.currentTarget;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    card.style.setProperty("--my", `${event.clientY - rect.top}px`);
  };

  return (
    <article
      className={className}
      onPointerMove={onPointerMove}
      style={{ "--mx": "50%", "--my": "0%" } as CSSProperties}
    >
      {children}
    </article>
  );
}
