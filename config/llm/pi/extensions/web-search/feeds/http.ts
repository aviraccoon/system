/**
 * Shared plain-HTTP constants for feed providers and the host transport.
 * Leaf module — importing from web-fetch.ts from here (or from providers)
 * would cycle (web-fetch → registry → github → web-fetch).
 */

/** Browser-grade User-Agent used for plain HTTP fetches (stealth default;
 * hosts may override per request). */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
