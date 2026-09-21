import '@testing-library/jest-dom/vitest';

/** In-memory Storage for Node 24+ where global localStorage may lack .clear(). */
function createStorageMock() {
  let store = Object.create(null);
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      store = Object.create(null);
    },
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    key(index) {
      return Object.keys(store)[index] ?? null;
    },
    removeItem(key) {
      delete store[key];
    },
    setItem(key, value) {
      store[key] = String(value);
    },
  };
}

for (const name of ['localStorage', 'sessionStorage']) {
  const storage = globalThis[name];
  if (!storage || typeof storage.clear !== 'function') {
    Object.defineProperty(globalThis, name, {
      value: createStorageMock(),
      configurable: true,
      writable: true,
    });
  }
}

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
