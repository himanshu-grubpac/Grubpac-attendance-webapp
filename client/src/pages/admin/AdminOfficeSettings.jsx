import { useEffect, useState } from 'react';
import { officeSchema } from '@shared/validation/office.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useGeolocation } from '../../hooks/useGeolocation.js';
import { validateForm } from '../../utils/validation.js';
import FieldError from '../../components/FieldError.jsx';
import TimeField from '../../components/TimeField.jsx';

const WEEKDAY_OPTIONS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

const emptyOffice = {
  name: '',
  latitude: '',
  longitude: '',
  radiusMeters: 100,
  maxAccuracyMeters: 50,
  sandwichLeaveEnabled: false,
  officeStartTime: '09:00',
  officeEndTime: '17:00',
  graceThresholdTime: '09:00',
  halfDayThresholdTime: '10:00',
  warningsPerQuarter: 3,
  weekendDays: [0, 6],
};

export default function AdminOfficeSettings() {
  const { showSuccess } = useToast();
  const [form, setForm] = useState(emptyOffice);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { getPosition, loading: geoLoading, error: geoError } = useGeolocation();

  useEffect(() => {
    adminApi
      .getOfficeSettings()
      .then(({ settings }) => {
        if (settings) {
          setForm({
            name: settings.name ?? '',
            latitude: String(settings.latitude ?? ''),
            longitude: String(settings.longitude ?? ''),
            radiusMeters: settings.radiusMeters ?? 100,
            maxAccuracyMeters: settings.maxAccuracyMeters ?? 50,
            sandwichLeaveEnabled: Boolean(settings.sandwichLeaveEnabled),
            officeStartTime: settings.officeStartTime ?? '09:00',
            officeEndTime: settings.officeEndTime ?? '17:00',
            graceThresholdTime: settings.graceThresholdTime ?? '09:00',
            halfDayThresholdTime: settings.halfDayThresholdTime ?? '10:00',
            warningsPerQuarter: settings.warningsPerQuarter ?? 3,
            weekendDays: Array.isArray(settings.weekendDays) ? settings.weekendDays : [0, 6],
          });
        }
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  async function useCurrentLocation() {
    try {
      const position = await getPosition({ fresh: true });
      setForm((prev) => ({
        ...prev,
        latitude: String(position.latitude),
        longitude: String(position.longitude),
      }));
      showSuccess(
        `Office centre captured with ±${position.accuracyMeters.toFixed(1)} m accuracy.`,
      );
    } catch {
      // geoError state is set in hook
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setFieldErrors({});

    const payload = {
      name: form.name.trim(),
      latitude: Number(form.latitude),
      longitude: Number(form.longitude),
      radiusMeters: Number(form.radiusMeters),
      maxAccuracyMeters: Number(form.maxAccuracyMeters),
      sandwichLeaveEnabled: Boolean(form.sandwichLeaveEnabled),
      officeStartTime: form.officeStartTime,
      officeEndTime: form.officeEndTime,
      graceThresholdTime: form.graceThresholdTime,
      halfDayThresholdTime: form.halfDayThresholdTime,
      warningsPerQuarter: Number(form.warningsPerQuarter),
      weekendDays: form.weekendDays,
    };

    const validation = validateForm(officeSchema, payload);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSaving(false);
      return;
    }

    try {
      const result = await adminApi.updateOfficeSettings(validation.data);
      const updatedSettings = result.settings ?? validation.data;
      setForm((current) => ({
        ...current,
        officeStartTime: updatedSettings.officeStartTime,
        officeEndTime: updatedSettings.officeEndTime,
        graceThresholdTime: updatedSettings.graceThresholdTime,
        halfDayThresholdTime: updatedSettings.halfDayThresholdTime,
      }));
      window.dispatchEvent(
        new CustomEvent('attendance:office-policy-updated', { detail: updatedSettings }),
      );
      try {
        localStorage.setItem('attendance.office-policy-updated', JSON.stringify(updatedSettings));
      } catch {
        // Storage can be unavailable in restricted browser contexts.
      }
      showSuccess('Office settings saved.');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="page page--form">
        <div className="skeleton-stack">
          <div className="skeleton skeleton--title" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
        </div>
      </div>
    );
  }

  return (
    <div className="page page--form">
      <div className="card card--form">
        <p className="card__section-title">Office geofence</p>
        <form className="form-grid" onSubmit={handleSubmit}>
          <label>
            Office name
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={120}
              placeholder="e.g. Grubpac HQ"
            />
            <FieldError message={fieldErrors.name} />
          </label>
          <label>
            Latitude (-90 to 90)
            <input
              className="input"
              type="number"
              step="any"
              value={form.latitude}
              onChange={(e) => setForm({ ...form, latitude: e.target.value })}
            />
            <FieldError message={fieldErrors.latitude} />
          </label>
          <label>
            Longitude (-180 to 180)
            <input
              className="input"
              type="number"
              step="any"
              value={form.longitude}
              onChange={(e) => setForm({ ...form, longitude: e.target.value })}
            />
            <FieldError message={fieldErrors.longitude} />
          </label>
          <label className="form-field--sm">
            Radius (metres, max 5000)
            <input
              className="input input--narrow input--no-spinner"
              type="number"
              min="1"
              max="5000"
              value={form.radiusMeters}
              onChange={(e) => setForm({ ...form, radiusMeters: e.target.value })}
            />
            <FieldError message={fieldErrors.radiusMeters} />
          </label>
          <label className="form-field--sm">
            Max accuracy (metres, max 500)
            <input
              className="input input--narrow"
              type="number"
              min="1"
              max="500"
              value={form.maxAccuracyMeters}
              onChange={(e) => setForm({ ...form, maxAccuracyMeters: e.target.value })}
            />
            <FieldError message={fieldErrors.maxAccuracyMeters} />
          </label>
          <label className="field-checkbox form-grid__full">
            <input
              type="checkbox"
              checked={Boolean(form.sandwichLeaveEnabled)}
              onChange={(e) => setForm({ ...form, sandwichLeaveEnabled: e.target.checked })}
            />
            <span>
              Enable sandwich leave policy — weekends/holidays between leave days count toward
              leave when both sides are leave (default off until HR confirms).
            </span>
          </label>
          <div className="form-grid__full">
            <p className="card__section-title">Office hours &amp; attendance policy</p>
            <p className="muted small">
              Mon–Fri working days. Times use the IST 12-hour AM/PM picker. Attendance history
              and check-in evaluation use these thresholds.
            </p>
          </div>
          <label className="form-field--sm">
            Office start (Mon–Fri)
            <TimeField value={form.officeStartTime} onChange={(officeStartTime) => setForm({ ...form, officeStartTime })} aria-label="Office start time" />
            <FieldError message={fieldErrors.officeStartTime} />
          </label>
          <label className="form-field--sm">
            Office end (Mon–Fri)
            <TimeField value={form.officeEndTime} onChange={(officeEndTime) => setForm({ ...form, officeEndTime })} aria-label="Office end time" />
            <FieldError message={fieldErrors.officeEndTime} />
          </label>
          <label className="form-field--sm">
            Grace / warning threshold
            <TimeField value={form.graceThresholdTime} onChange={(graceThresholdTime) => setForm({ ...form, graceThresholdTime })} aria-label="Warning threshold time" />
            <FieldError message={fieldErrors.graceThresholdTime} />
          </label>
          <label className="form-field--sm">
            Half-day threshold
            <TimeField value={form.halfDayThresholdTime} onChange={(halfDayThresholdTime) => setForm({ ...form, halfDayThresholdTime })} aria-label="Half-day threshold time" />
            <FieldError message={fieldErrors.halfDayThresholdTime} />
          </label>
          <fieldset className="form-grid__full office-weekend-fieldset">
            <legend className="label">Weekend days (non-working)</legend>
            <div className="office-weekend-options">
              {WEEKDAY_OPTIONS.map((option) => (
                <label key={option.value} className="office-weekend-option">
                  <input
                    type="checkbox"
                    checked={form.weekendDays.includes(option.value)}
                    onChange={() => {
                      setForm((current) => {
                        const next = new Set(current.weekendDays ?? []);
                        if (next.has(option.value)) next.delete(option.value);
                        else next.add(option.value);
                        return { ...current, weekendDays: [...next].sort((a, b) => a - b) };
                      });
                    }}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            <FieldError message={fieldErrors.weekendDays} />
          </fieldset>
          <label className="form-field--sm">
            Warnings per quarter
            <input
              className="input input--narrow"
              type="number"
              min="0"
              max="10"
              value={form.warningsPerQuarter}
              onChange={(e) => setForm({ ...form, warningsPerQuarter: e.target.value })}
            />
            <FieldError message={fieldErrors.warningsPerQuarter} />
          </label>
          <div className="form-actions form-actions--sticky">
            <button
              type="button"
              className="btn"
              onClick={useCurrentLocation}
              disabled={geoLoading}
            >
              {geoLoading ? (
                <>
                  <span className="spinner spinner--sm" aria-hidden="true" />
                  Capturing location…
                </>
              ) : (
                'Use my current location'
              )}
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
        {(geoError || error) && (
          <div className="page-alerts alert--inset">
            {geoError && <div className="alert alert--error">{geoError}</div>}
            {error && <div className="alert alert--error">{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
