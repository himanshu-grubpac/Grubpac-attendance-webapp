import { useEffect, useState } from 'react';
import { officeSchema } from '@shared/validation/office.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useGeolocation } from '../../hooks/useGeolocation.js';
import { validateForm } from '../../utils/validation.js';
import FieldError from '../../components/FieldError.jsx';

const emptyOffice = {
  name: '',
  latitude: '',
  longitude: '',
  radiusMeters: 100,
  maxAccuracyMeters: 50,
  sandwichLeaveEnabled: false,
};

export default function AdminOfficeSettings() {
  const [form, setForm] = useState(emptyOffice);
  const [fieldErrors, setFieldErrors] = useState({});
  const [message, setMessage] = useState('');
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
      setMessage(
        `Office centre captured with ±${position.accuracyMeters.toFixed(1)} m accuracy.`,
      );
    } catch {
      // geoError state is set in hook
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    setError('');
    setFieldErrors({});

    const payload = {
      name: form.name.trim(),
      latitude: Number(form.latitude),
      longitude: Number(form.longitude),
      radiusMeters: Number(form.radiusMeters),
      maxAccuracyMeters: Number(form.maxAccuracyMeters),
      sandwichLeaveEnabled: Boolean(form.sandwichLeaveEnabled),
    };

    const validation = validateForm(officeSchema, payload);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSaving(false);
      return;
    }

    try {
      await adminApi.updateOfficeSettings(validation.data);
      setMessage('Office settings saved.');
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
              className="input input--narrow"
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
        {(geoError || message || error) && (
          <div className="page-alerts alert--inset">
            {geoError && <div className="alert alert--error">{geoError}</div>}
            {message && <div className="alert alert--success">{message}</div>}
            {error && <div className="alert alert--error">{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
