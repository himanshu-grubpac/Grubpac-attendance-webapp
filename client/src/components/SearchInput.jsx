export default function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  ariaLabel = 'Search',
  className = '',
  onEnter,
  maxLength = 100,
  disabled = false,
}) {
  function handleKeyDown(event) {
    if (event.key === 'Enter' && onEnter) {
      event.preventDefault();
      onEnter();
    }
  }

  return (
    <div className={`search-input${className ? ` ${className}` : ''}`}>
      <span className="search-input__icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
      <input
        type="search"
        className="input search-input__field"
        value={value}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        maxLength={maxLength}
        disabled={disabled}
      />
    </div>
  );
}
