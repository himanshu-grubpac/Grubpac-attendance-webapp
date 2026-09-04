import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createHelpTicketSchema } from '@shared/validation/help.js';
import { formatISTDateTime } from '../../utils/datetime.js';
import { helpApi, getErrorMessage } from '../../services/api.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { usePageMetaContext } from '../../context/PageMetaContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { validateForm } from '../../utils/validation.js';
import HelpStatusBadge from '../../components/HelpStatusBadge.jsx';
import HelpPriorityBadge from '../../components/HelpPriorityBadge.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import SelectField from '../../components/SelectField.jsx';
import FieldError from '../../components/FieldError.jsx';
import UserGuideLinks from '../../components/UserGuideLinks.jsx';

const CATEGORIES = ['Login', 'Attendance', 'Leave', 'Salary', 'Other'];

const CATEGORY_OPTIONS = CATEGORIES.map((item) => ({ value: item, label: item }));

const MAX_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_FILE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
const ACCEPT_ATTR = '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf';

const EMPTY_FORM = {
  title: '',
  category: 'Other',
  description: '',
};

const UPLOAD_PHASE_LABELS = {
  pending: 'Waiting',
  presigning: 'Preparing',
  uploading: 'Uploading',
  confirming: 'Confirming',
  done: 'Complete',
  error: 'Failed',
};

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UploadIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 16V4m0 0l-4 4m4-4l4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6M8 13h8M8 17h8M8 9h2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function validateSelectedFiles(files) {
  if (files.length > MAX_ATTACHMENTS) {
    return `You can attach up to ${MAX_ATTACHMENTS} files.`;
  }
  for (const file of files) {
    if (!ALLOWED_FILE_TYPES.has(file.type)) {
      return `"${file.name}" is not allowed. Use PDF, JPEG, PNG, or WebP.`;
    }
    if (file.size > MAX_FILE_BYTES) {
      return `"${file.name}" exceeds the 5 MB limit.`;
    }
  }
  return '';
}

function uploadFileToS3(uploadUrl, file, headers = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    Object.entries(headers).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.timeout = 120_000;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out.'));
    xhr.send(file);
  });
}

async function uploadTicketAttachments(ticketId, files, onProgress) {
  const results = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];

    try {
      onProgress?.({
        index,
        total: files.length,
        fileName: file.name,
        phase: 'presigning',
        percent: 0,
      });

      const presign = await helpApi.presignAttachment(ticketId, {
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });

      onProgress?.({
        index,
        total: files.length,
        fileName: file.name,
        phase: 'uploading',
        percent: 0,
      });

      await uploadFileToS3(presign.uploadUrl, file, presign.uploadHeaders ?? {}, (percent) => {
        onProgress?.({
          index,
          total: files.length,
          fileName: file.name,
          phase: 'uploading',
          percent,
        });
      });

      onProgress?.({
        index,
        total: files.length,
        fileName: file.name,
        phase: 'confirming',
        percent: 100,
      });

      await helpApi.confirmAttachment(ticketId, presign.attachment.id);

      onProgress?.({
        index,
        total: files.length,
        fileName: file.name,
        phase: 'done',
        percent: 100,
      });

      results.push({ success: true });
    } catch (err) {
      onProgress?.({
        index,
        total: files.length,
        fileName: file.name,
        phase: 'error',
        percent: 0,
        error: getErrorMessage(err),
      });
      results.push({ success: false, error: err });
    }
  }

  return results;
}

function getActiveUploadIndex(states) {
  const active = states.findIndex(
    (item) => item.phase === 'presigning' || item.phase === 'uploading' || item.phase === 'confirming',
  );
  if (active >= 0) return active + 1;
  const doneCount = states.filter((item) => item.phase === 'done' || item.phase === 'error').length;
  return doneCount > 0 ? doneCount : 1;
}

export default function EmployeeHelp() {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const fileInputRef = useRef(null);
  const [tickets, setTickets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState({});
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [fileUploadStates, setFileUploadStates] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const { setMeta } = usePageMetaContext();

  const atFileLimit = selectedFiles.length >= MAX_ATTACHMENTS;

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

  function addFiles(incomingFiles) {
    if (submitting || incomingFiles.length === 0) return;

    const merged = [...selectedFiles];
    let nextError = '';

    for (const file of incomingFiles) {
      if (merged.length >= MAX_ATTACHMENTS) {
        nextError = `You can attach up to ${MAX_ATTACHMENTS} files.`;
        break;
      }
      if (merged.some((existing) => existing.name === file.name && existing.size === file.size)) {
        continue;
      }

      const candidate = [...merged, file];
      const validationError = validateSelectedFiles(candidate);
      if (validationError) {
        nextError = validationError;
        if (validationError.includes('up to')) break;
        continue;
      }

      merged.push(file);
    }

    setSelectedFiles(merged);
    setAttachmentError(nextError);
  }

  function handleFilesChange(event) {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  }

  function handleDragOver(event) {
    event.preventDefault();
    if (!submitting && !atFileLimit) {
      setIsDragging(true);
    }
  }

  function handleDragLeave(event) {
    event.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    if (submitting || atFileLimit) return;
    addFiles(Array.from(event.dataTransfer.files ?? []));
  }

  function openFilePicker() {
    if (!submitting && !atFileLimit) {
      fileInputRef.current?.click();
    }
  }

  function removeFile(index) {
    if (submitting) return;
    setSelectedFiles((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
    setAttachmentError('');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setAttachmentError('');
    setFileUploadStates([]);

    const fileValidationError = validateSelectedFiles(selectedFiles);
    if (fileValidationError) {
      setAttachmentError(fileValidationError);
      setSubmitting(false);
      return;
    }

    const validation = validateForm(createHelpTicketSchema, form);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});
    try {
      const data = await helpApi.createTicket(validation.data);
      const ticketId = data.ticket?.id;

      if (ticketId && selectedFiles.length > 0) {
        setFileUploadStates(
          selectedFiles.map((file) => ({
            fileName: file.name,
            phase: 'pending',
            percent: 0,
            error: '',
          })),
        );

        try {
          const results = await uploadTicketAttachments(ticketId, selectedFiles, (progress) => {
            setFileUploadStates((prev) =>
              prev.map((item, itemIndex) =>
                itemIndex === progress.index
                  ? {
                      fileName: progress.fileName,
                      phase: progress.phase,
                      percent: progress.percent ?? item.percent,
                      error: progress.error ?? '',
                    }
                  : item,
              ),
            );
          });

          const failedCount = results.filter((item) => !item.success).length;
          if (failedCount === results.length) {
            await helpApi.deleteTicket(ticketId);
            showError('File upload failed. Ticket was not created.');
            setForm(EMPTY_FORM);
            setSelectedFiles([]);
            setFileUploadStates([]);
            setShowForm(false);
            await loadTickets(page);
            return;
          } else if (failedCount > 0) {
            showError(
              `Ticket created, but ${failedCount} of ${results.length} attachment uploads failed.`,
            );
          } else {
            showSuccess(
              selectedFiles.length === 1
                ? 'Help ticket submitted with attachment.'
                : `Help ticket submitted with ${selectedFiles.length} attachments.`,
            );
          }
        } catch (uploadErr) {
          await helpApi.deleteTicket(ticketId);
          showError('File upload failed. Ticket was not created.');
          setForm(EMPTY_FORM);
          setSelectedFiles([]);
          setFileUploadStates([]);
          setShowForm(false);
          await loadTickets(page);
          return;
        }
      } else {
        showSuccess('Help ticket submitted.');
      }

      setForm(EMPTY_FORM);
      setSelectedFiles([]);
      setFileUploadStates([]);
      setShowForm(false);
      await loadTickets(page);
      if (ticketId) {
        navigate(`/employee/help/${ticketId}`);
      }
    } catch (err) {
      showError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
      setFileUploadStates([]);
    }
  }

  const showUploadProgress = submitting && fileUploadStates.length > 0;
  const activeUploadIndex = showUploadProgress ? getActiveUploadIndex(fileUploadStates) : 0;

  return (
    <div className="page page--form">
      {error && <div className="alert alert--error">{error}</div>}

      <UserGuideLinks />

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
            <div className="field form-grid__full">
              <span className="label">Attachments (optional)</span>
              <div className="help-attachment-upload">
                <div
                  className={`bulk-upload__dropzone help-attachment-upload__dropzone${isDragging ? ' bulk-upload__dropzone--active' : ''}${submitting || atFileLimit ? ' help-attachment-upload__dropzone--disabled' : ''}`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={openFilePicker}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openFilePicker();
                    }
                  }}
                  role="button"
                  tabIndex={submitting || atFileLimit ? -1 : 0}
                  aria-label="Add attachments"
                  aria-disabled={submitting || atFileLimit}
                >
                  <input
                    ref={fileInputRef}
                    className="bulk-upload__file-input"
                    type="file"
                    accept={ACCEPT_ATTR}
                    multiple
                    onChange={handleFilesChange}
                    disabled={submitting || atFileLimit}
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                  <span className="bulk-upload__dropzone-icon" aria-hidden="true">
                    <UploadIcon />
                  </span>
                  <p className="bulk-upload__dropzone-title">
                    {atFileLimit ? 'Maximum attachments selected' : 'Drag & drop files here'}
                  </p>
                  <p className="bulk-upload__dropzone-hint muted small">
                    PDF, JPEG, PNG, or WebP · Up to {MAX_ATTACHMENTS} files · 5 MB each
                  </p>
                </div>

                <button
                  type="button"
                  className="btn bulk-upload__browse-btn"
                  onClick={openFilePicker}
                  disabled={submitting || atFileLimit}
                >
                  Choose files
                </button>

                {selectedFiles.length > 0 && !showUploadProgress && (
                  <ul className="help-attachment-upload__list" aria-label="Selected attachments">
                    {selectedFiles.map((file, index) => (
                      <li key={`${file.name}-${file.size}-${index}`} className="help-attachment-upload__item">
                        <div className="bulk-upload__file-preview">
                          <span className="bulk-upload__file-icon" aria-hidden="true">
                            <FileIcon />
                          </span>
                          <div className="bulk-upload__file-meta">
                            <strong className="bulk-upload__file-name">{file.name}</strong>
                            <span className="bulk-upload__file-size muted small">
                              {formatFileSize(file.size)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="btn btn-sm bulk-upload__file-clear"
                            onClick={() => removeFile(index)}
                            disabled={submitting}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {showUploadProgress && (
                  <div className="help-attachment-upload__progress-panel" aria-live="polite">
                    <p className="help-attachment-upload__progress-summary">
                      Uploading {activeUploadIndex} of {fileUploadStates.length}…
                    </p>
                    {fileUploadStates.map((item) => {
                      const isDone = item.phase === 'done';
                      const isError = item.phase === 'error';
                      const showPercent =
                        item.phase === 'uploading' ||
                        item.phase === 'confirming' ||
                        item.phase === 'done';
                      const fillClass = isError
                        ? 'help-attachment-upload__progress-fill help-attachment-upload__progress-fill--error'
                        : isDone
                          ? 'help-attachment-upload__progress-fill help-attachment-upload__progress-fill--done'
                          : 'help-attachment-upload__progress-fill';

                      return (
                        <div
                          key={item.fileName}
                          className="help-attachment-upload__progress-item"
                        >
                          <div className="help-attachment-upload__progress-label">
                            <span className="help-attachment-upload__progress-name">{item.fileName}</span>
                            <span className="help-attachment-upload__progress-phase muted small">
                              {isError
                                ? UPLOAD_PHASE_LABELS.error
                                : showPercent
                                  ? `${item.percent}%`
                                  : UPLOAD_PHASE_LABELS[item.phase] ?? UPLOAD_PHASE_LABELS.pending}
                            </span>
                          </div>
                          <div className="help-attachment-upload__progress-track" aria-hidden="true">
                            <div
                              className={fillClass}
                              style={{ width: `${isError ? 100 : item.percent}%` }}
                            />
                          </div>
                          {isError && item.error && (
                            <p className="help-attachment-upload__progress-error">{item.error}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <FieldError message={attachmentError} />
            </div>
            <div className="form-actions form-actions--sticky">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting
                  ? selectedFiles.length > 0
                    ? 'Submitting & uploading…'
                    : 'Submitting…'
                  : 'Submit ticket'}
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
          <>
            {tickets.length > 0 && !showForm && (
              <div className="card__toolbar">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>
                  New ticket
                </button>
              </div>
            )}
            <div className="table-wrap table-wrap--responsive">
            <table className="table data-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((item) => (
                    <tr key={item.id}>
                      <td data-label="Title" className="cell-ellipsis" title={item.title}>{item.title}</td>
                      <td data-label="Priority">
                        <HelpPriorityBadge priority={item.priority} />
                      </td>
                      <td data-label="Status">
                        <HelpStatusBadge status={item.status} />
                      </td>
                      <td data-label="Created" className="muted small">{formatISTDateTime(item.createdAt)}</td>
                      <td data-label="Actions" className="cell-actions">
                        <Link to={`/employee/help/${item.id}`} className="btn btn-ghost btn-sm">
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          </>
        )}
        <PaginationBar pagination={pagination} onPageChange={setPage} />
      </div>
    </div>
  );
}
