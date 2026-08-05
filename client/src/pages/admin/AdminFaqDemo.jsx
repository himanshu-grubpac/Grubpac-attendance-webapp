import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  createDemoFaqSchema,
  updateDemoFaqSchema,
} from '@shared/validation/demoFaq.js';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS } from '@shared/permissions.js';
import { demoFaqApi, getErrorMessage } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { validateForm } from '../../utils/validation.js';
import ActionMenu from '../../components/ActionMenu.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import FieldError from '../../components/FieldError.jsx';
import MultiSelectField from '../../components/MultiSelectField.jsx';
import SelectField from '../../components/SelectField.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

/* ── Constants ── */

const ROLE_OPTIONS = [
  { value: SYSTEM_ROLE_SLUGS.ADMIN, label: 'Admin' },
  { value: SYSTEM_ROLE_SLUGS.HR, label: 'HR' },
  { value: SYSTEM_ROLE_SLUGS.REPORTING_MANAGER, label: 'Reporting Manager' },
  { value: SYSTEM_ROLE_SLUGS.EMPLOYEE, label: 'Employee' },
];

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'Demo Video', label: 'Demo Video' },
  { value: 'FAQ', label: 'FAQ' },
  { value: 'Guide', label: 'Guide' },
];

const TYPE_CREATE_OPTIONS = [
  { value: 'Demo Video', label: 'Demo Video' },
  { value: 'FAQ', label: 'FAQ' },
  { value: 'Guide', label: 'Guide' },
];

const CONTENT_KIND_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'url', label: 'URL / Link' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

const emptyForm = {
  type: 'FAQ',
  title: '',
  content: '',
  contentKind: 'text',
  visibleRoles: [],
  sortOrder: 0,
  isActive: true,
};

/* ── Helpers ── */

function roleSlugsToLabels(slugs) {
  return slugs
    .map((slug) => ROLE_OPTIONS.find((opt) => opt.value === slug)?.label ?? slug)
    .join(', ');
}

function truncateContent(content, maxLen = 80) {
  if (!content) return '—';
  if (content.length <= maxLen) return content;
  return `${content.slice(0, maxLen)}…`;
}

function TableSkeleton() {
  return (
    <div className="departments-table-skeleton" aria-busy="true" aria-label="Loading items">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

/* ── Read-only view for non-manage users ── */

function ReadOnlyView({ items, loading, error }) {
  const grouped = useMemo(() => {
    const map = {};
    for (const item of items) {
      const key = item.type || 'Other';
      if (!map[key]) map[key] = [];
      map[key].push(item);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  if (loading) return <TableSkeleton />;
  if (error) return <div className="alert alert--error">{error}</div>;

  if (items.length === 0) {
    return (
      <EmptyState
        icon={EMPTY_ICONS.settings}
        title="No items available"
        description="There are no FAQ or demo items available for your role at the moment."
      />
    );
  }

  return (
    <div className="faq-demo-read">
      {grouped.map(([type, typeItems]) => (
        <section key={type} className="faq-demo-read__group card" aria-label={type}>
          <h2 className="card__section-title">{type}</h2>
          <ul className="faq-demo-read__list">
            {typeItems.map((item) => (
              <li key={item.id} className="faq-demo-read__item">
                <span className="faq-demo-read__title">{item.title}</span>
                {item.contentKind === 'url' ? (
                  <a
                    href={item.content}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost btn-sm"
                  >
                    Open link ↗
                  </a>
                ) : (
                  <p className="faq-demo-read__content muted">{item.content}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ── Main component ── */

export default function AdminFaqDemo() {
  const { hasPermission } = useAuth();
  const { showSuccess } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const createModalTitleId = useId();
  const editModalTitleId = useId();

  const canManage = hasPermission(PERMISSIONS.DEMO_FAQ_MANAGE);

  const [items, setItems] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [modalError, setModalError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const requestKeyRef = useRef('');

  const hasActiveFilters = Boolean(typeFilter || statusFilter);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (typeFilter && item.type !== typeFilter) return false;
      if (statusFilter === 'true' && !item.isActive) return false;
      if (statusFilter === 'false' && item.isActive) return false;
      return true;
    });
  }, [items, typeFilter, statusFilter]);

  const loadItems = useCallback(async () => {
    const requestKey = String(Date.now());
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError('');

    try {
      const data = canManage
        ? await demoFaqApi.listManage()
        : await demoFaqApi.list();
      if (requestKeyRef.current !== requestKey) return;
      setItems(data.items ?? []);
    } catch (err) {
      if (requestKeyRef.current !== requestKey) return;
      setError(getErrorMessage(err));
    } finally {
      if (requestKeyRef.current === requestKey) {
        setLoading(false);
      }
    }
  }, [canManage]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const emptyTitle = useMemo(() => {
    if (items.length === 0) return 'No FAQ & Demo items yet';
    if (hasActiveFilters) return 'No items match these filters';
    return 'No items found';
  }, [items.length, hasActiveFilters]);

  const emptyDescription = useMemo(() => {
    if (items.length === 0) {
      return 'Create FAQ entries, demo videos, and guides visible to specific roles.';
    }
    if (hasActiveFilters) {
      return 'Try adjusting the type or status filter, or clear filters to browse all items.';
    }
    return 'Items will appear here once they are created.';
  }, [items.length, hasActiveFilters]);

  const modalTitleId = modal?.mode === 'create' ? createModalTitleId : editModalTitleId;

  function clearFilters() {
    setTypeFilter('');
    setStatusFilter('');
  }

  function openCreateModal() {
    setForm(emptyForm);
    setFieldErrors({});
    setModalError('');
    setModal({ mode: 'create' });
  }

  function openEditModal(item) {
    setForm({
      type: item.type,
      title: item.title,
      content: item.content,
      contentKind: item.contentKind ?? 'text',
      visibleRoles: [...(item.visibleRoles ?? [])],
      sortOrder: item.sortOrder ?? 0,
      isActive: item.isActive,
    });
    setFieldErrors({});
    setModalError('');
    setModal({ mode: 'edit', item });
  }

  function closeModal() {
    if (submitting) return;
    setModal(null);
    setForm(emptyForm);
    setFieldErrors({});
    setModalError('');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!modal) return;

    setSubmitting(true);
    setError('');
    setModalError('');

    const schema = modal.mode === 'create' ? createDemoFaqSchema : updateDemoFaqSchema;
    const validation = validateForm(schema, form);

    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});

    try {
      if (modal.mode === 'create') {
        await demoFaqApi.create(validation.data);
        showSuccess(`"${validation.data.title}" created.`);
      } else {
        await demoFaqApi.update(modal.item.id, validation.data);
        showSuccess(`"${validation.data.title ?? modal.item.title}" updated.`);
      }

      closeModal();
      await loadItems();
    } catch (err) {
      setModalError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(item) {
    const nextActive = !item.isActive;
    await requestConfirm({
      title: nextActive ? 'Activate item?' : 'Deactivate item?',
      message: nextActive
        ? `Activate "${item.title}"? It will be visible to selected roles again.`
        : `Deactivate "${item.title}"? It will be hidden from all users.`,
      confirmLabel: nextActive ? 'Activate' : 'Deactivate',
      variant: nextActive ? 'default' : 'danger',
      onConfirm: async () => {
        await demoFaqApi.update(item.id, { isActive: nextActive });
        showSuccess(
          nextActive
            ? `"${item.title}" activated.`
            : `"${item.title}" deactivated.`,
        );
        await loadItems();
      },
    });
  }

  async function deleteItemConfirm(item) {
    await requestConfirm({
      title: 'Delete item?',
      message: `Permanently delete "${item.title}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        await demoFaqApi.remove(item.id);
        showSuccess(`"${item.title}" deleted.`);
        await loadItems();
      },
    });
  }

  function getActionItems(item) {
    return [
      {
        key: 'edit',
        label: 'Edit details',
        onClick: () => openEditModal(item),
      },
      {
        key: 'toggle',
        label: item.isActive ? 'Deactivate' : 'Activate',
        variant: item.isActive ? 'danger' : 'default',
        onClick: () => toggleActive(item),
      },
      {
        key: 'delete',
        label: 'Delete',
        variant: 'danger',
        onClick: () => deleteItemConfirm(item),
      },
    ];
  }

  return (
    <div className="page page--faq-demo">
      {!canManage ? (
        <ReadOnlyView items={items} loading={loading} error={error} />
      ) : (
        <>
      <section className="departments-panel card card--table" aria-label="FAQ & Demo items">
        <div className="departments-toolbar card__toolbar">
          <div className="departments-toolbar__filters filter-bar">
            <label className="field-inline filter-bar__field departments-toolbar__field">
              <span className="label">Type</span>
              <SelectField
                value={typeFilter}
                onChange={setTypeFilter}
                options={TYPE_OPTIONS}
                aria-label="Item type filter"
              />
            </label>

            <label className="field-inline filter-bar__field departments-toolbar__field">
              <span className="label">Status</span>
              <SelectField
                value={statusFilter}
                onChange={setStatusFilter}
                options={STATUS_OPTIONS}
                aria-label="Item status filter"
              />
            </label>

            {hasActiveFilters ? (
              <div className="filter-bar__field departments-toolbar__clear">
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            ) : null}
          </div>

          <div className="departments-toolbar__actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={openCreateModal}>
              + Add item
            </button>
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : filteredItems.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.settings}
            title={emptyTitle}
            description={emptyDescription}
            action={
              hasActiveFilters ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={clearFilters}>
                  Clear filters
                </button>
              ) : null
            }
          />
        ) : (
          <div className="table-wrap table-wrap--responsive departments-table-wrap">
            <table className="table data-table departments-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Title</th>
                  <th>Content</th>
                  <th>Visible Roles</th>
                  <th>Order</th>
                  <th>Status</th>
                  <th className="cell-actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Type">
                      <code className="departments-table__code">{item.type}</code>
                    </td>
                    <td data-label="Title" className="departments-table__name">
                      {item.title}
                    </td>
                    <td
                      data-label="Content"
                      className="cell-ellipsis"
                      title={item.content}
                    >
                      {item.contentKind === 'url' ? (
                        <a
                          href={item.content}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link"
                        >
                          {truncateContent(item.content, 50)}
                        </a>
                      ) : (
                        truncateContent(item.content, 50)
                      )}
                    </td>
                    <td data-label="Visible Roles" className="cell-ellipsis" title={roleSlugsToLabels(item.visibleRoles)}>
                      {roleSlugsToLabels(item.visibleRoles)}
                    </td>
                    <td data-label="Order">{item.sortOrder}</td>
                    <td data-label="Status">
                      <StatusBadge active={item.isActive} />
                    </td>
                    <td data-label="Actions" className="cell-actions-col">
                      <ActionMenu
                        label={`Actions for ${item.title}`}
                        items={getActionItems(item)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Create / Edit modal ── */}
      <FaqDemoModal
        modal={modal}
        form={form}
        setForm={setForm}
        fieldErrors={fieldErrors}
        modalError={modalError}
        submitting={submitting}
        modalTitleId={modalTitleId}
        onClose={closeModal}
        onSubmit={handleSubmit}
      />

      {confirmDialog}
        </>
      )}
    </div>
  );
}

/* ── Modal component ── */

function FaqDemoModal({
  modal,
  form,
  setForm,
  fieldErrors,
  modalError,
  submitting,
  modalTitleId,
  onClose,
  onSubmit,
}) {
  useEscapeKey(Boolean(modal), onClose);

  if (!modal) return null;

  return (
    <div className="modal__backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--compact departments-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={modalTitleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id={modalTitleId} className="modal__title">
            {modal.mode === 'create' ? 'Add FAQ / Demo item' : 'Edit item'}
          </h2>
          <p className="modal__lead muted">
            {modal.mode === 'create'
              ? 'Create a new FAQ entry, demo video, or guide for selected roles.'
              : 'Update the details of this item.'}
          </p>
        </header>

        <form className="modal__form" onSubmit={onSubmit}>
          <div className="modal__body">
            {modalError ? (
              <div className="alert alert--error modal__alert">{modalError}</div>
            ) : null}

            <div className="modal__field">
              <span className="label">Type</span>
              <SelectField
                value={form.type}
                onChange={(value) => setForm({ ...form, type: value })}
                options={TYPE_CREATE_OPTIONS}
                aria-label="Item type"
              />
              <FieldError message={fieldErrors.type} />
            </div>

            <label className="modal__field">
              <span className="label">Title</span>
              <input
                autoFocus
                className="input"
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                maxLength={300}
                placeholder="e.g. How to check-in"
              />
              <FieldError message={fieldErrors.title} />
            </label>

            <div className="modal__field">
              <span className="label">Content kind</span>
              <SelectField
                value={form.contentKind}
                onChange={(value) => setForm({ ...form, contentKind: value })}
                options={CONTENT_KIND_OPTIONS}
                aria-label="Content kind"
              />
              <FieldError message={fieldErrors.contentKind} />
            </div>

            <label className="modal__field">
              <span className="label">
                {form.contentKind === 'url' ? 'URL' : 'Content'}
              </span>
              <textarea
                className="input"
                value={form.content}
                onChange={(event) => setForm({ ...form, content: event.target.value })}
                maxLength={5000}
                rows={form.contentKind === 'url' ? 2 : 4}
                placeholder={
                  form.contentKind === 'url'
                    ? 'https://…'
                    : 'Enter text content…'
                }
              />
              <FieldError message={fieldErrors.content} />
            </label>

            <div className="modal__field">
              <span className="label">Visible to roles</span>
              <MultiSelectField
                value={form.visibleRoles}
                onChange={(value) => setForm({ ...form, visibleRoles: value })}
                options={ROLE_OPTIONS}
                placeholder="Select roles…"
                countSuffix="roles"
                aria-label="Visible roles"
              />
              <FieldError message={fieldErrors.visibleRoles} />
            </div>

            <label className="modal__field">
              <span className="label">Sort order</span>
              <input
                className="input input--narrow"
                type="number"
                min={0}
                max={9999}
                value={form.sortOrder}
                onChange={(event) =>
                  setForm({ ...form, sortOrder: Number(event.target.value) || 0 })
                }
              />
              <FieldError message={fieldErrors.sortOrder} />
            </label>

            {modal.mode === 'edit' ? (
              <label className="field-checkbox">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(event) =>
                    setForm({ ...form, isActive: event.target.checked })
                  }
                />
                <span>Active</span>
              </label>
            ) : null}
          </div>

          <footer className="modal__footer">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting
                ? 'Saving…'
                : modal.mode === 'create'
                  ? 'Create item'
                  : 'Save changes'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
