import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { createRoleSchema, updateRoleSchema } from '@shared/validation/roles.js';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS, filterCatalogForRole } from '@shared/permissions.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { usePageMetaContext } from '../../context/PageMetaContext.jsx';
import BackLink from '../../components/BackLink.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import FieldError from '../../components/FieldError.jsx';
import PageLoading from '../../components/PageLoading.jsx';
import RbacPermissionGrid from '../../components/RbacPermissionGrid.jsx';
import { broadcastPermissionsSync } from '../../utils/portalSync.js';
import { validateForm } from '../../utils/validation.js';

const emptyForm = {
  name: '',
  slug: '',
  description: '',
  permissions: [],
};

export default function AdminRoleManage() {
  const { roleId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { showSuccess } = useToast();
  const { user, refreshUser, hasPermission } = useAuth();
  const { setMeta } = usePageMetaContext();

  const isCreate = !roleId;
  const isViewMode = !isCreate && searchParams.get('mode') === 'view';
  const canUpdate = hasPermission(PERMISSIONS.RBAC_ROLE_U);
  const readOnly = isViewMode || (!isCreate && !canUpdate);

  const [role, setRole] = useState(null);
  const [permissionCatalog, setPermissionCatalog] = useState([]);
  const [permissionMetadata, setPermissionMetadata] = useState({});
  const [totalSlugs, setTotalSlugs] = useState(0);

  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [pageError, setPageError] = useState('');
  const [submitError, setSubmitError] = useState('');

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const requestKeyRef = useRef('');

  const loadData = useCallback(async () => {
    const requestKey = String(Date.now());
    requestKeyRef.current = requestKey;
    setLoading(true);
    setPageError('');

    try {
      const catalogPromise = adminApi.getRbacCatalog();
      const rolesPromise = isCreate ? Promise.resolve({ roles: [] }) : adminApi.listRoles();

      const [catalogData, rolesData] = await Promise.all([catalogPromise, rolesPromise]);
      if (requestKeyRef.current !== requestKey) return;

      setPermissionCatalog(catalogData.catalog ?? []);
      setPermissionMetadata(catalogData.metadata ?? {});
      setTotalSlugs(catalogData.totalSlugs ?? 0);

      if (isCreate) {
        setRole(null);
        setForm(emptyForm);
        return;
      }

      const matchedRole = (rolesData.roles ?? []).find((item) => item.id === roleId) ?? null;
      if (!matchedRole) {
        setRole(null);
        return;
      }

      setRole(matchedRole);
      setForm({
        name: matchedRole.name,
        slug: matchedRole.slug,
        description: matchedRole.description ?? '',
        permissions: matchedRole.permissions ?? [],
      });
    } catch (err) {
      if (requestKeyRef.current !== requestKey) return;
      setPageError(getErrorMessage(err));
    } finally {
      if (requestKeyRef.current === requestKey) {
        setLoading(false);
      }
    }
  }, [isCreate, roleId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (loading) return undefined;

    if (isCreate) {
      setMeta({
        title: 'Add role',
        subtitle: 'Tick what this role may do. Anything left unticked is denied.',
      });
      return () => setMeta(null);
    }

    if (!role) return undefined;

    setMeta({
      title: isViewMode ? `View permissions: ${role.name}` : `Edit role: ${role.name}`,
      subtitle: isViewMode
        ? 'Read-only view of the permissions granted to this role.'
        : role.isSystem
          ? 'Slug cannot be changed for this system role. Display name, description and permissions can be updated — permission changes apply immediately.'
          : 'Update the role details and permission set assigned to users.',
    });
    return () => setMeta(null);
  }, [isCreate, isViewMode, loading, role, setMeta]);

  const roleSlug = isCreate ? null : role?.slug ?? null;

  const pageCatalog = useMemo(() => {
    if (!roleSlug) return permissionCatalog;
    return filterCatalogForRole(permissionCatalog, roleSlug);
  }, [permissionCatalog, roleSlug]);

  const pageTotalSlugs = useMemo(() => {
    if (pageCatalog.length === permissionCatalog.length) return totalSlugs;
    return 0;
  }, [pageCatalog, permissionCatalog, totalSlugs]);

  const slugLocked = !isCreate && Boolean(role?.isSystem);
  const isSystemEdit = !isCreate && Boolean(role?.isSystem);
  const isPermissionsLocked = !isCreate && role?.slug === SYSTEM_ROLE_SLUGS.ADMIN;
  const viewPermissions = role?.permissions ?? [];

  async function refreshPermissionsIfNeeded(savedRole) {
    const actorRoleId = user?.roleId ?? null;
    if (actorRoleId && savedRole?.id === actorRoleId) {
      await refreshUser();
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (readOnly) return;

    setSubmitting(true);
    setSubmitError('');

    if (isCreate) {
      const validation = validateForm(createRoleSchema, form);
      if (!validation.data) {
        setFieldErrors(validation.errors);
        setSubmitting(false);
        return;
      }

      setFieldErrors({});

      try {
        const result = await adminApi.createRole(validation.data);
        broadcastPermissionsSync();
        showSuccess(`Role "${validation.data.name}" created.`);
        await refreshPermissionsIfNeeded(result.role);
        navigate(`/admin/roles/${result.role.id}`, { replace: true });
      } catch (err) {
        setSubmitError(getErrorMessage(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const isAdminRole = role?.slug === SYSTEM_ROLE_SLUGS.ADMIN;
    const validation = validateForm(
      updateRoleSchema,
      isAdminRole
        ? { name: form.name, description: form.description }
        : {
            name: form.name,
            description: form.description,
            permissions: form.permissions,
          },
    );

    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});

    try {
      const result = await adminApi.updateRole(role.id, validation.data);
      broadcastPermissionsSync();
      showSuccess(`Role "${validation.data.name}" updated.`);
      await refreshPermissionsIfNeeded(result.role);
      setRole(result.role);
      setForm({
        name: result.role.name,
        slug: result.role.slug,
        description: result.role.description ?? '',
        permissions: result.role.permissions ?? [],
      });
    } catch (err) {
      setSubmitError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    navigate('/admin/roles');
  }

  if (loading) {
    return (
      <div className="page page--role-manage">
        <PageLoading text={isCreate ? 'Loading…' : 'Loading role…'} />
      </div>
    );
  }

  if (!isCreate && !role) {
    return (
      <div className="page page--role-manage">
        <nav className="employee-detail-back" aria-label="Back navigation">
          <BackLink to="/admin/roles">Roles &amp; Permissions</BackLink>
        </nav>
        <div className="role-manage-empty card">
          <EmptyState
            icon={EMPTY_ICONS.settings}
            title="Role not found"
            description={
              pageError || 'This role may have been removed, or you may not have access to view it.'
            }
            action={
              <Link to="/admin/roles" className="btn btn-primary btn-sm">
                Back to roles
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page page--role-manage">
      <nav className="employee-detail-back" aria-label="Back navigation">
        <BackLink to="/admin/roles">Roles &amp; Permissions</BackLink>
      </nav>

      {pageError ? <div className="alert alert--error">{pageError}</div> : null}

      {isViewMode ? (
        <div className="role-manage-form role-manage-form--view">
          <section
            className="register-section card role-manage-section role-manage-permissions"
            aria-labelledby="role-permissions-title"
          >
            <header className="register-section__header">
              <h2 id="role-permissions-title" className="register-section__title">
                Permissions
              </h2>
              <p className="register-section__lead muted">
                Read-only view of the permissions granted to this role.
              </p>
            </header>

            <div className="role-manage-section__body">
              <RbacPermissionGrid
                catalog={pageCatalog}
                metadata={permissionMetadata}
                totalSlugs={pageTotalSlugs}
                selected={viewPermissions}
                onChange={() => {}}
                disabled
                hideActions
              />
            </div>
          </section>

          <footer className="register-form__footer">
            {canUpdate ? (
              <Link to={`/admin/roles/${role.id}`} className="btn btn-ghost">
                Edit role
              </Link>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={handleCancel}>
              Back to roles
            </button>
          </footer>
        </div>
      ) : (
        <form className="role-manage-form" onSubmit={handleSubmit} noValidate>
          <section
            className="register-section card role-manage-section"
            aria-labelledby="role-details-title"
          >
            <header className="register-section__header">
              <h2 id="role-details-title" className="register-section__title">
                {isCreate ? 'Role details' : `Edit role: ${role.name}`}
              </h2>
              <p className="register-section__lead muted">
                {isCreate
                  ? 'Name and describe the role before assigning permissions below.'
                  : slugLocked
                    ? 'Slug cannot be changed for this system role. Display name and description can be updated on save.'
                    : 'Update the role details assigned to users.'}
              </p>
            </header>

            <div className="role-manage-section__body">
              {submitError ? <div className="alert alert--error">{submitError}</div> : null}

              <div className="role-manage__fields-row">
                <label className="role-manage-field form-field--sm">
                  <span className="label">Role name</span>
                  <input
                    autoFocus
                    className="input"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    maxLength={80}
                    placeholder="e.g. Office admin"
                    disabled={readOnly || submitting}
                  />
                  {!isCreate ? (
                    <span className="role-manage__key-caption muted">
                      key: <code>{form.slug}</code>
                    </span>
                  ) : null}
                  <FieldError message={fieldErrors.name} />
                </label>

                {isCreate ? (
                  <label className="role-manage-field form-field--sm">
                    <span className="label">Slug</span>
                    <input
                      className="input input--narrow"
                      value={form.slug}
                      onChange={(event) =>
                        setForm({ ...form, slug: event.target.value.toLowerCase() })
                      }
                      maxLength={50}
                      placeholder="office-admin"
                      disabled={submitting}
                    />
                    <FieldError message={fieldErrors.slug} />
                  </label>
                ) : null}
              </div>

              <label className="role-manage-field">
                <span className="label">Description</span>
                <input
                  className="input"
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  maxLength={500}
                  placeholder="Optional summary for admins"
                  disabled={readOnly || submitting}
                />
                <FieldError message={fieldErrors.description} />
              </label>

            </div>
          </section>

          <section
            className="register-section card role-manage-section role-manage-permissions"
            aria-labelledby="role-permissions-title"
          >
            <header className="register-section__header">
              <h2 id="role-permissions-title" className="register-section__title">
                Permissions
              </h2>
              <p className="register-section__lead muted">
                {isPermissionsLocked
                  ? 'Admin role permissions are fixed and cannot be modified.'
                  : isSystemEdit
                    ? 'Changes apply to this role immediately on save.'
                    : 'Tick what this role may do. Anything left unticked is denied.'}
              </p>
            </header>

            <div className="role-manage-section__body">
              <RbacPermissionGrid
                catalog={pageCatalog}
                metadata={permissionMetadata}
                totalSlugs={pageTotalSlugs}
                selected={form.permissions}
                onChange={(permissions) => setForm({ ...form, permissions })}
                disabled={isPermissionsLocked || readOnly || submitting}
                hideActions={isPermissionsLocked}
              />
              <FieldError message={fieldErrors.permissions} />
            </div>
          </section>

          <footer className="register-form__footer">
            <button
              type="button"
              className="btn btn-ghost register-form__cancel"
              onClick={handleCancel}
              disabled={submitting}
            >
              Cancel
            </button>
            {!readOnly ? (
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Saving…' : isCreate ? 'Create role' : 'Save changes'}
              </button>
            ) : null}
          </footer>
        </form>
      )}
    </div>
  );
}
