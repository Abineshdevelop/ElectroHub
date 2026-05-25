import Banner from "../../model/bannerModel.js";
import Offer from "../../model/offersModel.js";
import Product from "../../model/productModel.js";
import Category from "../../model/categoryModel.js";
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

    const [bannersRaw, offersRaw] = await Promise.all([
      Banner.find(filter)
        .populate("offerId")
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * LIMIT)
        .limit(LIMIT)
        .lean(),
      Offer.find({ isDeleted: false, isActive: true }).lean()
    ]);

    const offers = [];//load offers for banner
    for (const off of offersRaw) {
      if (off.offerType === "product") {
        const prod = await Product.findOne({ _id: off.refId, isDeleted: false }).lean();
        off.targetName = prod ? prod.productName : "Unknown Product";
      } else if (off.offerType === "category") {
        const cat = await Category.findOne({ _id: off.refId, isDeleted: false }).lean();
        off.targetName = cat ? cat.categoryName : "Unknown Category";
      } else {
        off.targetName = "";
      }
      offers.push(off);
    }
    //console.log(offers)

    const banners = [];
    for (const b of bannersRaw) {
      if (b.offerId) {
        const offer = b.offerId;
        if (offer.offerType === "product") {
          const prod = await Product.findOne({ _id: offer.refId, isDeleted: false });
          b.redirectType = "product";
          b.redirectValue = prod ? prod.productName : "Unknown Product";
        } else if (offer.offerType === "category") {
          const cat = await Category.findOne({ _id: offer.refId, isDeleted: false });
          b.redirectType = "category";
          b.redirectValue = cat ? cat.categoryName : "Unknown Category";
        }
      } else {
        b.redirectType = "";
        b.redirectValue = "—";
      }
      banners.push(b);
    }

    const data = { banners, tab, total, totalPages, currentPage, showingFrom, showingTo };

    if (req.query.ajax === "1") return res.json({ success: true, ...data });
    res.render("admin/banners", { ...data, offers });
  } catch (err) {
    next(err)
  }
};


function getErrors({ type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status }) {
  if (!type || !["hero", "promo"].includes(type)) {
    return "Banner type must be 'hero' or 'promo'.";
  }
  if (type === "hero") {
    if (!title?.trim()) {
      return "Title is required for hero banners.";
    }
    if (title.trim().length > 100) {
      return "Title must not exceed 100 characters.";
    }
    if (subtitle && subtitle.trim().length > 200) {
      return "Subtitle must not exceed 200 characters.";
    }
  }
  if (type === "promo") {
    if (!badgeText?.trim()) {
      return "Badge text is required for promo banners.";
    }
    if (badgeText.trim().length > 50) {
      return "Badge text must not exceed 50 characters.";
    }
    if (offerText && offerText.trim().length > 100) {
      return "Offer text must not exceed 100 characters.";
    }
  }
  if (status && !["active", "inactive"].includes(status)) {
    return "Status must be 'active' or 'inactive'.";
  }
  const countdownOn = countdownEnabled === "true" || countdownEnabled === true;
  if (countdownOn && !countdownEndDate) {
    return "Countdown end date is required.";
  }
  if (countdownOn && countdownEndDate && new Date(countdownEndDate) <= new Date()) {
    return "Countdown end date must be in the future.";
  }
  return null;
}

export const createBanner = async (req, res) => {
  try {
    const { type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status, offerId } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Banner image is required." });
    }
    const newImagePath = `/uploads/banners/${req.file.filename}`;

    const error = getErrors({ type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status });
    if (error) {
      deleteImage(newImagePath);
      return res.status(400).json({ success: false, message: error });
    }

    const countdownOn = countdownEnabled === "true" || countdownEnabled === true;

    let computedRedirectType = "product";
    let computedRedirectValue = "";

    if (offerId && offerId.trim() !== "") {
      if (!offerId.match(/^[0-9a-fA-F]{24}$/)) {
        deleteImage(newImagePath);
        return res.status(400).json({ success: false, message: "Selected offer is invalid." });
      }
      const offerDoc = await Offer.findOne({ _id: offerId, isDeleted: false });
      if (!offerDoc) {
        deleteImage(newImagePath);
        return res.status(400).json({ success: false, message: "Selected offer is invalid or deactivated." });
      }
      if (offerDoc.offerType === "product") {
        const prod = await Product.findOne({ _id: offerDoc.refId, isDeleted: false });
        computedRedirectType = "product";
        computedRedirectValue = prod ? prod.productName : "";
      } else if (offerDoc.offerType === "category") {
        computedRedirectType = "category";
        computedRedirectValue = offerDoc.refId.toString();
      }
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
      offerId: offerId && offerId.trim() !== "" ? offerId : null,
      redirectType: computedRedirectType,
      redirectValue: computedRedirectValue,
    });

    res.status(201).json({ success: true, message: "Banner created successfully", banner });

  } catch (err) {
    console.error(err);
    if (req.file) deleteImage(`/uploads/banners/${req.file.filename}`);
    res.status(500).json({ success: false, message: "Failed to create banner" });
  }
};

export const getBannerById = async (req, res,next) => {//edit banner
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid banner ID" });
    }
    const banner = await Banner.findOne({
      _id: req.params.id,
      isDeleted: false,
    }).populate("offerId").lean();

    if (!banner)
      return res
        .status(404)
        .json({ success: false, message: "Banner not found" });

    if (banner.offerId) {
if (offer.offerType === "product") {

  const prod = await Product.findOne({
    _id: offer.refId,
    isDeleted: false
  });

  banner.redirectType = "product";  //if redirect type is product then product redirect
  if (prod) {
    banner.redirectValue = prod.productName;
  } else {
    banner.redirectValue = "";
  }

} else if (offer.offerType === "category") {

  const cat = await Category.findOne({ _id: offer.refId,isDeleted: false});//category

  banner.redirectType = "category"; //if redirect type is category then by category

  if (cat) {
    banner.redirectValue = cat.categoryName;
  } else {
    banner.redirectValue = "";
  }

}
    } else {
      banner.redirectType = "";
      banner.redirectValue = "";
    }

    res.json({ success: true, banner });
  } catch (err) {
    next(err)
  }
};

export const editBanner = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/))
      return res.status(400).json({ success: false, message: "Invalid banner ID" });

    const { type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status, offerId } = req.body;

    const error = getErrors({ type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status });
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

    let computedRedirectType = "product";
    let computedRedirectValue = "";

    if (offerId && offerId.trim() !== "") {
      if (!offerId.match(/^[0-9a-fA-F]{24}$/)) {
        if (req.file) deleteImage(`/uploads/banners/${req.file.filename}`);
        return res.status(400).json({ success: false, message: "Selected offer is invalid." });
      }
      const offerDoc = await Offer.findOne({ _id: offerId, isDeleted: false });
      if (!offerDoc) {
        if (req.file) deleteImage(`/uploads/banners/${req.file.filename}`);
        return res.status(400).json({ success: false, message: "Selected offer is invalid or deactivated." });
      }
      if (offerDoc.offerType === "product") {
        const prod = await Product.findOne({ _id: offerDoc.refId, isDeleted: false });
        computedRedirectType = "product";
        computedRedirectValue = prod ? prod.productName : "";
      } else if (offerDoc.offerType === "category") {
        computedRedirectType = "category";
        computedRedirectValue = offerDoc.refId.toString();
      }
    }

    banner.type = type;
    banner.title = title?.trim() || "";
    banner.subtitle = subtitle?.trim() || "";
    banner.badgeText = badgeText?.trim() || "";
    banner.offerText = offerText?.trim() || "";
    banner.countdownEnabled = countdownOn;
    banner.countdownEndDate = countdownOn ? new Date(countdownEndDate) : null;
    banner.status = status || "active";
    banner.offerId = offerId && offerId.trim() !== "" ? offerId : null;
    banner.redirectType = computedRedirectType;
    banner.redirectValue = computedRedirectValue;
    await banner.save();

    res.json({ success: true, message: "Banner updated successfully", banner });
  } catch (err) {
    console.error(err);
    if (req.file) deleteImage(`/uploads/banners/${req.file.filename}`);
    res.status(500).json({ success: false, message: "Failed to update banner" });
  }
};

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