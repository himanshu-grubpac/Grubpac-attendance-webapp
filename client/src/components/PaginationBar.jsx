function buildPageList(page, totalPages) {
  if (totalPages <= 1) return totalPages === 1 ? [1] : [];

  const pages = new Set([1, totalPages]);
  for (let i = page - 2; i <= page + 2; i += 1) {
    if (i >= 1 && i <= totalPages) pages.add(i);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const result = [];
  let prev = 0;

  for (const pageNum of sorted) {
    if (pageNum - prev > 1) result.push('…');
    result.push(pageNum);
    prev = pageNum;
  }

  return result;
}

export default function PaginationBar({ pagination, onPageChange }) {
  if (!pagination || pagination.total <= 0) return null;

  const { page, limit, total, totalPages } = pagination;
  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  const pageList = buildPageList(page, totalPages);

  return (
    <div className="pagination-bar">
      <span className="pagination-bar__info">
        Showing {start}–{end} of {total}
      </span>

      {totalPages > 1 && (
        <div className="pagination-bar__controls">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </button>

          <div className="pagination-bar__pages" role="navigation" aria-label="Pagination">
            {pageList.map((item, index) =>
              item === '…' ? (
                <span key={`ellipsis-${index}`} className="pagination-bar__ellipsis" aria-hidden="true">
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  className={`pagination-bar__page${item === page ? ' pagination-bar__page--active' : ''}`}
                  aria-current={item === page ? 'page' : undefined}
                  onClick={() => onPageChange(item)}
                >
                  {item}
                </button>
              ),
            )}
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
