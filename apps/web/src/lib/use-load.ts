"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, codeOf } from "./api";

/** GET with loading/error state, manual reload and optional background polling (no spinner flicker while polling). */
export function useLoad<T>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const latest = useRef(0);
  const reload = useCallback(async (quiet = false) => {
    if (!path) return;
    const ticket = ++latest.current;
    if (!quiet) setLoading(true);
    try { const result = await api<T>(path); if (ticket === latest.current) { setData(result); setError(null); } }
    catch (e) { if (ticket === latest.current && !quiet) setError(codeOf(e)); }
    finally { if (ticket === latest.current) setLoading(false); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!pollMs || !path) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void reload(true); }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, path, reload]);
  return { data, error, loading, reload: () => reload(true) };
}
/** Mutation helper with a synchronous double-submit guard. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const run = useCallback(async <T,>(name: string, work: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return undefined;
    busy.current = true; setPending(name); setError(null);
    try { return await work(); } catch (e) { setError(codeOf(e)); return undefined; }
    finally { busy.current = false; setPending(null); }
  }, []);
  return { pending, error, run, clearError: () => setError(null) };
}
