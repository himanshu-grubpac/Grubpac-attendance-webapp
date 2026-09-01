import {
  tableKeyParamSchema,
  updateTablePreferenceSchema,
} from '../../../shared/validation/tablePreference.js';
import {
  getPreference,
  upsertPreference,
  deletePreference,
  getAllowedColumnKeys,
} from '../services/tablePreferenceService.js';

export async function getTablePreference(req, res) {
  const { tableKey } = tableKeyParamSchema.parse(req.params);
  const preference = await getPreference(req.user._id, tableKey, req.userPermissions);
  res.json({ success: true, data: { tableKey, ...preference } });
}

export async function updateTablePreference(req, res) {
  const { tableKey } = tableKeyParamSchema.parse(req.params);
  const update = updateTablePreferenceSchema.parse(req.body);
  const preference = await upsertPreference(req.user._id, tableKey, update, req.userPermissions);
  res.json({ success: true, data: { tableKey, ...preference } });
}

export async function deleteTablePreference(req, res) {
  const { tableKey } = tableKeyParamSchema.parse(req.params);
  const result = await deletePreference(req.user._id, tableKey);
  res.json({ success: true, data: result });
}

export async function getAvailableColumns(req, res) {
  const { tableKey } = tableKeyParamSchema.parse(req.params);
  const allowedKeys = getAllowedColumnKeys(tableKey, req.userPermissions);
  res.json({ success: true, data: { tableKey, columns: allowedKeys } });
}
