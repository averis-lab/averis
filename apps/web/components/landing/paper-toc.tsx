"use client";

import { useEffect, useRef, useState } from "react";

interface Entry {
  id: string;
  title: string;
  /** Groups consecutive entries under one heading in the rail. */
  part?: string;
}

interface PaperTocProps {
  entries: Entry[];
  className: string;
  labelClassName: string;
  indexClassName: string;
  activeClassName: string;
  progressClassName: string;
  /** Required once any entry carries a part. */
  partClassName?: string;
}

/**
 * Contents rail for a long document.
 *
 * Two jobs, both about not losing your place: it marks the section you are
 * currently reading, and it draws a progress line down the rail. The active
 * section is the topmost one intersecting a band near the top of the viewport
 * rather than "whatever is most visible" — with sections of wildly different
 * lengths, the most-visible rule flickers between neighbours at every boundary.
 *
 * Entries may declare a `part`. A long paper's rail is unreadable as a flat
 * run of thirty-odd lines, so a part label is drawn above the first entry that
 * opens one — inside that entry's own list item, which keeps the list a list.
 *
 * Everything degrades to a plain anchor list: without JavaScript the rail is
 * still a working table of contents, just without the highlight.
 */
export function PaperToc({
  entries,
  className,
  labelClassName,
  indexClassName,
  activeClassName,
  progressClassName,
  partClassName,
}: PaperTocProps) {
  const [active, setActive] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const visible = useRef<Set<string>>(new Set());

  useEffect(() => {
    const order = entries.map((entry) => entry.id);
    const sections = order
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);

    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (record.isIntersecting) visible.current.add(record.target.id);
          else visible.current.delete(record.target.id);
        }
        const topmost = order.find((id) => visible.current.has(id));
        // Keep the last known heading rather than clearing between sections.
        if (topmost) setActive(topmost);
      },
      { rootMargin: "-12% 0px -72% 0px", threshold: 0 },
    );

    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [entries]);

  useEffect(() => {
    let frame = 0;

    const measure = () => {
      frame = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0);
    };

    // Coalesced to one measurement per frame: scroll fires far more often than
    // the value can be painted.
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

  return (
    <nav className={className} aria-label="Contents">
      <span className={labelClassName}>Contents</span>
      <div className={progressClassName} aria-hidden="true">
        <i style={{ transform: `scaleY(${progress})` }} />
      </div>
      <ol>
        {entries.map((entry, i) => {
          const isActive = active === entry.id;
          const opensPart = entry.part && entry.part !== entries[i - 1]?.part;
          return (
            <li key={entry.id}>
              {opensPart ? <span className={partClassName}>{entry.part}</span> : null}
              <a
                href={`#${entry.id}`}
                className={isActive ? activeClassName : undefined}
                aria-current={isActive ? "true" : undefined}
              >
                <span className={indexClassName}>{String(i + 1).padStart(2, "0")}</span>
                <span>{entry.title}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
