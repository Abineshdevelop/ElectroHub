import Banner from "../../model/bannerModel.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function deleteImage(imagePath) {
  if (!imagePath) return;
  const fullPath = path.join(__dirname, "../../public", imagePath);
  if (fs.existsSync(fullPath)) fs.unlink(fullPath, () => {});
}

function getFilter(tab) {
  const base = { isDeleted: false };
  if (tab === "hero") return { ...base, type: "hero" };
  if (tab === "promo") return { ...base, type: "promo" };
  if (tab === "active") return { ...base, status: "active" };
  if (tab === "inactive") return { ...base, status: "inactive" };
  return base;
}

const LIMIT = 10;

export const getBannersPage = async (req, res, next) => {
  try {
    const tab = ["all", "hero", "promo", "active", "inactive"].includes(req.query.tab) ? req.query.tab : "all";
    const page = Math.max(1, Number(req.query.page) || 1);
    const filter = getFilter(tab);

    const total = await Banner.countDocuments(filter);//25
    const totalPages = Math.ceil(total / LIMIT) || 1;//3
    const currentPage = Math.min(page, totalPages);
    const showingFrom = total === 0 ? 0 : (currentPage - 1) * LIMIT + 1;
    const showingTo = Math.min(currentPage * LIMIT, total);

    const banners = await Banner.find(filter)
      .sort({ createdAt: -1 })
      .skip((currentPage - 1) * LIMIT)
      .limit(LIMIT)
      .lean();

    const data = { banners, tab, total, totalPages, currentPage, showingFrom, showingTo };

    if (req.query.ajax === "1") return res.json({ success: true, ...data });
    res.render("admin/banners", data);
  } catch (err) {
    next(err)
  }
};


export const createBanner = async (req, res) => {
  try {
    const { type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status } = req.body;
    const newImagePath = req.file ? `/uploads/banners/${req.file.filename}` : "";

    if (!type || !["hero", "promo"].includes(type)) { //type must be hero or promo if other delete image 
      if (newImagePath) deleteImage(newImagePath);
      return res.status(400).json({ success: false, message: "Banner type must be 'hero' or 'promo'." });
    }

    //console.log("type",type)

    // hero → title required
    if (type === "hero" && !title?.trim()) {
      if (newImagePath) deleteImage(newImagePath);
      return res.status(400).json({ success: false, message: "Title is required for hero banners." });
    }

    // promo → badgeText required
    if (type === "promo" && !badgeText?.trim()) {
      if (newImagePath) deleteImage(newImagePath);
      return res.status(400).json({ success: false, message: "Badge text is required for promo banners." });
    }

    // status validation
    if (status && !["active", "inactive"].includes(status)) {
      if (newImagePath) deleteImage(newImagePath);
      return res.status(400).json({ success: false, message: "Status must be 'active' or 'inactive'." });
    }

    // countdown validation
    const countdownOn = countdownEnabled === "true" || countdownEnabled === true;

    if (countdownOn && !countdownEndDate) {
      if (newImagePath) deleteImage(newImagePath);
      return res.status(400).json({ success: false, message: "Countdown end date is required." });
    }

    if (countdownOn && countdownEndDate && new Date(countdownEndDate) <= new Date()) {
      if (newImagePath) deleteImage(newImagePath);
      return res.status(400).json({ success: false, message: "Countdown end date must be in the future." });
    }


    const banner = await Banner.create({
      type,
      title: title?.trim() || "",
      subtitle: subtitle?.trim() || "",
      badgeText: badgeText?.trim() || "",
      offerText: offerText?.trim() || "",
      image: newImagePath,
      countdownEnabled: countdownOn,
      countdownEndDate: countdownOn ? new Date(countdownEndDate) : null,
      status: status || "active",
    });

    res.status(201).json({ success: true, message: "Banner created successfully", banner });

  } catch (err) {
    console.error(err);
    if (req.file) deleteImage(`/uploads/banners/${req.file.filename}`);
    res.status(500).json({ success: false, message: "Failed to create banner" });
  }
};

export const getBannerById = async (req, res,next) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid banner ID" });
    }
    const banner = await Banner.findOne({
      _id: req.params.id,
      isDeleted: false,
    }).lean();
    if (!banner)
      return res
        .status(404)
        .json({ success: false, message: "Banner not found" });
    res.json({ success: true, banner });
  } catch (err) {
    next(err)
  }
};

// PUT /banners/:id
export const editBanner = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/))
      return res.status(400).json({ success: false, message: "Invalid banner ID" });

    const { type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status } = req.body;

    const error = getErrors({ type, title, badgeText, countdownEnabled, countdownEndDate, status });
    if (error) {
      if (req.file) deleteImage(`/uploads/banners/${req.file.filename}`);
      return res.status(400).json({ success: false, message: error });
    }

    const banner = await Banner.findOne({ _id: req.params.id, isDeleted: false });
    if (!banner) {
      if (req.file) deleteImage(`/uploads/banners/${req.file.filename}`);
      return res.status(404).json({ success: false, message: "Banner not found" });
    }

    const countdownOn = countdownEnabled === "true" || countdownEnabled === true;

    if (req.file) {
      deleteImage(banner.image);
      banner.image = `/uploads/banners/${req.file.filename}`;
    }

    banner.type = type;
    banner.title = title?.trim() || "";
    banner.subtitle = subtitle?.trim() || "";
    banner.badgeText = badgeText?.trim() || "";
    banner.offerText = offerText?.trim() || "";
    banner.countdownEnabled = countdownOn;
    banner.countdownEndDate = countdownOn ? new Date(countdownEndDate) : null;
    banner.status = status || "active";
    await banner.save();

    res.json({ success: true, message: "Banner updated successfully", banner });
  } catch (err) {
    console.error(err);
    if (req.file) deleteImage(`/uploads/banners/${req.file.filename}`);
    res.status(500).json({ success: false, message: "Failed to update banner" });
  }
};

// PATCH /banners/:id/toggle
export const toggleBanner = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/))
      return res.status(400).json({ success: false, message: "Invalid banner ID" });

    const banner = await Banner.findOne({ _id: req.params.id, isDeleted: false });
    if (!banner) return res.status(404).json({ success: false, message: "Banner not found" });

    banner.status = banner.status === "active" ? "inactive" : "active";
    await banner.save();

    const msg = banner.status === "active" ? "activated" : "deactivated";
    res.json({ success: true, message: `Banner ${msg} successfully`, status: banner.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to toggle banner" });
  }
};

// DELETE /banners/:id
export const deleteBanner = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/))
      return res.status(400).json({ success: false, message: "Invalid banner ID" });

    const banner = await Banner.findOne({ _id: req.params.id, isDeleted: false });
    if (!banner) return res.status(404).json({ success: false, message: "Banner not found" });

    banner.isDeleted = true;
    banner.status = "inactive";
    await banner.save();

    res.json({ success: true, message: "Banner deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to delete banner" });
  }
};