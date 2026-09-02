/**
 * Build synthetic geo fields for admin-created or auto-generated attendance records.
 * Extracted to a lightweight module so Lambda jobs don't import the heavy attendanceService.
 */
export function buildAdminSyntheticGeoFields(office) {
  return {
    latitude: office.latitude,
    longitude: office.longitude,
    accuracyMeters: 1,
    distanceMeters: 0,
    officeLatitude: office.latitude,
    officeLongitude: office.longitude,
    radiusMeters: office.radiusMeters,
  };
}
