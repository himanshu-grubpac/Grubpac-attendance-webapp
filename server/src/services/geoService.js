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

export function evaluateGeoAttendance({
  latitude,
  longitude,
  accuracyMeters,
  clientTimestamp,
  office,
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

  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0) {
    rejectionReasons.push('Location accuracy is unavailable.');
  } else if (accuracyMeters > office.maxAccuracyMeters) {
    rejectionReasons.push(
      `Location accuracy must be ${office.maxAccuracyMeters} metres or better (received ${accuracyMeters.toFixed(1)} m).`,
    );
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

  if (effectiveDistance > office.radiusMeters) {
    rejectionReasons.push(
      `You are outside the office radius (${distanceMeters.toFixed(1)} m from centre, accuracy ±${accuracyMeters.toFixed(1)} m, allowed ${office.radiusMeters} m).`,
    );
  }

  return {
    distanceMeters,
    effectiveDistanceMeters: effectiveDistance,
    rejectionReasons,
    isAllowed: rejectionReasons.length === 0,
  };
}
