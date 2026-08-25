"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Refreshes the server-rendered page while a job is still in flight.
 *
 * A job moves through seven states in a couple of seconds, so a static render
 * would show a stale status. Polling stops as soon as the job is terminal.
 */
export function AutoRefresh({ active, intervalMs = 1500 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);

  return null;
}
