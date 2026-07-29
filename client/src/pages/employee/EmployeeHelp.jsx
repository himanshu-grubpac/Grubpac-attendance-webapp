import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createHelpTicketSchema } from '@shared/validation/help.js';
import { formatISTDateTime } from '../../utils/datetime.js';
import { helpApi, getErrorMessage } from '../../services/api.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { usePageMetaContext } from '../../context/PageMetaContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { validateForm } from '../../utils/validation.js';
import HelpStatusBadge from '../../components/HelpStatusBadge.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import SelectField from '../../components/SelectField.jsx';
import FieldError from '../../components/FieldError.jsx';

const CATEGORIES = ['Login', 'Attendance', 'Leave', 'Salary', 'Other'];
const PRIORITIES = ['low', 'medium', 'high'];

const CATEGORY_OPTIONS = CATEGORIES.map((item) => ({ value: item, label: item }));
const PRIORITY_OPTIONS = PRIORITIES.map((item) => ({
  value: item,
  label: item.charAt(0).toUpperCase() + item.slice(1),
}));

const EMPTY_FORM = {
  title: '',
  category: 'Other',
  priority: 'medium',
  description: '',
};

export default function EmployeeHelp() {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [tickets, setTickets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState({});
  const [showForm, setShowForm] = useState(false);
  const { setMeta } = usePageMetaContext();

  useEffect(() => {
    setMeta({
      actions: (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowForm((value) => !value)}
        >
          {showForm ? 'Cancel' : 'New ticket'}
        </button>
      ),
    });
  }, [showForm, setMeta]);

  async function loadTickets(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const data = await helpApi.listTickets({ scope: 'mine', page: nextPage, limit: 20 });
      setTickets(data.tickets ?? []);
      setPagination(data.pagination ?? null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTickets(page);
  }, [page]);

  useEscapeKey(showForm, () => setShowForm(false));

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    const validation = validateForm(createHelpTicketSchema, form);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});
    try {
      const data = await helpApi.createTicket(validation.data);
      showSuccess('Help ticket submitted.');
      setForm(EMPTY_FORM);
      setShowForm(false);
      await loadTickets(page);
      if (data.ticket?.id) {
        navigate(`/employee/help/${data.ticket.id}`);
      }
    } catch (err) {
      showError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page page--form">
      {error && <div className="alert alert--error">{error}</div>}

      {showForm && (
        <div className="card card--form">
          <p className="card__section-title">New ticket</p>
          <form className="form-grid" onSubmit={handleSubmit}>
            <div className="form-grid__full form-grid help-ticket-form__meta-row">
              <label className="field">
                <span className="label">Title</span>
                <input
                  type="text"
                  value={form.title}
                  onChange={(event) => updateField('title', event.target.value)}
                  required
                  maxLength={200}
                  placeholder="Brief summary of the issue"
                />
                <FieldError message={fieldErrors.title} />
              </label>
              <label className="field">
                <span className="label">Category</span>
                <SelectField
                  value={form.category}
                  onChange={(value) => updateField('category', value)}
                  options={CATEGORY_OPTIONS}
                  aria-label="Category"
                />
              </label>
              <label className="field">
                <span className="label">Priority</span>
                <SelectField
                  value={form.priority}
                  onChange={(value) => updateField('priority', value)}
                  options={PRIORITY_OPTIONS}
                  aria-label="Priority"
                />
              </label>
            </div>
            <label className="field form-grid__full">
              <span className="label">Description</span>
              <textarea
                value={form.description}
                onChange={(event) => updateField('description', event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                required
                rows={5}
                maxLength={5000}
                placeholder="Describe the issue and any steps to reproduce"
              />
              <FieldError message={fieldErrors.description} />
            </label>
            <div className="form-actions form-actions--sticky">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Submitting…' : 'Submit ticket'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card card--table">
        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.help}
            title="No help tickets yet"
            description="Raise a ticket if you need support from HR or IT."
            action={
              !showForm ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>
                  New ticket
                </button>
              ) : null
            }
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="table data-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((item) => (
                    <tr key={item.id}>
                      <td data-label="Title" className="cell-ellipsis" title={item.title}>{item.title}</td>
                      <td data-label="Status">
                        <HelpStatusBadge status={item.status} />
                      </td>
                      <td data-label="Created" className="muted small">{formatISTDateTime(item.createdAt)}</td>
                      <td data-label="Action" className="cell-actions">
                        <Link to={`/employee/help/${item.id}`} className="btn btn-ghost btn-sm">
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        <PaginationBar pagination={pagination} onPageChange={setPage} />
      </div>
    </div>
  );
}
