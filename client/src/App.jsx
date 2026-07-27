import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ADMIN_PORTAL_PERMISSIONS, PERMISSIONS } from '@shared/permissions.js';
import AppLayout from './components/AppLayout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import AdminAttendance from './pages/admin/AdminAttendance.jsx';
import AdminBulkUpload from './pages/admin/AdminBulkUpload.jsx';
import AdminDashboard from './pages/admin/AdminDashboard.jsx';
import AdminDepartments from './pages/admin/AdminDepartments.jsx';
import AdminOfficeSettings from './pages/admin/AdminOfficeSettings.jsx';
import AdminRoles from './pages/admin/AdminRoles.jsx';
import AdminUsers from './pages/admin/AdminUsers.jsx';
import AdminEmployeeDetail from './pages/admin/AdminEmployeeDetail.jsx';
import AdminRegisterEmployee from './pages/admin/AdminRegisterEmployee.jsx';
import AdminAuditLogs from './pages/admin/AdminAuditLogs.jsx';
import AdminLeaveApprovals from './pages/admin/AdminLeaveApprovals.jsx';
import AdminLeavePolicies from './pages/admin/AdminLeavePolicies.jsx';
import AdminTeamLeaveCalendar from './pages/admin/AdminTeamLeaveCalendar.jsx';
import AdminStreaks from './pages/admin/AdminStreaks.jsx';
import EmployeeDashboard from './pages/employee/EmployeeDashboard.jsx';
import EmployeeApplyLeave from './pages/employee/EmployeeApplyLeave.jsx';
import EmployeeLeaveBalances from './pages/employee/EmployeeLeaveBalances.jsx';
import EmployeeMyLeaveRequests from './pages/employee/EmployeeMyLeaveRequests.jsx';
import EmployeeHelp from './pages/employee/EmployeeHelp.jsx';
import EmployeePayEstimate from './pages/employee/EmployeePayEstimate.jsx';
import EmployeeHistory from './pages/employee/EmployeeHistory.jsx';
import AdminHelpTeam from './pages/admin/AdminHelpTeam.jsx';
import AdminHelpTickets from './pages/admin/AdminHelpTickets.jsx';
import AdminSalarySummary from './pages/admin/AdminSalarySummary.jsx';
import HelpTicketDetail from './pages/help/HelpTicketDetail.jsx';
import './App.css';

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
        <AuthProvider>
          <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<AuthenticatedShell />}>
              <Route
                path="admin/dashboard"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.USERS_READ}>
                    <AdminDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/users/register"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.USERS_WRITE}>
                    <AdminRegisterEmployee />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/users/bulk-upload"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.USERS_WRITE}>
                    <AdminBulkUpload />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/users/:id"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.USERS_READ}>
                    <AdminEmployeeDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/users"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.USERS_READ}>
                    <AdminUsers />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/roles"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.ROLES_MANAGE}>
                    <AdminRoles />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/departments"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.DEPARTMENTS_MANAGE}>
                    <AdminDepartments />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/office-settings"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.OFFICE_MANAGE}>
                    <AdminOfficeSettings />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/attendance"
                element={
                  <ProtectedRoute
                    portal="admin"
                    anyPermission={[
                      PERMISSIONS.ATTENDANCE_READ_ALL,
                      PERMISSIONS.ATTENDANCE_READ_TEAM,
                    ]}
                  >
                    <AdminAttendance />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/audit-logs"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.AUDIT_READ}>
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
                path="admin/leave/team-calendar"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.LEAVE_MANAGE_POLICIES}>
                    <AdminTeamLeaveCalendar />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/leave/streaks"
                element={
                  <ProtectedRoute
                    portal="admin"
                    anyPermission={[PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM]}
                  >
                    <AdminStreaks />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/leave/policies"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.LEAVE_MANAGE_POLICIES}>
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
                element={<Navigate to="/admin/leave/team-calendar" replace />}
              />
              <Route
                path="admin/salary"
                element={
                  <ProtectedRoute
                    portal="admin"
                    allPermissions={[PERMISSIONS.SALARY_READ, PERMISSIONS.USERS_READ]}
                  >
                    <AdminSalarySummary />
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
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.ATTENDANCE_READ_OWN}>
                    <EmployeeDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/history"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.ATTENDANCE_READ_OWN}>
                    <EmployeeHistory />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/leave/balances"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.LEAVE_READ}>
                    <EmployeeLeaveBalances />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/leave/apply"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.LEAVE_APPLY}>
                    <EmployeeApplyLeave />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/leave/requests"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.LEAVE_READ}>
                    <EmployeeMyLeaveRequests />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/pay-estimate"
                element={
                  <ProtectedRoute portal="employee" permission={PERMISSIONS.SALARY_READ}>
                    <EmployeePayEstimate />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/help"
                element={
                  <ProtectedRoute
                    portal="employee"
                    anyPermission={[PERMISSIONS.HELP_READ, PERMISSIONS.HELP_WRITE]}
                  >
                    <EmployeeHelp />
                  </ProtectedRoute>
                }
              />
              <Route
                path="employee/help/:id"
                element={
                  <ProtectedRoute
                    portal="employee"
                    anyPermission={[PERMISSIONS.HELP_READ, PERMISSIONS.HELP_WRITE]}
                  >
                    <HelpTicketDetail backTo="/employee/help" />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/help/team"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.HELP_MANAGE}>
                    <AdminHelpTeam />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/help/team/:id"
                element={
                  <ProtectedRoute portal="admin" permission={PERMISSIONS.HELP_MANAGE}>
                    <HelpTicketDetail backTo="/admin/help/team" canUpdateStatus />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/help/tickets"
                element={
                  <ProtectedRoute
                    portal="admin"
                    allPermissions={[PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE]}
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
                    allPermissions={[PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE]}
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
      </ToastProvider>
    </ThemeProvider>
  );
}
