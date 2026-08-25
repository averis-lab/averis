import Image from "next/image";
import styles from "./averis-mark.module.css";
import type { CSSProperties } from "react";

interface AverisMarkProps {
  /** Fixed pixel size. Omit and pass `style` to let CSS drive it instead. */
  size?: number;
  style?: CSSProperties;
  className?: string;
  /** Set on the header mark, which is above the fold on every route. */
  priority?: boolean;
}

/**
 * The Averis logo.
 *
 * Decorative by design: every place it appears sits next to the wordmark or
 * inside a labelled link, so an alt text here would be read out twice. The
 * source art is a square with generous padding around the mark, so the
 * stylesheet clips and scales it slightly — at 22px the untrimmed version
 * reads as a red tile with a small glyph floating in it.
 */
export function AverisMark({ size, style, className = "", priority = false }: AverisMarkProps) {
  return (
    <span
      className={`${styles.mark} ${className}`}
      style={size ? { width: size, height: size, ...style } : style}
    >
      <Image
        className={styles.image}
        src="/averis-logo.png"
        alt=""
        width={64}
        height={64}
        priority={priority}
      />
    </span>
  );
}
