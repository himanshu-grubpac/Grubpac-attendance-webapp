import { useEffect, useState } from 'react';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
} from '@shared/validation/departments.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { validateForm } from '../../utils/validation.js';
import FieldError from '../../components/FieldError.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import PageLoading from '../../components/PageLoading.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const emptyForm = {
  name: '',
  code: '',
};

export default function AdminDepartments() {
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [departments, setDepartments] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [editing, setEditing] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  async function loadDepartments() {
    setLoading(true);
    setError('');
    try {
      const data = await adminApi.listDepartments();
      setDepartments(data.departments ?? []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDepartments();
  }, []);

  async function handleCreate(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage('');
    setError('');

    const validation = validateForm(createDepartmentSchema, form);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});
    try {
      await adminApi.createDepartment(validation.data);
      setForm(emptyForm);
      setMessage('Department created successfully.');
      await loadDepartments();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(department) {
    const nextActive = !department.isActive;
    await requestConfirm({
      title: nextActive ? 'Activate department?' : 'Deactivate department?',
      message: nextActive
        ? `Activate “${department.name}”?`
        : `Deactivate “${department.name}”? It will no longer be available for new assignments.`,
      confirmLabel: nextActive ? 'Activate' : 'Deactivate',
      variant: nextActive ? 'default' : 'danger',
      onConfirm: async () => {
        await adminApi.updateDepartment(department.id, { isActive: nextActive });
        await loadDepartments();
      },
    });
  }

  async function handleEditSave(event) {
    event.preventDefault();
    if (!editing) return;

    setSubmitting(true);
    setMessage('');
    setError('');

    const validation = validateForm(updateDepartmentSchema, {
      name: editing.name,
      code: editing.code,
    });

    if (!validation.data) {
      setError(Object.values(validation.errors).join(' '));
      setSubmitting(false);
      return;
    }

    try {
      await adminApi.updateDepartment(editing.id, validation.data);
      setMessage(`Department "${editing.name}" updated.`);
      setEditing(null);
      await loadDepartments();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  useEscapeKey(Boolean(editing), () => setEditing(null));

  return (
    <div className="page">
      <div className="card card--form">
        <p className="card__section-title">Add department</p>
        <form className="form-grid" onSubmit={handleCreate}>
          <label>
            Department name
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={100}
            />
            <FieldError message={fieldErrors.name} />
          </label>
          <label className="form-field--sm">
            Code
            <input
              className="input input--narrow"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              maxLength={20}
              placeholder="DEV"
            />
            <FieldError message={fieldErrors.code} />
          </label>
          <div className="form-actions form-actions--sticky">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Create department'}
            </button>
          </div>
        </form>
        {(message || error) && (
          <div className="page-alerts alert--inset">
            {message && <div className="alert alert--success">{message}</div>}
            {error && <div className="alert alert--error">{error}</div>}
          </div>
        )}
      </div>

      <div className="card card--table">
        <div className="card__section">
          <p className="card__section-title">Department list</p>
        {loading ? (
          <PageLoading compact text="Loading departments…" />
        ) : departments.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.settings}
            title="No departments yet"
            description="Create a department using the form above."
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Code</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {departments.map((department) => (
                  <tr key={department.id}>
                    <td data-label="Name">{department.name}</td>
                    <td data-label="Code">{department.code}</td>
                    <td data-label="Status">
                      <StatusBadge active={department.isActive} />
                    </td>
                    <td data-label="Action">
                      <div className="toolbar__right">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setEditing({ ...department })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => toggleActive(department)}
                        >
                          {department.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </div>

      {editing && (
        <div className="card">
          <div className="card__header">
            <h2>Edit department</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
              Close
            </button>
          </div>
          <form className="form-grid" onSubmit={handleEditSave}>
            <label>
              Department name
              <input
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                maxLength={100}
              />
            </label>
            <label className="form-field--sm">
              Code
              <input
                className="input input--narrow"
                value={editing.code}
                onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                maxLength={20}
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmDialog}
    </div>
  );
}
