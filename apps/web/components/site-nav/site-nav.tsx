"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { usePathname } from "next/navigation";
import styles from "./site-nav.module.css";
import { AverisMark } from "@/components/averis-mark";

/**
 * Site navigation.
 *
 * Owns its markup, its styles and its state. It applies the open state to the
 * elements that react to it — burger, backdrop, links — rather than to a class
 * on some ancestor, which is what previously meant it could only live inside
 * one particular page shell.
 *
 * Two layouts, one component:
 *
 *  - `landing` measures itself against the viewport, because it sits over a
 *    full-bleed hero.
 *  - `document` shares the reading column's edges, because a row measured
 *    against the viewport drifts further from a centred column the wider the
 *    screen gets.
 *
 * The links are one capsule rather than five separate buttons, and a single
 * marker slides between them. Five lit pills competed with the hero's own call
 * to action; one marker says the same thing and leaves the emphasis where the
 * page wants it.
 */

/** Per-element entrance delay, read by the stylesheet as var(--d). */
const delay = (seconds: string): CSSProperties => ({ "--d": seconds }) as CSSProperties;

// Anchors are absolute, not bare hashes: this nav also sits on /whitepaper,
// where "#how-it-works" would point at a section that is not on the page.
const LINKS = [
  { label: "How it works", href: "/#how-it-works", d: "0.16s" },
  { label: "Whitepaper", href: "/whitepaper", d: "0.24s" },
  { label: "Roadmap", href: "/roadmap", d: "0.32s" },
  { label: "Datanets", href: "/datanets", d: "0.40s" },
  { label: "Developers", href: "/playground", d: "0.48s" },
];

/**
 * Only route links can be current. "/#how-it-works" is a position on the home
 * page, not a destination, so it never claims the marker.
 */
function isCurrent(href: string, pathname: string | null): boolean {
  const path = href.split("#")[0] ?? "";
  if (!pathname || path === "" || path === "/") return false;
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function SiteNav({ variant = "landing" }: { variant?: "landing" | "document" }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [progress, setProgress] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [marker, setMarker] = useState<{ x: number; w: number } | null>(null);

  const pathname = usePathname();
  const isDocument = variant === "document";

  const groupRef = useRef<HTMLDivElement>(null);
  const linkRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  // The marker snaps into place the first time it is needed and tweens after
  // that, so it never slides in from the left edge on the first hover. State
  // rather than a ref, and set from its own effect: the class has to arrive on
  // the render *after* the one that painted the marker, or the first placement
  // would tween from x=0 like every other move.
  const [placed, setPlaced] = useState(false);

  const current = LINKS.findIndex((link) => isCurrent(link.href, pathname));
  const target = hovered ?? (current >= 0 ? current : null);

  // Transparent over a hero, backed once there is content behind it. Measured
  // once per frame: scroll fires far more often than a class can matter.
  useEffect(() => {
    let frame = 0;

    const measure = () => {
      frame = 0;
      setScrolled(window.scrollY > 8);
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // Where the marker sits. Measured from the group, which is its offset parent.
  const place = useCallback(() => {
    const el = target === null ? null : linkRefs.current[target];
    if (!el || !groupRef.current) {
      setMarker(null);
      return;
    }
    setMarker({ x: el.offsetLeft, w: el.offsetWidth });
  }, [target]);

  useEffect(() => {
    place();
  }, [place]);

  useEffect(() => {
    if (!marker || placed) return;
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, [marker, placed]);

  // Web fonts land after first paint and the row reflows at every breakpoint;
  // both move the links out from under a marker measured once.
  useEffect(() => {
    const group = groupRef.current;
    if (!group || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => place());
    observer.observe(group);
    return () => observer.disconnect();
  }, [place]);

  // Escape closes; crossing back to desktop closes.
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const wide = window.matchMedia("(min-width: 901px)");
    const onWide = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);

    // Lock the page behind the full-screen menu.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
      document.body.style.overflow = previous;
    };
  }, [open]);

  const openClass = open ? styles.open : "";
  const tween = placed ? styles.markerTween : "";

  return (
    <>
      <div
        className={`${styles.backdrop} ${openClass}`}
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />

      <div
        className={`${styles.bar} ${isDocument ? styles.barDoc : ""} ${scrolled ? styles.scrolled : ""}`}
      >
        <nav
          className={`${styles.inner} ${isDocument ? styles.innerDoc : ""}`}
          aria-label="Primary"
        >
          <a
            className={`${styles.logo} ${styles.enter}`}
            // On a document page "#top" would only scroll; home is the useful move.
            href={isDocument ? "/" : "#top"}
            aria-label="Averis"
            style={delay("0.08s")}
          >
            <AverisMark style={{ width: "var(--logo-mark, 22px)", height: "var(--logo-mark, 22px)" }} priority />
            <span>Averis</span>
          </a>

          <div
            ref={groupRef}
            className={`${styles.links} ${openClass}`}
            id="site-nav-links"
            onClick={() => setOpen(false)}
            onPointerLeave={() => setHovered(null)}
          >
            <span
              className={`${styles.marker} ${marker ? styles.markerOn : ""} ${tween}`}
              aria-hidden="true"
              style={
                marker
                  ? ({ "--x": `${marker.x}px`, "--w": `${marker.w}px` } as CSSProperties)
                  : undefined
              }
            />

            {LINKS.map((link, index) => (
              <a
                key={link.href}
                ref={(node) => {
                  linkRefs.current[index] = node;
                }}
                className={`${styles.link} ${styles.enter} ${index === current ? styles.linkCurrent : ""}`}
                href={link.href}
                aria-current={index === current ? "page" : undefined}
                style={delay(link.d)}
                onPointerEnter={() => setHovered(index)}
                onFocus={() => setHovered(index)}
                onBlur={() => setHovered(null)}
              >
                {link.label}
              </a>
            ))}
          </div>

          <a className={`${styles.cta} ${styles.enter}`} href="/dashboard" style={delay("0.34s")}>
            Open dashboard
            <svg className={styles.ctaArrow} viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3.5 8h8.2M8.3 4.4 11.9 8l-3.6 3.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>

          <button
            className={`${styles.burger} ${openClass} ${styles.enter}`}
            type="button"
            aria-controls="site-nav-links"
            aria-expanded={open}
            aria-label={open ? "Close menu" : "Open menu"}
            style={delay("0.34s")}
            onClick={() => setOpen((value) => !value)}
          >
            <span />
            <span />
            <span />
          </button>

          {/*
            Reading progress, drawn along the bottom edge of the capsule. The
            document layout leaves it out: /whitepaper already draws a progress
            rail beside its table of contents, and two of them disagree the
            moment either is off by a pixel.
          */}
          {isDocument ? null : (
            <span
              className={styles.progress}
              aria-hidden="true"
              style={{ "--p": progress } as CSSProperties}
            />
          )}
        </nav>
      </div>
    </>
  );
}
