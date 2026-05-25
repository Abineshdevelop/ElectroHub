import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── helper: ensure folder exists ─────────────────────────────
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// ── unique filename generator ─────────────────────────────────
function uniqueFilename(file) {
  const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
  return unique + path.extname(file.originalname);
}

// ── file type filter ──────────────────────────────────────────
const fileFilter = (req, file, cb) => {
  const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"), false);
  }
};

// ══════════════════════════════════════════════════════════════
//  PROFILE upload  →  src/public/uploads/profile/
// ══════════════════════════════════════════════════════════════
const profilePath = path.join(__dirname, "../public/uploads/profile");
ensureDir(profilePath);

const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, profilePath),
  filename:    (req, file, cb) => cb(null, uniqueFilename(file)),
});

const upload = multer({
  storage:    profileStorage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

// ══════════════════════════════════════════════════════════════
//  PRODUCT upload  →  src/public/uploads/product/
// ══════════════════════════════════════════════════════════════
const productPath = path.join(__dirname, "../public/uploads/product");
ensureDir(productPath);

const productStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, productPath),
  filename:    (req, file, cb) => cb(null, uniqueFilename(file)),
});

export const uploadProduct = multer({
  storage:    productStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ══════════════════════════════════════════════════════════════
//  BANNER upload  →  src/public/uploads/banners/
// ══════════════════════════════════════════════════════════════
const bannerPath = path.join(__dirname, "../public/uploads/banners");
ensureDir(bannerPath);

const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, bannerPath),
  filename:    (req, file, cb) => cb(null, uniqueFilename(file)),
});

export const uploadBanner = multer({
  storage:    bannerStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ══════════════════════════════════════════════════════════════
//  CATEGORY upload  →  src/public/uploads/category/
// ══════════════════════════════════════════════════════════════
const categoryPath = path.join(__dirname, "../public/uploads/category");
ensureDir(categoryPath);

const categoryStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, categoryPath),
  filename:    (req, file, cb) => cb(null, uniqueFilename(file)),
});

export const uploadCategory = multer({
  storage:    categoryStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ── default export is profile upload
export default upload;