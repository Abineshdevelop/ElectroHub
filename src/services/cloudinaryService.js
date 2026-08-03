import cloudinary from "../config/cloudinary.js";

/**
 * Uploads a file (buffer or local path) to Cloudinary
 * @param {Object} file - Multer file object (containing buffer or path)
 * @param {string} folder - Destination folder on Cloudinary
 * @returns {Promise<Object>} Cloudinary upload result
 */
export const uploadToCloudinary = (file, folder = "electrohub") => {
  return new Promise((resolve, reject) => {
    const options = {
      folder: folder,
      resource_type: "auto",
    };

    if (file.buffer) {
      const uploadStream = cloudinary.uploader.upload_stream(
        options,
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      );
      uploadStream.end(file.buffer);
    } else if (file.path) {
      cloudinary.uploader.upload(file.path, options, (error, result) => {
        if (error) return reject(error);
        resolve(result);
      });
    } else {
      reject(new Error("No valid buffer or path found in file object."));
    }
  });
};

/**
 * Deletes an image from Cloudinary given its public ID or full secure URL
 * @param {string} publicIdOrUrl 
 */
export const deleteFromCloudinary = async (publicIdOrUrl) => {
  if (!publicIdOrUrl || typeof publicIdOrUrl !== "string") return;

  try {
    let publicId = publicIdOrUrl;
    if (publicIdOrUrl.startsWith("http://") || publicIdOrUrl.startsWith("https://")) {
      const urlParts = publicIdOrUrl.split("/upload/");
      if (urlParts.length > 1) {
        const pathAfterUpload = urlParts[1].replace(/^v\d+\//, "");
        const lastDotIndex = pathAfterUpload.lastIndexOf(".");
        publicId = lastDotIndex !== -1 ? pathAfterUpload.substring(0, lastDotIndex) : pathAfterUpload;
      }
    }

    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error("Cloudinary image deletion error:", error);
  }
};
