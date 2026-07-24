export default function StatusBadge({ active }) {
  return (
    <span className={`badge ${active ? 'badge-success' : 'badge-muted'}`}>
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}
