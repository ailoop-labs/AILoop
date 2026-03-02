export const RUN_HISTORY_PAGE_SIZE = 5;

export interface RunHistoryPage<T> {
  items: T[];
  currentPage: number;
  totalPages: number;
  startIndex: number;
}

export function paginateRunHistory<T>(items: T[], page: number, pageSize = RUN_HISTORY_PAGE_SIZE): RunHistoryPage<T> {
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : RUN_HISTORY_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize));
  const clampedPage = Math.min(totalPages, Math.max(1, Math.floor(page)));
  const startIndex = (clampedPage - 1) * safePageSize;

  return {
    items: items.slice(startIndex, startIndex + safePageSize),
    currentPage: clampedPage,
    totalPages,
    startIndex
  };
}
