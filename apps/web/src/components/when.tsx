"use client";
import { formatDateTime, isFresh, relativeTime } from "@/lib/format";
/** Relative time for scanning, exact time on hover, and a "new" dot for the last 10 minutes. */
export function When({ iso, label }: { iso?: string | null; label?: string }) {
  return <span className="when" title={formatDateTime(iso)}>{isFresh(iso) && <span className="fresh" aria-label="방금 변경됨" />}{label ? `${label} ` : ""}{relativeTime(iso)}</span>;
}
