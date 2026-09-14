import ApplyLeaveForm from './ApplyLeaveForm.jsx';

/** Apply Leave — all active types except WFH (WFH lives on Apply WFH). */
export default function EmployeeApplyLeave() {
  return <ApplyLeaveForm mode="leave" />;
}
