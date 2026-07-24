import { useState } from 'react';

export default function LocationPanel({
  position,
  error,
  loading,
  office,
  sampleInfo,
  compact = false,
  onRefresh,
}) {
  const [expanded, setExpanded] = useState(false);

  if (compact) {
    const summary = position
      ? `±${position.accuracyMeters.toFixed(0)} m · ${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)}`
      : loading
        ? 'Capturing GPS…'
        : 'Location not captured yet';

    return (
      <div className="location-panel-compact">
        <button
          type="button"
          className="location-panel-compact__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="label">Location</span>
          <span className="location-panel-compact__summary muted small">{summary}</span>
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        </button>

        {expanded ? (
          <div className="location-panel-compact__body">
            {loading ? (
              <p className="muted small">Capturing multi-sample GPS for best accuracy…</p>
            ) : null}
            {error ? <div className="alert alert--error">{error}</div> : null}
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
            {office ? (
              <p className="muted small">
                Office: {office.name} · Radius {office.radiusMeters} m
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
        ) : null}
      </div>
    );
  }

  return (
    <div className="card location-panel">
      <div className="card__header">
        <div>
          <h2>Location Status</h2>
          <p className="card__desc">GPS coordinates used for geofence verification</p>
        </div>
        {loading && <div className="spinner spinner--sm" aria-label="Capturing location" />}
      </div>

      {loading && (
        <p className="muted small">Capturing multi-sample GPS for best accuracy…</p>
      )}
      {error && <div className="alert alert--error">{error}</div>}

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

      {office && (
        <div className="office-ref muted small">
          Office: {office.name} · Centre {office.latitude?.toFixed(6)},{' '}
          {office.longitude?.toFixed(6)} · Radius {office.radiusMeters} m · Max accuracy{' '}
          {office.maxAccuracyMeters} m
        </div>
      )}
    </div>
  );
}
