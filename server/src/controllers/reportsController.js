import { getAdminReportsSummary } from '../services/reportsService.js';

export async function getReportsSummaryHandler(req, res) {
  const summary = await getAdminReportsSummary(req.user, req.userPermissions);
  res.json({ summary });
}
