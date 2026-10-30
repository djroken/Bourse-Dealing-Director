import { createHash } from 'node:crypto';

/**
 * Headlines from free public RSS/Atom feeds, for the Research seat and the Desk's news panel.
 *
 * Every byte here is untrusted: a feed can carry markup, scripts, absurd lengths or text written to steer a model.
 * Titles are reduced to plain text and capped; links must be http(s); nothing from a feed is ever executed, and
 * agents only ever see headlines inside a quoted, labelled block.
 */

export interface Headline {
  id: string;
  source: string;
  title: string;
  url: string | null;
  /** When the feed says it was published (ms), or when core first saw it. */
  publishedAt: number;
  tag: 'MACRO' | 'FLOW' | 'VENUE' | 'ON-CHAIN' | 'MARKET';
  /** Floor symbols the headline names, e.g. ["BTC-USDT"]. */
  symbols: string[];
}

export interface Feed {
  name: string;
  url: string;
}

/** Free, no key. Override with BOURSE_NEWS_FEEDS. */
export const DEFAULT_FEEDS: Feed[] = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
];

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

/** Markup and entities to plain, single-line, printable text. */
export function plain(raw: string, max = 200): string {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (let i = 0; i < 2; i++) {
    // twice: feeds often double-encode (&amp;lt;b&amp;gt;)
    s = s
      .replace(/<[^>]*>/g, ' ')
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
      .replace(/&#(\d{1,7});/g, (_, d: string) => safeChar(Number(d)))
      .replace(/&([a-z]+);/gi, (m, n: string) => ENT[n.toLowerCase()] ?? m);
  }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
const safeChar = (n: number): string => (n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ');

const tagText = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1]! : null;
};
const safeUrl = (u: string | null): string | null => {
  if (!u) return null;
  const s = plain(u, 400);
  try {
    const p = new URL(s);
    return (p.protocol === 'https:' || p.protocol === 'http:') && s.length <= 300 ? p.toString() : null;
  } catch {
    return null;
  }
};

const TAGS: Array<[Headline['tag'], RegExp]> = [
  ['MACRO', /\b(fed|fomc|powell|cpi|inflation|rate (cut|hike)s?|interest rates?|treasur(y|ies)|yields?|jobs report|payrolls|gdp|recession|tariffs?|central bank|ecb)\b/i],
  ['FLOW', /\b(etfs?|inflows?|outflows?|fund flows?|blackrock|grayscale|treasury company|buys? \$?[\d.]+ ?(million|billion|[mb]n?)\b|liquidat(ed|ions?))\b/i],
  ['VENUE', /\b(exchange|binance|coinbase|kraken|bybit|okx|hyperliquid|listing|delist(s|ing)?|outage|hack(ed)?|exploit(ed)?)\b/i],
  ['ON-CHAIN', /\b(on-?chain|wallets?|whales?|stablecoins?|tvl|defi|dex(es)?|staking|validators?|bridge|aave|uniswap|lido|address(es)?)\b/i],
];
export const tagOf = (title: string): Headline['tag'] => TAGS.find(([, re]) => re.test(title))?.[0] ?? 'MARKET';

const NAMES: Record<string, string[]> = { BTC: ['bitcoin'], ETH: ['ethereum', 'ether'], SOL: ['solana'], BNB: ['bnb chain'], XRP: ['ripple'], DOGE: ['dogecoin'], ADA: ['cardano'] };
/** Floor symbols a headline names, by ticker or common name ("Bitcoin" → BTC-USDT, "NVDA" or "Nvidia"? only tickers for stocks). */
export function symbolsIn(title: string, symbols: string[]): string[] {
  const out: string[] = [];
  for (const sym of symbols) {
    const base = sym.replace(/-USDT$/, '');
    const words = [base, ...(sym.endsWith('-USDT') ? NAMES[base] ?? [] : [])];
    if (words.some((w) => new RegExp(`(^|[^A-Za-z0-9$])\\$?${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, w === base ? '' : 'i').test(title))) out.push(sym);
  }
  return out;
}

/** RSS <item> or Atom <entry> blocks to headlines. At most `limit`; anything malformed is skipped. */
export function parseFeed(xml: string, source: string, symbols: string[], seenAt: number, limit = 20): Headline[] {
  const blocks = xml.slice(0, 1_000_000).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const out: Headline[] = [];
  for (const b of blocks.slice(0, limit)) {
    const title = plain(tagText(b, 'title') ?? '');
    if (title.length < 8) continue;
    const link = safeUrl(tagText(b, 'link')?.trim() || b.match(/<link[^>]*href="([^"]+)"/i)?.[1] || tagText(b, 'guid'));
    const when = Date.parse(plain(tagText(b, 'pubDate') ?? tagText(b, 'published') ?? tagText(b, 'updated') ?? tagText(b, 'dc:date') ?? '', 64));
    // A date from the future, or none at all, becomes the time core first saw it.
    const publishedAt = Number.isFinite(when) && when <= seenAt + 5 * 60_000 ? when : seenAt;
    const id = createHash('sha1').update(`${source}|${link ?? title}`).digest('hex').slice(0, 16);
    out.push({ id, source, title, url: link, publishedAt, tag: tagOf(title), symbols: symbolsIn(title, symbols) });
  }
  return out;
}

export type TextFetch = (url: string) => Promise<string>;

/** fetch for feeds: 10 s timeout, at most 1 MB read, XML or RSS content types only. */
export const fetchFeedText: TextFetch = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = r.headers.get('content-type') ?? '';
  if (type && !/xml|rss|atom|text\/plain/i.test(type)) throw new Error(`not a feed (${type.slice(0, 40)})`);
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > 1_000_000) throw new Error('feed too large');
  return (await r.text()).slice(0, 1_000_000);
};

/** BOURSE_NEWS_FEEDS: "off", or comma-separated https URLs (optionally "Name=https://…"). Max 8. */
export function parseFeedList(v: string | undefined): Feed[] {
  if (v === undefined || v.trim() === '') return DEFAULT_FEEDS;
  if (/^(off|0|false|no|none)$/i.test(v.trim())) return [];
  const out: Feed[] = [];
  for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    const [name, url] = eq > 0 && !part.slice(0, eq).includes('/') ? [part.slice(0, eq).trim(), part.slice(eq + 1).trim()] : [null, part];
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') throw new Error();
      host = u.hostname;
    } catch {
      throw new Error(`BOURSE_NEWS_FEEDS: "${part}" is not an https URL`);
    }
    out.push({ name: plain(name || host.replace(/^www\./, ''), 32), url });
  }
  if (out.length > 8) throw new Error('BOURSE_NEWS_FEEDS: at most 8 feeds');
  return out;
}

/** Polls the feeds, keeps the newest headlines, reports only ones it hasn't seen. */
export function createNewsDesk(opts: { feeds: Feed[]; fetchText: TextFetch; symbols: () => string[]; now?: () => number; onNew: (h: Headline[]) => void; log?: { warn: (m: string) => void } }) {
  const now = opts.now ?? Date.now;
  const seen = new Set<string>();
  let latest: Headline[] = [];
  const status = new Map<string, { ok: boolean; at: number; error?: string; items: number }>();
  let timer: NodeJS.Timeout | undefined;

  async function poll(): Promise<Headline[]> {
    const t = now();
    const got = await Promise.all(
      opts.feeds.map(async (f) => {
        try {
          const items = parseFeed(await opts.fetchText(f.url), f.name, opts.symbols(), t);
          status.set(f.name, { ok: true, at: t, items: items.length });
          return items;
        } catch (e) {
          const error = e instanceof Error ? e.message.slice(0, 120) : 'failed';
          status.set(f.name, { ok: false, at: t, error, items: 0 });
          opts.log?.warn(`news feed ${f.name} unavailable: ${error}`);
          return [];
        }
      }),
    );
    const fresh = got.flat().filter((h) => !seen.has(h.id) && t - h.publishedAt < 48 * 3_600_000);
    for (const h of fresh) seen.add(h.id);
    if (seen.size > 5_000) for (const id of [...seen].slice(0, 2_500)) seen.delete(id);
    latest = [...fresh, ...latest].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 40);
    const newest = fresh.sort((a, b) => a.publishedAt - b.publishedAt);
    if (newest.length) opts.onNew(newest);
    return newest;
  }

  return {
    poll,
    latest: () => latest,
    status: () => ({ feeds: opts.feeds.map((f) => ({ name: f.name, url: f.url, ...(status.get(f.name) ?? { ok: false, at: 0, items: 0, error: 'not polled yet' }) })), headlines: latest.length }),
    start(everyMs = 5 * 60_000): void {
      if (!opts.feeds.length || timer) return;
      void poll();
      timer = setInterval(() => void poll(), everyMs);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type NewsDesk = ReturnType<typeof createNewsDesk>;
