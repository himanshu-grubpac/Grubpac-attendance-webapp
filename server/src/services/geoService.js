import { OfficeSettings } from '../models/OfficeSettings.js';
import { env } from '../config/env.js';
import { distanceBetweenMeters } from '../utils/haversine.js';
import {
  MAX_FUTURE_SKEW_MS,
  MAX_LOCATION_AGE_MS,
} from '../../../shared/validation/common.js';

export async function getOfficeSettings() {
  let settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  if (!settings) {
    settings = await OfficeSettings.create(env.defaultOffice);
  }
  return settings;
}

/** Bangalore coords shipped as a dev placeholder; Jhandewalan office is in Delhi (~1740 km away). */
export const LEGACY_BANGALORE_OFFICE_COORDS = {
  latitude: 12.9716,
  longitude: 77.5946,
};

const NULL_ISLAND_EPSILON = 0.001;
const FAR_FROM_OFFICE_METERS = 1000;

function isNullIsland(latitude, longitude) {
  return (
    Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && Math.abs(latitude) < NULL_ISLAND_EPSILON
    && Math.abs(longitude) < NULL_ISLAND_EPSILON
  );
}

export function evaluateGeoAttendance({
  latitude,
  longitude,
  accuracyMeters,
  clientTimestamp,
  office,
  enforceOfficeRadius = true,
}) {
  const rejectionReasons = [];
  const now = new Date();
  const clientTime = new Date(clientTimestamp);
  const ageMs = now.getTime() - clientTime.getTime();

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    rejectionReasons.push('Valid latitude between -90 and 90 is required.');
  }

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    rejectionReasons.push('Valid longitude between -180 and 180 is required.');
  }

  if (isNullIsland(latitude, longitude)) {
    rejectionReasons.push(
      'GPS coordinates look invalid (0,0). Enable location services, allow precise location, and try again.',
    );
  }

  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0) {
    rejectionReasons.push('Location accuracy is unavailable.');
  }

  if (ageMs < -MAX_FUTURE_SKEW_MS) {
    rejectionReasons.push('The location timestamp is invalid.');
  } else if (ageMs > MAX_LOCATION_AGE_MS) {
    rejectionReasons.push('The location reading is stale. Please try again.');
  }

  const distanceMeters = distanceBetweenMeters(
    latitude,
    longitude,
    office.latitude,
    office.longitude,
  );

  const effectiveDistance = distanceMeters + (accuracyMeters || 0);
  const outsideOfficeRadius =
    enforceOfficeRadius && effectiveDistance > office.radiusMeters;

  if (outsideOfficeRadius) {
    let message =
      `You are outside the office radius (${distanceMeters.toFixed(1)} m from centre, GPS uncertainty ±${accuracyMeters.toFixed(1)} m, allowed ${office.radiusMeters} m).`;
    if (distanceMeters > FAR_FROM_OFFICE_METERS) {
      message += ` You appear about ${(distanceMeters / 1000).toFixed(1)} km from the office — use Work from Home if you are not on-site, or ask an admin to verify office coordinates.`;
    }
    rejectionReasons.push(message);
  } else if (
    enforceOfficeRadius &&
    Number.isFinite(accuracyMeters) &&
    accuracyMeters > office.maxAccuracyMeters
  ) {
    rejectionReasons.push(
      `Location accuracy must be ${office.maxAccuracyMeters} metres or better (received ${accuracyMeters.toFixed(1)} m).`,
    );
  }

  return {
    distanceMeters,
    effectiveDistanceMeters: effectiveDistance,
    rejectionReasons,
    isAllowed: rejectionReasons.length === 0,
  };
}
