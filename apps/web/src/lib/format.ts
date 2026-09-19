import { parseKrw, fromTokenUnits, MOCK_TOKEN_DECIMALS } from "@paidahead/domain";

/** Amounts stay bigint/decimal strings end to end; Number is never used for money. */
export function groupDigits(digits: string): string { return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
export function formatKrw(value: string | bigint | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  try { return `${groupDigits(parseKrw(value.toString()).toString())}원`; } catch { return "-"; }
}
export function krwDifference(face: string, purchase: string): string {
  const diff = parseKrw(face) - parseKrw(purchase);
  return diff < 0n ? "-" : formatKrw(diff);
}
/** Mock token raw units (6 decimals) → display. Whole-KRW values reuse the domain conversion. */
export function formatTokenRaw(raw: string | bigint): string {
  const value = BigInt(raw);
  try { return `${groupDigits(fromTokenUnits(value))} mKRW`; } catch {
    const unit = 10n ** BigInt(MOCK_TOKEN_DECIMALS);
    const fraction = (value % unit).toString().padStart(MOCK_TOKEN_DECIMALS, "0").replace(/0+$/, "");
    return `${groupDigits((value / unit).toString())}${fraction ? `.${fraction}` : ""} mKRW`;
  }
}
/** Digits-only user input → canonical KRW string, or null when invalid/zero. */
export function normalizeKrwInput(input: string): string | null {
  const digits = input.replace(/[,\s원]/g, "");
  if (!/^[0-9]{1,19}$/.test(digits)) return null;
  try { const amount = parseKrw(BigInt(digits).toString()); return amount > 0n ? amount.toString() : null; } catch { return null; }
}
export function multiplyKrw(quantity: string, unitPrice: string): bigint | null {
  if (!/^[1-9][0-9]{0,6}$/.test(quantity)) return null;
  const price = normalizeKrwInput(unitPrice);
  return price ? BigInt(quantity) * BigInt(price) : null;
}
const dateTime = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" });
const dateOnly = new Intl.DateTimeFormat("ko-KR", { dateStyle: "long", timeZone: "Asia/Seoul" });
export const formatDateTime = (iso?: string | null) => (iso ? dateTime.format(new Date(iso)) : "-");
export const formatDate = (iso?: string | null) => (iso ? dateOnly.format(new Date(iso)) : "-");
export function daysUntil(iso: string, now = Date.now()): string {
  const days = Math.ceil((new Date(iso).getTime() - now) / 86400000);
  return days > 0 ? `${days}일 남음` : days === 0 ? "오늘 만기" : `${-days}일 지남`;
}
/** `<input type="datetime-local">` (browser-local) → ISO-8601 with whole seconds, as the API requires. */
export function localInputToIso(value: string): string | null {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(Math.floor(time / 1000) * 1000).toISOString() : null;
}
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export const shortAddress = (address?: string | null) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "-");
export const shortHash = (hash?: string | null) => (hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "-");
/** "방금 · 5분 전 · 3시간 전 · 어제 · 4일 전", then a date. Recent activity reads at a glance; exact time stays in the title attribute. */
export function relativeTime(iso?: string | null, now = Date.now()): string {
  if (!iso) return "-";
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  if (minutes < 2880) return "어제";
  return minutes < 10080 ? `${Math.floor(minutes / 1440)}일 전` : formatDate(iso);
}
export const isFresh = (iso?: string | null, now = Date.now()) => !!iso && now - new Date(iso).getTime() < 10 * 60000;
