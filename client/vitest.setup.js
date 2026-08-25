import '@testing-library/jest-dom/vitest';

// jsdom does not implement geolocation; provide a deterministic position
// that satisfies the (wfh-skipped) geofence so check-in/out can resolve.
if (!navigator.geolocation) {
  Object.defineProperty(navigator, 'geolocation', { value: {}, configurable: true });
}
navigator.geolocation.getCurrentPosition = (cb) =>
  cb({
    coords: { latitude: 12.9716, longitude: 77.5946, accuracy: 20 },
    timestamp: Date.now(),
  });
