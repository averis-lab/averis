"use client";

import {
  useEffect,
  useRef,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from "react";
import styles from "./reveal.module.css";

interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Entrance delay in seconds, for staggering siblings. */
  delay?: number;
  /** Element to render; the sections use ol/ul/figure as well as div. */
  as?: ElementType;
  /** Reveals direct children one after another instead of as one block. */
  stagger?: boolean;
  id?: string;
}

/**
 * Reveals a block the first time it scrolls into view.
 *
 * The element rests *visible* in CSS and is only armed — hidden, ready to
 * animate — by this effect, and only when it starts below the fold. That
 * ordering is what keeps the page readable when JavaScript never runs, and
 * keeps content that is already on screen from flashing out and back in.
 * A reader who asked for reduced motion is never armed at all.
 */
export function Reveal({
  children,
  className = "",
  delay = 0,
  as,
  id,
  stagger = false,
}: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  const Tag = (as ?? "div") as ElementType;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;

    // Already on screen: leave it alone rather than hide it to animate it.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;

    el.dataset["armed"] = "true";

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add(styles.in!);
          // A module-agnostic hook: other stylesheets cannot name the hashed
          // class above, but any of them can key an effect off this attribute.
          (entry.target as HTMLElement).dataset["revealed"] = "true";
          observer.unobserve(entry.target);
        }
      },
      // Fires a little before the block is fully in view, so the motion has
      // finished by the time the reader's eye reaches it.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      id={id}
      className={`${styles.reveal} ${stagger ? styles.stagger : ""} ${className}`}
      style={delay ? ({ "--reveal-delay": `${delay}s` } as CSSProperties) : undefined}
    >
      {children}
    </Tag>
  );
}
