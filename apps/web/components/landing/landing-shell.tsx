"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import styles from "@/app/(landing)/landing.module.css";
import { SiteNav } from "@/components/site-nav/site-nav";

/**
 * The page frame: palette, backdrop, hero, and whatever sections are passed as
 * children. The header is its own component and brings its own state, so this
 * one only decides where it goes.
 *
 * `hero={false}` drops the full-viewport opening and asks the header for its
 * document layout; `chrome={false}` leaves the header out entirely.
 *
 * It stays a client component for one reason: the entrance-motion settling
 * below needs the DOM. Every section passed as a child stays server-rendered.
 */

/** Sets the per-element entrance delay the stylesheet reads as var(--d). */
const delay = (seconds: string): CSSProperties => ({ "--d": seconds }) as CSSProperties;

export function LandingShell({
  children,
  hero = true,
  chrome = true,
}: {
  children: ReactNode;
  hero?: boolean;
  /** Renders the header. Off for pages that supply their own. */
  chrome?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Entrance motion settles itself.
  //
  // `.appear` rests at opacity 1, so the page is readable even if animations
  // never run. Each element marks itself settled on its own animationend; the
  // rAF pass below covers the two cases animationend cannot: animations that
  // never started at all, and elements that are display:none (the burger above
  // 900px) and therefore never fire the event.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const nodes: HTMLElement[] = [
      ...Array.from(root.querySelectorAll<HTMLElement>(`.${styles.appear}`)),
      ...Array.from(root.querySelectorAll<HTMLElement>(`.${styles.heroPhoto}`)),
    ];

    const settle = (el: HTMLElement) => el.classList.add(styles.isIn!);
    const cleanups = nodes.map((el) => {
      const onEnd = () => settle(el);
      el.addEventListener("animationend", onEnd, { once: true });
      return () => el.removeEventListener("animationend", onEnd);
    });

    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const running = nodes.some((el) =>
          typeof el.getAnimations === "function" &&
          el.getAnimations().some((a) => a.playState === "running" || a.playState === "finished"),
        );

        if (!running) {
          nodes.forEach(settle);
          return;
        }

        nodes.forEach((el) => {
          if (typeof el.getAnimations === "function" && el.getAnimations().length === 0) settle(el);
        });
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      cleanups.forEach((off) => off());
    };
  }, []);

  return (
    <div ref={rootRef} className={styles.root}>
      <div className={styles.grain} aria-hidden="true" />
      {hero ? (
        <>
          {/*
            The video is nested rather than carrying .heroPhoto itself: <video>
            is a replaced element, so ::after never renders on it — and ::after
            is the scrim that keeps the headline readable over whatever the
            footage happens to be doing. The gradient underneath stays as the
            fallback for a video that is blocked, still loading, or switched off
            for reduced motion.
          */}
          <div className={styles.heroPhoto} aria-hidden="true">
            <video
              className={styles.heroVideo}
              src="/background-video.mp4"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              // Decorative: it carries no information the copy does not.
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>
        </>
      ) : null}

      {/* Outside the frame below: sticky is bounded by its containing block,
          and that frame is only one viewport tall. */}
      {chrome ? <SiteNav variant={hero ? "landing" : "document"} /> : null}

      {hero ? (
        <div className={styles.page}>
          <>
          <main className={styles.hero} id="top">
            {/*
              Two columns: the headline holds the left, the paragraph and the
              buttons sit beside it behind a hairline. The stylesheet collapses
              them back into one column below 1100px.
            */}
            <div className={styles.heroCopy}>
              <div className={styles.heroLead}>
                <span
                  className={`${styles.badge} ${styles.appear} ${styles.appearPop}`}
                  style={delay("0.22s")}
                >
                  <svg
                    className={styles.badgeStar}
                    width="18"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="#ffffff"
                    aria-hidden="true"
                  >
                    <path d="M12 2.6C12.55 2.6 12.88 3.15 13.08 4.7c.62 4.7 1.52 5.6 6.22 6.22 1.55.2 2.1.53 2.1 1.08s-.55.88-2.1 1.08c-4.7.62-5.6 1.52-6.22 6.22-.2 1.55-.53 2.1-1.08 2.1s-.88-.55-1.08-2.1c-.62-4.7-1.52-5.6-6.22-6.22C3.15 12.88 2.6 12.55 2.6 12s.55-.88 2.1-1.08c4.7-.62 5.6-1.52 6.22-6.22C11.12 3.15 11.45 2.6 12 2.6Z" />
                  </svg>
                  Accountability layer
                </span>

                <h1 className={styles.headline}>
                  <span
                    className={`${styles.headlineLine} ${styles.appear} ${styles.appearMask}`}
                    style={delay("0.42s")}
                  >
                    Coordinate AI agents into
                  </span>
                  <span
                    className={`${styles.headlineLine} ${styles.appear} ${styles.appearMask}`}
                    style={delay("0.62s")}
                  >
                    intelligence you can <em>verify</em>.
                  </span>
                </h1>
              </div>

              <div className={styles.heroSupport}>
                <p
                  className={`${styles.lede} ${styles.appear} ${styles.appearSoft}`}
                  style={delay("0.82s")}
                >
                  Intelligence is easy to generate; trust is not. Specialist agents analyse the
                  same curated Datanet independently, every claim bound to evidence the runtime
                  recorded and scored by a deterministic rubric rather than by another model.
                </p>

                <div className={styles.heroActions}>
                  <a
                    className={`${styles.btn} ${styles.btnSolid} ${styles.appear} ${styles.appearBtn}`}
                    href="/dashboard"
                    style={delay("0.96s")}
                  >
                    Create an intelligence job
                    <svg className={styles.btnArrow} viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M3.4 8h9M8.6 4.2 12.4 8l-3.8 3.8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </a>
                  <a
                    className={`${styles.btn} ${styles.btnGhost} ${styles.appear} ${styles.appearSide}`}
                    href="/datanets"
                    style={delay("1.10s")}
                  >
                    Browse Datanets
                  </a>
                </div>
              </div>
            </div>
          </main>

          <div className={styles.stats}>
            <span
              className={`${styles.stat} ${styles.appear} ${styles.appearStat}`}
              style={delay("1.12s")}
            >
              <svg className={styles.statIcon} viewBox="0 0 24 24" aria-hidden="true">
                <defs>
                  <linearGradient id="averis-pill-a" x1="3" y1="2" x2="14" y2="22" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor="#ffffff" stopOpacity="0.38" />
                    <stop offset="1" stopColor="#3a3a3a" stopOpacity="0.62" />
                  </linearGradient>
                  <linearGradient id="averis-pill-b" x1="3" y1="2" x2="14" y2="22" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor="#3a3a3a" stopOpacity="0.38" />
                    <stop offset="1" stopColor="#ffffff" stopOpacity="0.62" />
                  </linearGradient>
                </defs>
                <rect x="3.4" y="2.6" width="7.2" height="18.8" rx="3.6" fill="url(#averis-pill-a)" />
                <rect x="13.4" y="2.6" width="7.2" height="18.8" rx="3.6" fill="url(#averis-pill-b)" />
                <rect x="9.2" y="10.9" width="5.6" height="2.2" rx="1.1" fill="#4a4a4a" />
              </svg>
              Curated Datanets, read live
            </span>

            <span
              className={`${styles.stat} ${styles.appear} ${styles.appearStat}`}
              style={delay("1.28s")}
            >
              <svg className={styles.statIcon} viewBox="0 0 24 24" aria-hidden="true">
                <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="6.2" fill="#ffffff" />
                <path d="M12 7.1v7.4" stroke="#111" strokeWidth="1.85" strokeLinecap="round" fill="none" />
                <path
                  d="M8.15 12.35L12 16.2l3.85-3.85"
                  stroke="#111"
                  strokeWidth="1.85"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
              Every claim traced to its evidence
            </span>

            <span
              className={`${styles.stat} ${styles.appear} ${styles.appearStat}`}
              style={delay("1.44s")}
            >
              <svg className={styles.statIconWide} viewBox="0 0 40 22" aria-hidden="true">
                <circle cx="10.2" cy="11" r="9.2" fill="#2b2b2b" />
                <path d="M6.55 7.6 5.5 4.05 8.85 5.95Z" fill="#f4f4f4" />
                <path d="M13.85 7.6 14.9 4.05 11.55 5.95Z" fill="#f4f4f4" />
                <ellipse cx="10.2" cy="12.1" rx="4.15" ry="3.7" fill="#f4f4f4" />
                <circle cx="8.75" cy="11.7" r="0.7" fill="#1a1a1a" />
                <circle cx="11.65" cy="11.7" r="0.7" fill="#1a1a1a" />

                <circle cx="20.2" cy="11" r="9.2" fill="#ffffff" />
                <circle cx="17.5" cy="9.5" r="1.7" fill="#111" />
                <circle cx="22.9" cy="9.5" r="1.7" fill="#111" />
                <ellipse cx="20.2" cy="13.1" rx="1.45" ry="1" fill="#111" />
                <path
                  d="M17.35 14.9c.95 1.5 4.65 1.5 5.6 0"
                  stroke="#111"
                  strokeWidth="1.2"
                  fill="none"
                  strokeLinecap="round"
                />

                <circle cx="30.2" cy="11" r="9.2" fill="#e5484d" />
                <text
                  x="30.2"
                  y="15.1"
                  fontSize="12.5"
                  textAnchor="middle"
                  fill="#ffffff"
                  fontFamily="var(--font-inter), Inter, system-ui, sans-serif"
                  fontWeight="700"
                >
                  e
                </text>
              </svg>
              3+ specialist agents, independently
            </span>
          </div>
          </>
        </div>
      ) : null}

      {children}
    </div>
  );
}
