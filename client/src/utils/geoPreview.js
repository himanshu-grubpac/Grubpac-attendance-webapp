const EARTH_RADIUS_METERS = 6371000;

function toRadians(value) {
  return (value * Math.PI) / 180;
}

export function distanceBetweenMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/** Client-side office geofence preview — mirrors server geo rules for office mode only. */
export function evaluateOfficeGeoPreview(position, office) {
  if (!position || !office) return null;

  const issues = [];
  const distanceMeters = distanceBetweenMeters(
    position.latitude,
    position.longitude,
    office.latitude,
    office.longitude,
  );
  const effectiveDistance = distanceMeters + (position.accuracyMeters || 0);

  if (effectiveDistance > office.radiusMeters) {
    let message =
      `You appear outside the office radius (${distanceMeters.toFixed(0)} m from centre, allowed ${office.radiusMeters} m).`;
    if (distanceMeters > 1000) {
      message += ` You appear about ${(distanceMeters / 1000).toFixed(1)} km from the office.`;
    }
    issues.push(message);
  } else if (position.accuracyMeters > office.maxAccuracyMeters) {
    issues.push(
      `Location accuracy must be ${office.maxAccuracyMeters} m or better (currently ±${position.accuracyMeters.toFixed(0)} m).`,
    );
  }

  return {
    distanceMeters,
    effectiveDistanceMeters: effectiveDistance,
    issues,
    isWithinOffice: issues.length === 0,
  };
}
