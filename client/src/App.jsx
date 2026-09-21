import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ADMIN_PORTAL_PERMISSIONS, PERMISSIONS } from '@shared/permissions.js';
import AppLayout from './components/AppLayout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { ActionPopupProvider } from './context/ActionPopupContext.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ResetPasswordPage from './pages/ResetPasswordPage.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import AdminAttendance from './pages/admin/AdminAttendance.jsx';
import AdminTodayPresent from './pages/admin/AdminTodayPresent.jsx';
import AdminBulkUpload from './pages/admin/AdminBulkUpload.jsx';
import AdminDashboard from './pages/admin/AdminDashboard.jsx';
import AdminDepartments from './pages/admin/AdminDepartments.jsx';
import AdminOfficeSettings from './pages/admin/AdminOfficeSettings.jsx';
import AdminFaqDemo from './pages/admin/AdminFaqDemo.jsx';
import AdminRoles from './pages/admin/AdminRoles.jsx';
import AdminRoleManage from './pages/admin/AdminRoleManage.jsx';
import AdminLopCalculation from './pages/admin/AdminLopCalculation.jsx';
import AdminUsers from './pages/admin/AdminUsers.jsx';
import AdminEmployeeDetail from './pages/admin/AdminEmployeeDetail.jsx';
import AdminRegisterEmployee from './pages/admin/AdminRegisterEmployee.jsx';
import AdminAuditLogs from './pages/admin/AdminAuditLogs.jsx';
import AdminLeaveApprovals from './pages/admin/AdminLeaveApprovals.jsx';
import AdminCompOffRequests from './pages/admin/AdminCompOffRequests.jsx';
import AdminLeavePolicies from './pages/admin/AdminLeavePolicies.jsx';
import AdminTeamLeaveCalendar from './pages/admin/AdminTeamLeaveCalendar.jsx';
import AdminStreaks from './pages/admin/AdminStreaks.jsx';
import EmployeeDashboard from './pages/employee/EmployeeDashboard.jsx';
import EmployeeApplyLeave from './pages/employee/EmployeeApplyLeave.jsx';
import EmployeeApplyWfh from './pages/employee/EmployeeApplyWfh.jsx';
import EmployeeCompOff from './pages/employee/EmployeeCompOff.jsx';
import EmployeeLeaveBalances from './pages/employee/EmployeeLeaveBalances.jsx';
import EmployeeMyLeaveRequests from './pages/employee/EmployeeMyLeaveRequests.jsx';
import EmployeeHelp from './pages/employee/EmployeeHelp.jsx';
import EmployeePayEstimate from './pages/employee/EmployeePayEstimate.jsx';
import EmployeeHistory from './pages/employee/EmployeeHistory.jsx';
import AdminHelpTeam from './pages/admin/AdminHelpTeam.jsx';
import AdminHelpTickets from './pages/admin/AdminHelpTickets.jsx';
import AdminSalarySummary from './pages/admin/AdminSalarySummary.jsx';
import TeamSalaryAudit from './pages/admin/TeamSalaryAudit.jsx';
import HelpTicketDetail from './pages/help/HelpTicketDetail.jsx';
import './App.css';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function AuthenticatedShell() {
  return (
    <ProtectedRoute>
      <AppLayout />
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ActionPopupProvider>
          <AuthProvider>
          <BrowserRouter>
          <ScrollToTop />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route element={<AuthenticatedShell />}>
              <Route
                path="admin/dashboard"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.DASHBOARD_ADMIN}>
                    <AdminDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/users/register"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.EMPLOYEES_REGISTER_C} teamCreator>
                    <AdminRegisterEmployee />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/users/bulk-upload"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.EMPLOYEES_BULK_UPLOAD_C}>
                    <AdminBulkUpload />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/users/:id"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.EMPLOYEES_RECORD_R}>
                    <AdminEmployeeDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/users"
                element={
                  <ProtectedRoute
                    portal="admin"
                    anyPermission={[PERMISSIONS.EMPLOYEES_RECORD_R, PERMISSIONS.EMPLOYEES_STATS_R]}
                  >
                    <AdminUsers />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/roles/new"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.RBAC_ROLE_C}>
                    <AdminRoleManage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/roles/:roleId"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.RBAC_ROLE_R}>
                    <AdminRoleManage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/roles"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.RBAC_ROLE_R}>
                    <AdminRoles />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/departments"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.OPS_DEPARTMENT_R}>
                    <AdminDepartments />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/office-settings"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.OPS_GEOFENCE_R}>
                    <AdminOfficeSettings />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/faq-demo"
                element={
                  <ProtectedRoute
                    portal="admin"
                    anyPermission={[PERMISSIONS.OPS_FAQ_R, PERMISSIONS.OPS_GUIDE_R]}
                  >
                    <AdminFaqDemo />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/attendance"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.ATTENDANCE_RECORD_R}>
                    <AdminAttendance />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/attendance/today-present"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.ATTENDANCE_TODAY_R}>
                    <AdminTodayPresent />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/audit-logs"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.AUDIT_LOG_R}>
                    <AdminAuditLogs />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/leave/approvals"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.LEAVE_APPROVE}>
                    <AdminLeaveApprovals />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/leave/comp-off"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.LEAVE_APPROVE}>
                    <AdminCompOffRequests />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/leave/team-calendar"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.LEAVE_HOLIDAY_R}>
                    <AdminTeamLeaveCalendar />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/leave/streaks"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.ATTENDANCE_LATE_WARNING_R}>
                    <AdminStreaks />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/leave/policies"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.LEAVE_POLICY_R}>
                    <AdminLeavePolicies />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/leave/holidays"
                element={<Navigate to="/admin/leave/team-calendar" replace />}
              />
              <Route
                path="admin/leave/balances"
                element={<Navigate to="/admin/leave/policies" replace />}
              />
              <Route
                path="admin/salary"
                element={
                  <ProtectedRoute
                    portal="admin"
                    allPermissions={[PERMISSIONS.SALARY_PAYROLL_R, PERMISSIONS.EMPLOYEES_RECORD_R]}
                  >
                    <AdminSalarySummary />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/salary/lop"
                element={
                  <ProtectedRoute
                    portal="admin"
                    allPermissions={[PERMISSIONS.SALARY_PAYROLL_R, PERMISSIONS.EMPLOYEES_RECORD_R]}
                  >
                    <AdminLopCalculation />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/salary/team"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.SALARY_TEAM_AUDIT_R}>
                    <TeamSalaryAudit />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/profile"
                element={
                  <ProtectedRoute portal="admin" anyPermission={ADMIN_PORTAL_PERMISSIONS}>
                    <ProfilePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/change-password"
                element={
                  <ProtectedRoute portal="admin" anyPermission={ADMIN_PORTAL_PERMISSIONS}>
                    <ChangePassword />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/dashboard"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_DASHBOARD_R}>
                    <EmployeeDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/history"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_ATTENDANCE_R}>
                    <EmployeeHistory />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/leave/balances"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_BALANCE_R}>
                    <EmployeeLeaveBalances />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/leave/apply"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_LEAVE_C}>
                    <EmployeeApplyLeave />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/leave/apply-wfh"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_WFH_C}>
                    <EmployeeApplyWfh />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/leave/comp-off"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_COMPOFF_C}>
                    <EmployeeCompOff />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/leave/requests"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_REQUESTS_R}>
                    <EmployeeMyLeaveRequests />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/pay-estimate"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_PAY_R}>
                    <EmployeePayEstimate />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/faq-demo"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_FAQ_R}>
                    <AdminFaqDemo />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/help"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_TICKET_C}>
                    <EmployeeHelp />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/help/:id"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.EMP_TICKET_C}>
                    <HelpTicketDetail backTo="/employee/help" />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/help/team"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.HELP_TICKET_R}>
                    <AdminHelpTeam />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/help/team/:id"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.HELP_TICKET_R}>
                    <HelpTicketDetail backTo="/admin/help/team" canUpdateStatus />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/help/tickets"
                element={
                  <ProtectedRoute
                    portal="admin"
                    allPermissions={[PERMISSIONS.HELP_TICKET_R, PERMISSIONS.EMPLOYEES_RECORD_R]}
                  >
                    <AdminHelpTickets />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/help/tickets/:id"
                element={
                  <ProtectedRoute
                    portal="admin"
                    allPermissions={[PERMISSIONS.HELP_TICKET_R, PERMISSIONS.EMPLOYEES_RECORD_R]}
                  >
                    <HelpTicketDetail backTo="/admin/help/tickets" canUpdateStatus />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/profile"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.ATTENDANCE_READ_OWN}>
                    <ProfilePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/change-password"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.ATTENDANCE_READ_OWN}>
                    <ChangePassword />
                  </ProtectedRoute>
                }
              />
            </Route>
            <Route path="/" element={<Navigate to="/login" replace />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </BrowserRouter>
                  </AuthProvider>
        </ActionPopupProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
