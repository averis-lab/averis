"use client";

import { useEffect, useState, type CSSProperties } from "react";
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
  { label: "Developers", href: "/#developers", d: "0.48s" },
];

export function SiteNav({ variant = "landing" }: { variant?: "landing" | "document" }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const isDocument = variant === "document";

  // Transparent over a hero, backed once there is content behind it. Measured
  // once per frame: scroll fires far more often than a class can matter.
  useEffect(() => {
    let frame = 0;

    const measure = () => {
      frame = 0;
      setScrolled(window.scrollY > 8);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

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
            aria-label="Averis.ai"
            style={delay("0.08s")}
          >
            <AverisMark style={{ width: "var(--logo-mark, 22px)", height: "var(--logo-mark, 22px)" }} priority />
            <span>
              Averis<span className={styles.logoSuffix}>.ai</span>
            </span>
          </a>

          <div
            className={`${styles.links} ${openClass}`}
            id="site-nav-links"
            onClick={() => setOpen(false)}
          >
            {LINKS.map((link) => (
              <a
                key={link.href}
                className={styles.enter}
                href={link.href}
                style={delay(link.d)}
              >
                {link.label}
              </a>
            ))}
          </div>

          <a className={`${styles.cta} ${styles.enter}`} href="/dashboard" style={delay("0.34s")}>
            Open dashboard
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
        </nav>
      </div>
    </>
  );
}
