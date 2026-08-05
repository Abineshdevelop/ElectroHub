import { uploadToCloudinary } from '../services/cloudinaryService.js';
import fs from 'fs';

export const uploadToCloudinaryMiddleware = (folderName) => async (req, res, next) => {
  try {
    if (req.file) {
      const result = await uploadToCloudinary(req.file, folderName);
      // delete local file
      if (req.file.path && fs.existsSync(req.file.path)) {
        fs.unlink(req.file.path, () => {});
      }
      req.file.path = result.secure_url;
      req.file.filename = result.secure_url;
    }
    
    if (req.files && Array.isArray(req.files)) {
      await Promise.all(req.files.map(async (file) => {
        const result = await uploadToCloudinary(file, folderName);
        if (file.path && fs.existsSync(file.path)) {
          fs.unlink(file.path, () => {});
        }
        file.path = result.secure_url;
        file.filename = result.secure_url;
      }));
    }
    
    // Sometimes multer puts files in an object (e.g. upload.fields)
    if (req.files && typeof req.files === 'object' && !Array.isArray(req.files)) {
      for (const key in req.files) {
        await Promise.all(req.files[key].map(async (file) => {
          const result = await uploadToCloudinary(file, folderName);
          if (file.path && fs.existsSync(file.path)) {
            fs.unlink(file.path, () => {});
          }
          file.path = result.secure_url;
          file.filename = result.secure_url;
        }));
      }
    }

    next();
  } catch (error) {
    console.error("Cloudinary upload middleware error:", error);
    next(error);
  }
};
