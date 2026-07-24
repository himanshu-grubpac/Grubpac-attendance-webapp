export default function SearchField({
  value,
  onChange,
  onSubmit,
  placeholder = 'Search…',
  'aria-label': ariaLabel = 'Search',
  maxLength = 100,
  className = '',
}) {
  function handleSubmit(event) {
    event.preventDefault();
    onSubmit?.(event);
  }

  return (
    <form
      className={`search-field${className ? ` ${className}` : ''}`}
      role="search"
      onSubmit={handleSubmit}
    >
      <span className="search-field__icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
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
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        maxLength={maxLength}
        aria-label={ariaLabel}
      />
    </form>
  );
}
