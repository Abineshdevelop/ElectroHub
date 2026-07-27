import multer from "multer";
import { uploadToCloudinary } from "../services/cloudinaryService.js";

// Memory storage to hold file buffer in memory before uploading to Cloudinary
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"), false);
  }
};

const profileMulter  = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const productMulter  = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });
const bannerMulter   = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });
const categoryMulter = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

// Helper function to process files attached to req and upload them to Cloudinary
async function processCloudinaryUploads(req, folder) {
  if (req.file) {
    const result = await uploadToCloudinary(req.file, folder);
    req.file.path = result.secure_url;
    req.file.filename = result.secure_url;
    req.file.cloudinaryResult = result;
  }

  if (req.files) {
    if (Array.isArray(req.files)) {
      for (const file of req.files) {
        const result = await uploadToCloudinary(file, folder);
        file.path = result.secure_url;
        file.filename = result.secure_url;
        file.cloudinaryResult = result;
      }
    } else if (typeof req.files === "object") {
      for (const key of Object.keys(req.files)) {
        const fileList = Array.isArray(req.files[key]) ? req.files[key] : [req.files[key]];
        for (const file of fileList) {
          const result = await uploadToCloudinary(file, folder);
          file.path = result.secure_url;
          file.filename = result.secure_url;
          file.cloudinaryResult = result;
        }
      }
    }
  }
}

// ── Profile Upload Middleware ─────────────────────────────────
export const upload = {
  single: (fieldName) => (req, res, next) => {
    profileMulter.single(fieldName)(req, res, async (err) => {
      if (err) return next(err);
      try {
        await processCloudinaryUploads(req, "electrohub/profile");
        next();
      } catch (uploadErr) {
        next(uploadErr);
      }
    });
  },
  array: (fieldName, maxCount) => (req, res, next) => {
    profileMulter.array(fieldName, maxCount)(req, res, async (err) => {
      if (err) return next(err);
      try {
        await processCloudinaryUploads(req, "electrohub/profile");
        next();
      } catch (uploadErr) {
        next(uploadErr);
      }
    });
  },
};

// ── Product Upload Middleware ─────────────────────────────────
export const uploadProduct = {
  any: () => (req, res, next) => {
    productMulter.any()(req, res, async (err) => {
      if (err) return next(err);
      try {
        await processCloudinaryUploads(req, "electrohub/product");
        next();
      } catch (uploadErr) {
        next(uploadErr);
      }
    });
  },
  fields: (fields) => (req, res, next) => {
    productMulter.fields(fields)(req, res, async (err) => {
      if (err) return next(err);
      try {
        await processCloudinaryUploads(req, "electrohub/product");
        next();
      } catch (uploadErr) {
        next(uploadErr);
      }
    });
  },
  single: (fieldName) => (req, res, next) => {
    productMulter.single(fieldName)(req, res, async (err) => {
      if (err) return next(err);
      try {
        await processCloudinaryUploads(req, "electrohub/product");
        next();
      } catch (uploadErr) {
        next(uploadErr);
      }
    });
  },
};

// ── Banner Upload Middleware ──────────────────────────────────
export const uploadBanner = {
  single: (fieldName) => (req, res, next) => {
    bannerMulter.single(fieldName)(req, res, async (err) => {
      if (err) return next(err);
      try {
        await processCloudinaryUploads(req, "electrohub/banners");
        next();
      } catch (uploadErr) {
        next(uploadErr);
      }
    });
  },
};

// ── Category Upload Middleware ────────────────────────────────
export const uploadCategory = {
  single: (fieldName) => (req, res, next) => {
    categoryMulter.single(fieldName)(req, res, async (err) => {
      if (err) return next(err);
      try {
        await processCloudinaryUploads(req, "electrohub/category");
        next();
      } catch (uploadErr) {
        next(uploadErr);
      }
    });
  },
};

export default upload;