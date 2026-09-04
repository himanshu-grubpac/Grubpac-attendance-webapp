import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const USER_PIN_COLOR = '#ff5f2e';
const OFFICE_PIN_COLOR = '#4ade80';

function createPinIcon(color) {
  return L.divIcon({
    className: 'check-in-map__pin',
    html: `<span class="check-in-map__pin-dot" style="background:${color};border-color:${color}"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export default function CheckInMap({
  position,
  office,
  showOfficeGeofence = false,
  className = '',
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef({ user: null, office: null, radius: null });

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
    });

    // CARTO raster basemaps require an API key (?key=) or tiles render with an
    // "API key required" watermark. The key is baked in at build time via
    // VITE_CARTO_API_KEY (see client/.env.example). Without it we fall back to
    // the keyless URL so local dev still renders.
    const cartoKey = import.meta.env.VITE_CARTO_API_KEY;
    const tileUrl = cartoKey
      ? `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${cartoKey}`
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

    L.tileLayer(tileUrl, {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      layersRef.current = { user: null, office: null, radius: null };
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const { user, office: officeLayer, radius } = layersRef.current;

    if (user) {
      map.removeLayer(user);
      layersRef.current.user = null;
    }
    if (officeLayer) {
      map.removeLayer(officeLayer);
      layersRef.current.office = null;
    }
    if (radius) {
      map.removeLayer(radius);
      layersRef.current.radius = null;
    }

    const bounds = [];

    if (position) {
      const userMarker = L.marker([position.latitude, position.longitude], {
        icon: createPinIcon(USER_PIN_COLOR),
        title: 'Your location',
      }).addTo(map);
      userMarker.bindPopup('Your location');
      layersRef.current.user = userMarker;
      bounds.push([position.latitude, position.longitude]);
    }

    if (showOfficeGeofence && office?.latitude != null && office?.longitude != null) {
      const officeMarker = L.marker([office.latitude, office.longitude], {
        icon: createPinIcon(OFFICE_PIN_COLOR),
        title: office.name || 'Office',
      }).addTo(map);
      officeMarker.bindPopup(office.name || 'Office');
      layersRef.current.office = officeMarker;
      bounds.push([office.latitude, office.longitude]);

      if (office.radiusMeters > 0) {
        const circle = L.circle([office.latitude, office.longitude], {
          radius: office.radiusMeters,
          color: OFFICE_PIN_COLOR,
          fillColor: OFFICE_PIN_COLOR,
          fillOpacity: 0.08,
          weight: 2,
        }).addTo(map);
        layersRef.current.radius = circle;
      }
    }

    if (bounds.length === 0) {
      map.setView([20.5937, 78.9629], 5);
      return;
    }

    if (bounds.length === 1) {
      map.setView(bounds[0], showOfficeGeofence ? 16 : 17);
      return;
    }

    map.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 });
  }, [position, office, showOfficeGeofence]);

  return (
    <div
      className={`check-in-map${className ? ` ${className}` : ''}`}
      aria-label="Check-in location map"
    >
      <div ref={containerRef} className="check-in-map__canvas" />
      {!position && !showOfficeGeofence ? (
        <p className="check-in-map__placeholder muted small">Waiting for GPS…</p>
      ) : null}
    </div>
  );
}
