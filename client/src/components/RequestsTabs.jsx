import { useApprovalsBadgeCounts } from '../hooks/useApprovalsBadgeCounts.js';

/**
 * Unified Requests tab bar (Leave | WFH | Comp Off) with pending badges.
 * Rendered by both the approvals page and the comp-off page so the three
 * queues read as one area; only the active tab's list is mounted.
 */
export const REQUEST_TABS = [
  { key: 'leave', label: 'Leave' },
  { key: 'wfh', label: 'WFH' },
  { key: 'compoff', label: 'Comp Off' },
];

export default function RequestsTabs({ active, onSelect }) {
  const { counts } = useApprovalsBadgeCounts();
  const badges = {
    leave: counts?.leave ?? 0,
    wfh: counts?.wfh ?? 0,
    compoff: (counts?.compOff ?? 0) + (counts?.compOffAssessment ?? 0),
  };

  return (
    <div className="requests-tabs" role="tablist" aria-label="Request queues">
      {REQUEST_TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className={`requests-tabs__tab${active === tab.key ? ' requests-tabs__tab--active' : ''}`}
          onClick={() => {
            if (active !== tab.key) onSelect(tab.key);
          }}
        >
          {tab.label}
          {badges[tab.key] > 0 ? (
            <span className="requests-tabs__badge" aria-label={`${badges[tab.key]} pending`}>
              {badges[tab.key] > 99 ? '99+' : badges[tab.key]}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
