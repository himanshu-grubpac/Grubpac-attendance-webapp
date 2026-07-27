import CheckInMap from './CheckInMap.jsx';
import { evaluateOfficeGeoPreview } from '../utils/geoPreview.js';

export default function LocationPanel({
  position,
  error,
  loading,
  office,
  sampleInfo,
  compact = false,
  attendanceMode = 'office',
  onRefresh,
}) {
  const showOfficeGeofence = attendanceMode === 'office';
  const officeGeoPreview =
    showOfficeGeofence && position && office
      ? evaluateOfficeGeoPreview(position, office)
      : null;

  if (compact) {
    const summary = position
      ? `±${position.accuracyMeters.toFixed(0)} m · ${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)}`
      : loading
        ? 'Capturing GPS…'
        : 'Location not captured yet';

    return (
      <div className="location-panel-compact">
        <div className="location-panel-compact__header">
          <span className="label">Location</span>
          <span className="location-panel-compact__summary muted small">{summary}</span>
        </div>

        <div className="location-panel-compact__body">
          <CheckInMap
            position={position}
            office={office}
            showOfficeGeofence={showOfficeGeofence}
          />

          {loading ? (
            <p className="muted small">Capturing multi-sample GPS for best accuracy…</p>
          ) : null}
          {error ? <div className="alert alert--error">{error}</div> : null}

          {officeGeoPreview && !officeGeoPreview.isWithinOffice ? (
            <div className="alert alert--warning">
              <strong>Outside office geofence</strong>
              <ul className="location-panel-compact__geo-issues">
                {officeGeoPreview.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
              <p className="muted small">
                Office check-in will be rejected until you are within the configured radius with
                sufficient GPS accuracy.
              </p>
            </div>
          ) : null}

          {position ? (
            <div className="location-grid location-grid--compact">
              <div>
                <span className="label">Accuracy</span>
                <strong>{position.accuracyMeters.toFixed(1)} m</strong>
              </div>
              <div>
                <span className="label">Lat / Lng</span>
                <strong>
                  {position.latitude.toFixed(5)}, {position.longitude.toFixed(5)}
                </strong>
              </div>
            </div>
          ) : null}
          {sampleInfo ? (
            <p className="muted small">
              Best of {sampleInfo.samples} samples · ±{sampleInfo.bestAccuracy.toFixed(1)} m
            </p>
          ) : null}
          {office && showOfficeGeofence ? (
            <p className="muted small">
              Office: {office.name} · Radius {office.radiusMeters} m
            </p>
          ) : null}
          {attendanceMode === 'wfh' ? (
            <p className="muted small">
              WFH check-in records your GPS location without applying the office geofence.
            </p>
          ) : null}
          {onRefresh ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={loading}
              onClick={onRefresh}
            >
              Refresh location
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="card location-panel">
      <div className="card__header">
        <div>
          <h2>Location Status</h2>
          <p className="card__desc">
            {showOfficeGeofence
              ? 'GPS coordinates used for geofence verification'
              : 'GPS coordinates captured for WFH attendance'}
          </p>
        </div>
        {loading && <div className="spinner spinner--sm" aria-label="Capturing location" />}
      </div>

      <CheckInMap
        position={position}
        office={office}
        showOfficeGeofence={showOfficeGeofence}
      />

      {loading && (
        <p className="muted small">Capturing multi-sample GPS for best accuracy…</p>
      )}
      {error && <div className="alert alert--error">{error}</div>}

      {officeGeoPreview && !officeGeoPreview.isWithinOffice ? (
        <div className="alert alert--warning">
          <strong>Outside office geofence</strong>
          <ul className="location-panel-compact__geo-issues">
            {officeGeoPreview.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {position && (
        <div className="location-grid">
          <div>
            <span className="label">Latitude</span>
            <strong>{position.latitude.toFixed(6)}</strong>
          </div>
          <div>
            <span className="label">Longitude</span>
            <strong>{position.longitude.toFixed(6)}</strong>
          </div>
          <div>
            <span className="label">Accuracy</span>
            <strong>{position.accuracyMeters.toFixed(1)} m</strong>
          </div>
          <div>
            <span className="label">Captured (IST)</span>
            <strong>
              {new Date(position.clientTimestamp).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
              })}
            </strong>
          </div>
        </div>
      )}

      {sampleInfo && (
        <p className="muted small">
          Best of {sampleInfo.samples} GPS samples · ±{sampleInfo.bestAccuracy.toFixed(1)} m
        </p>
      )}

      {office && showOfficeGeofence && (
        <div className="office-ref muted small">
          Office: {office.name} · Centre {office.latitude?.toFixed(6)},{' '}
          {office.longitude?.toFixed(6)} · Radius {office.radiusMeters} m · Max accuracy{' '}
          {office.maxAccuracyMeters} m
        </div>
      )}
    </div>
  );
}
