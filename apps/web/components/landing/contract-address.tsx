"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import styles from "@/app/(landing)/landing.module.css";
import { TOKEN_ADDRESS } from "@/lib/token";

/**
 * The contract address, with a way to take it.
 *
 * The address itself lives in `lib/token`, beside the call that quotes a price
 * for it — one constant, so the address this prints can never drift from the
 * one the market band is reporting on.
 *
 * The short form is a *display* truncation only. Copying always yields the
 * whole thing, because a partially copied address is the failure this button
 * exists to prevent.
 */
const ADDRESS = TOKEN_ADDRESS;
const SHORT = `${ADDRESS.slice(0, 10)}…${ADDRESS.slice(-8)}`;

export function ContractAddress({
  className = "",
  style,
}: {
  className?: string;
  /** Carries the hero's entrance delay, read by the stylesheet as var(--d). */
  style?: CSSProperties;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A pending timeout that fires after the component is gone would set state
  // on an unmounted tree; it is also the reason a fast second click must
  // replace the first timer rather than add one.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ADDRESS);
    } catch {
      // Clipboard access is refused on insecure origins and in some embedded
      // browsers. The address stays selectable, so this is a lost convenience
      // rather than a lost address, and a thrown error here would be noise.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className={`${styles.contract} ${className}`} style={style}>
      <span className={styles.contractLabel}>Contract</span>

      <code className={styles.contractValue}>
        <span className={styles.contractFull}>{ADDRESS}</span>
        <span className={styles.contractShort} aria-hidden="true">
          {SHORT}
        </span>
      </code>

      <button
        type="button"
        className={styles.contractCopy}
        onClick={copy}
        aria-label={copied ? "Contract address copied" : "Copy contract address"}
      >
        {copied ? (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3.4 8.4 6.3 11.3l6.3-6.3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="5.6"
              y="5.6"
              width="8"
              height="8"
              rx="2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M10.9 3.6a2 2 0 0 0-1.7-1.2H4.4a2 2 0 0 0-2 2v4.8a2 2 0 0 0 1.2 1.7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        )}
        {/* Announced to a screen reader on change; the icon alone is silent. */}
        <span className={styles.srOnly} role="status" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </button>
    </div>
  );
}
