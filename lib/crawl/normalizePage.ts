export default function normalizePage(url: URL): string {
  const { pathname, searchParams } = url;
  const normalizedPathname = pathname
    .split('/')
    .map((part) => (!part || Number.isNaN(Number(part)) ? part : ':param'))
    .join('/');
  return [normalizedPathname, searchParams.toString()]
    .filter(Boolean)
    .join('?');
}
