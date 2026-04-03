// Tarang 1.0.0.1 — config/cloudinary.js
// STATELESS: Added uploadAudioBuffer for Buffer uploads (no local file needed).
// Bridge returns MP3 as base64 → Express decodes to Buffer → uploadAudioBuffer.

const cloudinary = require("cloudinary").v2;
const fs         = require("fs");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

// ── Upload audio from local file path (kept for legacy use) ──────────────────
const uploadAudio = async (localFilePath, options = {}) => {
  const { folder = "tarang/audio", publicId = null } = options;

  if (!fs.existsSync(localFilePath)) {
    throw new Error(`File not found: ${localFilePath}`);
  }

  const uploadOptions = {
    resource_type:   "video",   // Cloudinary uses "video" for audio
    folder,
    use_filename:    true,
    unique_filename: true,
    overwrite:       false,
  };
  if (publicId) uploadOptions.public_id = publicId;

  const result = await cloudinary.uploader.upload(localFilePath, uploadOptions);
  return {
    url:      result.secure_url,
    publicId: result.public_id,
    duration: result.duration,
    format:   result.format,
    bytes:    result.bytes,
  };
};

// ── Upload audio from Buffer (STATELESS — no local file needed) ───────────────
// Used by documentController when bridge returns mp3_b64 (base64-encoded MP3).
// Express decodes base64 → Buffer → passes here. Never writes to disk.
const uploadAudioBuffer = (buffer, options = {}) => {
  const { folder = "tarang/audio", publicId = null } = options;

  return new Promise((resolve, reject) => {
    const uploadOptions = {
      resource_type:   "video",   // Cloudinary uses "video" for audio
      folder,
      unique_filename: true,
      overwrite:       true,
    };
    if (publicId) uploadOptions.public_id = publicId;

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve({
            url:      result.secure_url,
            publicId: result.public_id,
            duration: result.duration,
            format:   result.format,
            bytes:    result.bytes,
          });
        }
      }
    );

    uploadStream.end(buffer);
  });
};

// ── Delete audio from Cloudinary ──────────────────────────────────────────────
const deleteAudio = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
  } catch (e) {
    console.error("Cloudinary delete failed:", e.message);
  }
};

// ── Check if Cloudinary is configured ────────────────────────────────────────
const isConfigured = () =>
  !!(process.env.CLOUDINARY_CLOUD_NAME &&
     process.env.CLOUDINARY_API_KEY    &&
     process.env.CLOUDINARY_API_SECRET);

module.exports = { cloudinary, uploadAudio, uploadAudioBuffer, deleteAudio, isConfigured };
