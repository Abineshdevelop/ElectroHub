/**
 * Normalizes image paths stored in DB or received from upload into web-accessible relative paths or absolute URLs.
 * Handles:
 * - Full Cloudinary / External URLs: http://... or https://...
 * - Absolute local disk paths: /Users/.../src/public/uploads/product/abc.jpg -> /uploads/product/abc.jpg
 * - Relative upload paths: uploads/product/abc.jpg -> /uploads/product/abc.jpg
 * - Static public paths: /images/... -> /images/...
 * - Filename only: abc.jpg -> /uploads/<folder>/abc.jpg
 */
export function formatImagePath(imgPath, defaultFolder = "product") {
  if (!imgPath || typeof imgPath !== "string") return "";
  const trimmed = imgPath.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:")) {
    return trimmed;
  }

  if (trimmed.includes("/uploads/")) {
    const relative = trimmed.split("/uploads/")[1].replace(/\\/g, "/");
    return `/uploads/${relative}`;
  }

  if (trimmed.includes("\\uploads\\")) {
    const relative = trimmed.split("\\uploads\\")[1].replace(/\\/g, "/");
    return `/uploads/${relative}`;
  }

  if (trimmed.startsWith("/images/") || trimmed.startsWith("images/")) {
    return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
  }

  if (trimmed.startsWith("/")) {
    return trimmed;
  }

  return `/uploads/${defaultFolder}/${trimmed}`;
}

export default formatImagePath;
