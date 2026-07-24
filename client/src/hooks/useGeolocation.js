import { useCallback, useState } from 'react';
import {
  GPS_SAMPLE_COUNT,
  GPS_SAMPLE_INTERVAL_MS,
} from '@shared/validation/common.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapGeoError(error) {
  if (!error) return 'Location unavailable.';
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'Location permission denied. Please allow precise location access.';
    case error.POSITION_UNAVAILABLE:
      return 'Location information is unavailable.';
    case error.TIMEOUT:
      return 'Location request timed out. Please try again in an open area.';
    default:
      return error.message || 'Failed to read location.';
  }
}

function readSinglePosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
          clientTimestamp: new Date().toISOString(),
        });
      },
      (geoError) => reject(new Error(mapGeoError(geoError))),
      {
        enableHighAccuracy: true,
        timeout: 25000,
        maximumAge: 0,
      },
    );
  });
}

export function useGeolocation() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [position, setPosition] = useState(null);
  const [sampleInfo, setSampleInfo] = useState(null);

  const getPosition = useCallback(async ({ fresh = true } = {}) => {
    if (!navigator.geolocation) {
      const message = 'Geolocation is not supported by this browser.';
      setError(message);
      throw new Error(message);
    }

    setLoading(true);
    setError(null);

    try {
      const readings = [];
      const samples = fresh ? GPS_SAMPLE_COUNT : 1;

      for (let index = 0; index < samples; index += 1) {
        const reading = await readSinglePosition();
        readings.push(reading);
        if (index < samples - 1) {
          await sleep(GPS_SAMPLE_INTERVAL_MS);
        }
      }

      const best = readings.reduce((currentBest, reading) =>
        reading.accuracyMeters < currentBest.accuracyMeters ? reading : currentBest,
      );

      setPosition(best);
      setSampleInfo({
        samples: readings.length,
        bestAccuracy: best.accuracyMeters,
        capturedAt: best.clientTimestamp,
      });
      setLoading(false);
      return best;
    } catch (geoError) {
      const message = geoError.message || 'Failed to read location.';
      setError(message);
      setLoading(false);
      throw geoError;
    }
  }, []);

  return { getPosition, loading, error, position, sampleInfo };
}
