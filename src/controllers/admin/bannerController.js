import Banner from "../../model/bannerModel.js";
import Offer from "../../model/offersModel.js";
import Product from "../../model/productModel.js";
import Category from "../../model/categoryModel.js";
import { deleteFromCloudinary } from "../../services/cloudinaryService.js";
import { formatImagePath } from "../../utils/imageUtils.js";

const PER_PAGE   = 10;

function deleteImage(imagePath) {
  if (!imagePath) return;
  deleteFromCloudinary(imagePath);
}

function getFilter(tab) {
  const baseFilter = { isDeleted: false };
  if (tab === "hero") return { ...baseFilter, type: "hero" };
  if (tab === "promo") return { ...baseFilter, type: "promo" };
  if (tab === "active") return { ...baseFilter, status: "active" };
  if (tab === "inactive") return { ...baseFilter, status: "inactive" };
  return baseFilter;
}

function getValidationError({ type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status }) {
  if (!type || !["hero", "promo"].includes(type)) return "Banner type must be 'hero' or 'promo'.";

  if (type === "hero") {
    if (!title?.trim()) return "Title is required for hero banners.";
    if (title.trim().length > 100) return "Title must not exceed 100 characters.";
    if (subtitle && subtitle.trim().length > 200) return "Subtitle must not exceed 200 characters.";
  }
  if (type === "promo") {
    if (!badgeText?.trim()) return "Badge text is required for promo banners.";
    if (badgeText.trim().length > 50) return "Badge text must not exceed 50 characters.";
    if (offerText && offerText.trim().length > 100) return "Offer text must not exceed 100 characters.";
  }

  if (status && !["active", "inactive"].includes(status)) return "Status must be 'active' or 'inactive'.";

  const isCountdownOn = countdownEnabled === "true" || countdownEnabled === true;
  if (isCountdownOn && !countdownEndDate) return "Countdown end date is required.";
  if (isCountdownOn && countdownEndDate && new Date(countdownEndDate) <= new Date()) {
    return "Countdown end date must be in the future.";
  }
  return null;
}

export const getBannersPage = async (req, res, next) => {
  try {
    const activeTab     = ["all", "hero", "promo", "active", "inactive"].includes(req.query.tab) ? req.query.tab : "all";
    const requestedPage = Math.max(1, parseInt(req.query.page) || 1);
    const filter        = getFilter(activeTab);

    const totalBanners = await Banner.countDocuments(filter);
    const totalPages   = Math.max(1, Math.ceil(totalBanners / PER_PAGE));
    const currentPage  = Math.min(requestedPage, totalPages);
    const showingFrom  = totalBanners === 0 ? 0 : (currentPage - 1) * PER_PAGE + 1;
    const showingTo    = Math.min(currentPage * PER_PAGE, totalBanners);

    const [rawBanners, rawOffers] = await Promise.all([
      Banner.find(filter)
        .populate("offerId")
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * PER_PAGE)
        .limit(PER_PAGE)
        .lean(),
      Offer.find({ isDeleted: false, isActive: true }).lean(),
    ]);

    const processedOffers = [];
    for (const offer of rawOffers) {
      if (offer.offerType === "product") {
        const product = await Product.findOne({ _id: offer.refId, isDeleted: false }).lean();
        offer.targetName = product ? product.productName : "Unknown Product";
      } else if (offer.offerType === "category") {
        const category = await Category.findOne({ _id: offer.refId, isDeleted: false }).lean();
        offer.targetName = category ? category.categoryName : "Unknown Category";
      } else {
        offer.targetName = "";
      }
      processedOffers.push(offer);
    }

    const processedBanners = [];
    for (const banner of rawBanners) {
      if (banner.offerId) {
        const offer = banner.offerId;
        if (offer.offerType === "product") {
          const product = await Product.findOne({ _id: offer.refId, isDeleted: false }).lean();
          banner.redirectType = "product";
          banner.redirectValue = product ? product.productName : "Unknown Product";
        } else if (offer.offerType === "category") {
          const category = await Category.findOne({ _id: offer.refId, isDeleted: false }).lean();
          banner.redirectType = "category";
          banner.redirectValue = category ? category.categoryName : "Unknown Category";
        }
      } else {
        banner.redirectType = "";
        banner.redirectValue = "—";
      }
      processedBanners.push(banner);
    }

    const responseData = {
      banners: processedBanners,
      tab: activeTab,
      total: totalBanners,
      totalPages,
      currentPage,
      showingFrom,
      showingTo,
    };

    if (req.query.ajax === "1") return res.json({ success: true, ...responseData });
    res.render("admin/banners", { ...responseData, offers: processedOffers });
  } catch (err) {
    next(err);
  }
};

export const createBanner = async (req, res) => {
  try {
    const { type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status, offerId } = req.body;

    if (!req.file || !req.file.path) return res.status(400).json({ success: false, message: "Banner image is required." });
    const newImagePath = req.file.path;

    const validationError = getValidationError({ type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status });
    if (validationError) {
      deleteImage(newImagePath);
      return res.status(400).json({ success: false, message: validationError });
    }

    const isCountdownOn = countdownEnabled === "true" || countdownEnabled === true;
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
        const product = await Product.findOne({ _id: offerDoc.refId, isDeleted: false });
        computedRedirectType = "product";
        computedRedirectValue = product ? product.productName : "";
      } else if (offerDoc.offerType === "category") {
        computedRedirectType = "category";
        computedRedirectValue = offerDoc.refId.toString();
      }
    }

    const banner = await Banner.create({
      type,
      title:            title?.trim() || "",
      subtitle:         subtitle?.trim() || "",
      badgeText:        badgeText?.trim() || "",
      offerText:        offerText?.trim() || "",
      image:            formatImagePath(newImagePath, "banners"),
      countdownEnabled: isCountdownOn,
      countdownEndDate: isCountdownOn ? new Date(countdownEndDate) : null,
      status:           status || "active",
      offerId:          offerId && offerId.trim() !== "" ? offerId : null,
      redirectType:     computedRedirectType,
      redirectValue:    computedRedirectValue,
    });

    res.status(201).json({ success: true, message: "Banner created successfully.", banner });
  } catch (err) {
    console.error(err);
    if (req.file) deleteImage(req.file.path || req.file.filename);
    res.status(500).json({ success: false, message: "Failed to create banner." });
  }
};

export const getBannerById = async (req, res, next) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/))
      return res.status(400).json({ success: false, message: "Invalid banner ID." });

    const banner = await Banner.findOne({ _id: req.params.id, isDeleted: false }).populate("offerId").lean();
    if (!banner) return res.status(404).json({ success: false, message: "Banner not found." });

    if (banner.offerId) {
      const offer = banner.offerId;
      if (offer.offerType === "product") {
        const product = await Product.findOne({ _id: offer.refId, isDeleted: false });
        banner.redirectType = "product";
        banner.redirectValue = product ? product.productName : "";
      } else if (offer.offerType === "category") {
        const category = await Category.findOne({ _id: offer.refId, isDeleted: false });
        banner.redirectType = "category";
        banner.redirectValue = category ? category.categoryName : "";
      }
    } else {
      banner.redirectType = "";
      banner.redirectValue = "";
    }

    res.json({ success: true, banner });
  } catch (err) {
    next(err);
  }
};

export const editBanner = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/))
      return res.status(400).json({ success: false, message: "Invalid banner ID." });

    const { type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status, offerId } = req.body;

    const validationError = getValidationError({ type, title, subtitle, badgeText, offerText, countdownEnabled, countdownEndDate, status });
    if (validationError) {
      if (req.file) deleteImage(req.file.path || req.file.filename);
      return res.status(400).json({ success: false, message: validationError });
    }

    const banner = await Banner.findOne({ _id: req.params.id, isDeleted: false });
    if (!banner) {
      if (req.file) deleteImage(req.file.path || req.file.filename);
      return res.status(404).json({ success: false, message: "Banner not found." });
    }

    const isCountdownOn = countdownEnabled === "true" || countdownEnabled === true;

    if (req.file) {
      deleteImage(banner.image);
      banner.image = formatImagePath(req.file.path, "banners");
    }

    let computedRedirectType = "product";
    let computedRedirectValue = "";

    if (offerId && offerId.trim() !== "") {
      if (!offerId.match(/^[0-9a-fA-F]{24}$/)) {
        if (req.file) deleteImage(req.file.path || req.file.filename);
        return res.status(400).json({ success: false, message: "Selected offer is invalid." });
      }
      const offerDoc = await Offer.findOne({ _id: offerId, isDeleted: false });
      if (!offerDoc) {
        if (req.file) deleteImage(req.file.path || req.file.filename);
        return res.status(400).json({ success: false, message: "Selected offer is invalid or deactivated." });
      }
      if (offerDoc.offerType === "product") {
        const product = await Product.findOne({ _id: offerDoc.refId, isDeleted: false });
        computedRedirectType = "product";
        computedRedirectValue = product ? product.productName : "";
      } else if (offerDoc.offerType === "category") {
        computedRedirectType = "category";
        computedRedirectValue = offerDoc.refId.toString();
      }
    }

    banner.type             = type;
    banner.title            = title?.trim() || "";
    banner.subtitle         = subtitle?.trim() || "";
    banner.badgeText        = badgeText?.trim() || "";
    banner.offerText        = offerText?.trim() || "";
    banner.countdownEnabled = isCountdownOn;
    banner.countdownEndDate = isCountdownOn ? new Date(countdownEndDate) : null;
    banner.status           = status || "active";
    banner.offerId          = offerId && offerId.trim() !== "" ? offerId : null;
    banner.redirectType     = computedRedirectType;
    banner.redirectValue    = computedRedirectValue;

    await banner.save();
    res.json({ success: true, message: "Banner updated successfully.", banner });
  } catch (err) {
    console.error(err);
    if (req.file) deleteImage(req.file.path || req.file.filename);
    res.status(500).json({ success: false, message: "Failed to update banner." });
  }
};

export const toggleBanner = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/))
      return res.status(400).json({ success: false, message: "Invalid banner ID." });

    const banner = await Banner.findOne({ _id: req.params.id, isDeleted: false });
    if (!banner) return res.status(404).json({ success: false, message: "Banner not found." });

    banner.status = banner.status === "active" ? "inactive" : "active";
    await banner.save();

    const statusMessage = banner.status === "active" ? "activated" : "deactivated";
    res.json({ success: true, message: `Banner ${statusMessage} successfully.`, status: banner.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to toggle banner." });
  }
};

export const deleteBanner = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/))
      return res.status(400).json({ success: false, message: "Invalid banner ID." });

    const banner = await Banner.findOne({ _id: req.params.id, isDeleted: false });
    if (!banner) return res.status(404).json({ success: false, message: "Banner not found." });

    banner.isDeleted = true;
    banner.status    = "inactive";
    await banner.save();

    res.json({ success: true, message: "Banner deleted successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to delete banner." });
  }
};