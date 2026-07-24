import { useEffect, useState } from 'react';
import { createRoleSchema, updateRoleSchema } from '@shared/validation/roles.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { validateForm } from '../../utils/validation.js';
import FieldError from '../../components/FieldError.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import PageLoading from '../../components/PageLoading.jsx';

const emptyForm = {
  name: '',
  slug: '',
  description: '',
  permissions: [],
};

export default function AdminRoles() {
  const [roles, setRoles] = useState([]);
  const [permissionGroups, setPermissionGroups] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [editingRole, setEditingRole] = useState(null);
  const [editPermissions, setEditPermissions] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  async function loadData() {
    setLoading(true);
    setError('');
    try {
      const [rolesData, permissionsData] = await Promise.all([
        adminApi.listRoles(),
        adminApi.listPermissions(),
      ]);
      setRoles(rolesData.roles ?? []);
      setPermissionGroups(permissionsData.groups ?? []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  function toggleFormPermission(key) {
    setForm((current) => ({
      ...current,
      permissions: current.permissions.includes(key)
        ? current.permissions.filter((item) => item !== key)
        : [...current.permissions, key],
    }));
  }

  function toggleEditPermission(key) {
    setEditPermissions((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  }

  function renderPermissionMatrix(selected, onToggle, disabled = false) {
    return permissionGroups.map((group) => (
      <div key={group.label} className="permission-group">
        <h3 className="permission-group__title">{group.label}</h3>
        <div className="permission-grid">
          {group.permissions.map((permission) => (
            <label key={permission.key} className="checkbox-row">
              <input
                type="checkbox"
                checked={selected.includes(permission.key)}
                disabled={disabled}
                onChange={() => onToggle(permission.key)}
              />
              <span>{permission.label}</span>
            </label>
          ))}
        </div>
      </div>
    ));
  }

  async function handleCreate(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage('');
    setError('');

    const payload = { ...form, permissions: form.permissions };
    const validation = validateForm(createRoleSchema, payload);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});
    try {
      await adminApi.createRole(validation.data);
      setForm(emptyForm);
      setMessage('Role created successfully.');
      await loadData();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(role) {
    setEditingRole(role);
    setEditPermissions(role.permissions ?? []);
    setMessage('');
    setError('');
  }

  function cancelEdit() {
    setEditingRole(null);
    setEditPermissions([]);
  }

  useEscapeKey(Boolean(editingRole), cancelEdit);

  async function saveEdit(event) {
    event.preventDefault();
    if (!editingRole) return;

    setSubmitting(true);
    setMessage('');
    setError('');

    const validation = validateForm(updateRoleSchema, {
      name: editingRole.name,
      description: editingRole.description ?? '',
      permissions: editPermissions,
    });

    if (!validation.data) {
      setError(Object.values(validation.errors).join(' '));
      setSubmitting(false);
      return;
    }

    try {
      await adminApi.updateRole(editingRole.id, validation.data);
      setMessage(`Role "${editingRole.name}" updated.`);
      cancelEdit();
      await loadData();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <div className="card card--form">
        <p className="card__section-title">Create role</p>
        <p className="card__lead">System roles are seeded and can be edited but not deleted.</p>
        <form className="form-grid" onSubmit={handleCreate}>
          <label>
            Role name
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={80}
            />
            <FieldError message={fieldErrors.name} />
          </label>
          <label className="form-field--sm">
            Slug
            <input
              className="input input--narrow"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              maxLength={50}
              placeholder="office-admin"
            />
            <FieldError message={fieldErrors.slug} />
          </label>
          <label className="form-grid__full">
            Description
            <input
              className="input"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={500}
            />
          </label>
          <div className="form-grid__full">
            {renderPermissionMatrix(form.permissions, toggleFormPermission)}
            <FieldError message={fieldErrors.permissions} />
          </div>
          <div className="form-actions form-actions--sticky">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Create role'}
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
          <p className="card__section-title">Existing roles</p>
        {loading ? (
          <PageLoading compact text="Loading roles…" />
        ) : roles.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.settings}
            title="No roles found"
            description="Create a custom role using the form above."
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Permissions</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td data-label="Name">{role.name}</td>
                    <td data-label="Type">{role.isSystem ? 'System' : 'Custom'}</td>
                    <td data-label="Permissions">{role.permissions?.length ?? 0}</td>
                    <td data-label="Action" className="cell-actions">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => startEdit(role)}>
                        Edit permissions
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </div>

      {editingRole && (
        <div className="card">
          <div className="card__header">
            <div>
              <h2>Edit role: {editingRole.name}</h2>
              <p className="card__desc">
                {editingRole.isSystem ? 'System role — slug cannot be changed.' : 'Custom role'}
              </p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancelEdit}>
              Close
            </button>
          </div>
          <form className="form-grid" onSubmit={saveEdit}>
            <label>
              Role name
              <input
                className="input"
                value={editingRole.name}
                onChange={(e) => setEditingRole({ ...editingRole, name: e.target.value })}
                maxLength={80}
              />
            </label>
            <label className="form-grid__full">
              Description
              <input
                className="input"
                value={editingRole.description ?? ''}
                onChange={(e) => setEditingRole({ ...editingRole, description: e.target.value })}
                maxLength={500}
              />
            </label>
            <div className="form-grid__full">
              {renderPermissionMatrix(editPermissions, toggleEditPermission)}
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
