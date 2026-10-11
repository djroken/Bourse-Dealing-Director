"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";

export type FeedMsg =
  | {
      type: "price";
      symbol: string;
      price: number;
      change24h: number | null;
      source: string;
      ts: number;
    }
  | {
      type: "funding";
      symbol: string;
      rate: number;
      ts: number;
    };

export interface LastPrice {
  price: number;
  change24h: number | null;
  source: string;
  ts: number;
  type: "price" | "funding";
}

export interface MarketFeedState {
  prices: Map<string, LastPrice>;
  history: Map<string, number[]>;
  connected: boolean;
  connecting: boolean;
  lastError: string | null;
}

interface MarketFeedContextType extends MarketFeedState {}

export const STALE_MS = 7000;
const MAX_HISTORY = 60;
const RECONNECT_CAP = 15000;

const MarketFeedContext = createContext<MarketFeedContextType | undefined>(
  undefined
);

export function MarketFeedProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MarketFeedState>(() => ({
    prices: new Map<string, LastPrice>(),
    history: new Map<string, number[]>(),
    connected: false,
    connecting: false,
    lastError: null,
  }));

  const attemptRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);

  const endpoint = process.env.NEXT_PUBLIC_CORE_WS || "ws://localhost:4000";

  useEffect(() => {
    cancelledRef.current = false;

    const scheduleReconnect = () => {
      if (cancelledRef.current) return;
      attemptRef.current += 1;
      const delay = Math.min(1500 * attemptRef.current, RECONNECT_CAP);
      setTimeout(() => {
        if (cancelledRef.current) return;
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelledRef.current) return;
      setState((prev) => ({ ...prev, connecting: true, connected: false }));

      let ws: WebSocket;
      try {
        ws = new WebSocket(endpoint);
      } catch (err) {
        setState((prev) => ({
          ...prev,
          connecting: false,
          connected: false,
          lastError: err instanceof Error ? err.message : String(err),
        }));
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelledRef.current) {
          try {
            ws.close();
          } catch {}
          return;
        }
        setState((prev) => ({
          ...prev,
          connected: true,
          connecting: false,
          lastError: null,
        }));
        attemptRef.current = 0;
      };

      ws.onmessage = (ev: MessageEvent) => {
        let msg: FeedMsg;
        try {
          msg = JSON.parse(ev.data) as FeedMsg;
        } catch {
          return;
        }
        setState((prev) => {
          const nextPrices = new Map(prev.prices);
          const nextHistory = new Map(prev.history);

          if (msg.type === "price") {
            nextPrices.set(msg.symbol, {
              price: msg.price,
              change24h: msg.change24h,
              source: msg.source,
              ts: msg.ts,
              type: "price",
            });
            const arr = nextHistory.get(msg.symbol) ?? [];
            arr.push(msg.price);
            if (arr.length > MAX_HISTORY) {
              arr.splice(0, arr.length - MAX_HISTORY);
            }
            nextHistory.set(msg.symbol, arr);
          } else {
            nextPrices.set(msg.symbol, {
              price: msg.rate,
              change24h: null,
              source: "hyperliquid",
              ts: msg.ts,
              type: "funding",
            });
          }
          return {
            ...prev,
            prices: nextPrices,
            history: nextHistory,
          };
        });
      };

      ws.onclose = () => {
        if (cancelledRef.current) {
          setState((prev) => ({
            ...prev,
            connected: false,
            connecting: false,
          }));
          return;
        }
        setState((prev) => ({ ...prev, connected: false, connecting: false }));
        scheduleReconnect();
      };

      ws.onerror = (ev: Event) => {
        const err =
          (ev as { message?: string })?.message ||
          (ev as { error?: { message?: string } })?.error?.message ||
          "WebSocket error";
        setState((prev) => ({
          ...prev,
          connected: false,
          connecting: false,
          lastError: err,
        }));
        try {
          ws.close();
        } catch {}
      };
    };

    connect();

    return () => {
      cancelledRef.current = true;
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  return (
    <MarketFeedContext.Provider
      value={{
        prices: state.prices,
        history: state.history,
        connected: state.connected,
        connecting: state.connecting,
        lastError: state.lastError,
      }}
    >
      {children}
    </MarketFeedContext.Provider>
  );
}

export function useMarketFeed(): MarketFeedContextType {
  const ctx = useContext(MarketFeedContext);
  if (!ctx) {
    throw new Error("useMarketFeed must be used within a MarketFeedProvider");
  }
  return ctx;
}
