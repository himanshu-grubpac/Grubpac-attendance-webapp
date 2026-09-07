import multer from 'multer';

/**
 * Wrap a multer instance's `.single('file')` middleware so upload-level
 * failures (missing multipart boundary, file-size limit, file-type filter)
 * surface as 400 JSON the UI can display — instead of falling through to
 * the generic 500 handler.
 */
export function singleFileUpload(upload) {
  return (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'File exceeds the 5 MB limit.'
            : `Upload failed: ${err.message}`;
        return res.status(400).json({ message });
      }

      if (/boundary not found/i.test(err?.message ?? '')) {
        return res.status(400).json({
          message: 'Malformed upload: multipart boundary is missing. Please retry the upload from the app.',
        });
      }

      return res.status(400).json({ message: err?.message || 'File upload failed.' });
    });
  };
}
