import { SalaryHistorySection, TeamAuditSection } from './SalaryAuditSections.jsx';

export default function TeamSalaryAudit() {
  return (
    <div className="page page--salary">
      <TeamAuditSection allowDownload title="Team salary audit" />
      <SalaryHistorySection title="Team member salary history" />
    </div>
  );
}
