import { useCallback, useEffect, useRef, useState } from "react";
import type { DoctorReport, Overview } from "@factory/core";

export type { CheckResult, DoctorReport, Overview, ProjectSummary } from "@factory/core";

export interface OverviewResponse extends Overview {
  /** Số việc đang chờ bạn trên mọi dự án. */
  inbox: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} trả về ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  overview: () => getJson<OverviewResponse>("/api/overview"),
  doctor: (refresh = false) => getJson<DoctorReport>(refresh ? "/api/doctor?refresh" : "/api/doctor"),
};

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** Tải dữ liệu một lần và cho phép tải lại. */
export function useLoad<T>(load: (again: boolean) => Promise<T>): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback((again: boolean) => {
    setLoading(true);
    loadRef
      .current(again)
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => run(false), [run]);
  return { data, error, loading, reload: useCallback(() => run(true), [run]) };
}

export type Connection = "connecting" | "open" | "closed";

export interface ServerEvent {
  type: string;
  payload?: unknown;
}

/** Giữ một kết nối WebSocket tới server, tự nối lại khi mất. */
export function useServerEvents(onEvent: (e: ServerEvent) => void): Connection {
  const [state, setState] = useState<Connection>("connecting");
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      setState("connecting");
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${scheme}://${location.host}/ws`);
      ws.onopen = () => {
        attempt = 0;
        setState("open");
      };
      ws.onmessage = (m) => {
        try {
          handler.current(JSON.parse(String(m.data)) as ServerEvent);
        } catch {
          // Bỏ qua tin không đọc được.
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setState("closed");
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return state;
}
