import normalizePage from './normalizePage.js';
import { duplicatePageCount, DUPLICATE_PAGE_COUNT_THRESHOLD } from './crawl.js';

export function recordPage(url: URL): boolean {
  const normalizedUri = normalizePage(url);
  const count = duplicatePageCount.get(normalizedUri) || 0;
  duplicatePageCount.set(normalizedUri, count + 1);
  return count < DUPLICATE_PAGE_COUNT_THRESHOLD;
}
